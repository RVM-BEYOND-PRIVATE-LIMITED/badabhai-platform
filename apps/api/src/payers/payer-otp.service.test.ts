import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { HttpStatus } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import { OtpSendCapExceededException } from "../common/otp-send-cap";
import { PayerOtpService } from "./payer-otp.service";
import type { PayerLoginChannel } from "./payer-login-channel";

const EMAIL_HASH = "ehash_abc";
const EMAIL = "boss@acme.com";

const config = {
  NODE_ENV: "test",
  OTP_LENGTH: 6,
  OTP_TTL_SECONDS: 300,
  OTP_MAX_ATTEMPTS: 5,
  OTP_RESEND_COOLDOWN_SECONDS: 30,
  OTP_MAX_SENDS_PER_HOUR: 5,
  // The payer email channel is REAL-ONLY (zeptomail/smtp; no "none"/mock), so
  // isRealPayerEmailActive is always true and the global daily breaker ALWAYS enforces.
  // Default a HIGH global cap so the breaker never trips for the issue/verify suites (each
  // test gets a fresh Redis store → the global counter resets per test). The breaker tests
  // set a LOW cap explicitly.
  PAYER_OTP_GLOBAL_MAX_SENDS_PER_DAY: 2000,
  EMAIL_PROVIDER: "zeptomail",
} as unknown as ServerConfig;

/** Pull the plaintext code the service handed to the (mocked) channel for delivery. The
 * code is NEVER returned by issueAndSend anymore (real-only, no echo). */
function deliveredCode(channel: PayerLoginChannel): string {
  const deliver = channel.deliver as ReturnType<typeof vi.fn>;
  const arg = deliver.mock.calls[0]?.[0] as { code?: string } | undefined;
  return arg?.code ?? "";
}

// Length-stable keyed-HMAC stub that does NOT echo the input — so we can prove the
// plaintext code is never the value stored in Redis.
const pii = {
  hmac: (value: string) => `hmac<${value}>`,
} as unknown as PiiCryptoService;

function makeRedis(throwOn?: string) {
  const store = new Map<string, string>();
  const guard = (cmd: string) => {
    if (throwOn === cmd) throw new Error(`redis ${cmd} failed`);
  };
  return {
    store,
    client: {
      async set(key: string, value: string, _mode: string, _sec: number) {
        guard("set");
        store.set(key, value);
        return "OK";
      },
      async get(key: string) {
        guard("get");
        return store.get(key) ?? null;
      },
      async del(...keys: string[]) {
        guard("del");
        let n = 0;
        for (const k of keys) if (store.delete(k)) n += 1;
        return n;
      },
      async incr(key: string) {
        guard("incr");
        const next = Number(store.get(key) ?? "0") + 1;
        store.set(key, String(next));
        return next;
      },
      async expire(_key: string) {
        guard("expire");
        return 1;
      },
      async exists(key: string) {
        guard("exists");
        return store.has(key) ? 1 : 0;
      },
    },
  };
}

function setup(opts: { throwOn?: string; deliverThrows?: boolean; mock?: boolean } = {}) {
  const redis = makeRedis(opts.throwOn);
  const queue = { client: Promise.resolve(redis.client) } as unknown as Queue;
  const channel: PayerLoginChannel = {
    method: "email_otp",
    mock: opts.mock ?? true,
    deliver: opts.deliverThrows
      ? vi.fn().mockRejectedValue(new Error("delivery down"))
      : vi.fn().mockResolvedValue(undefined),
  };
  const svc = new PayerOtpService(config, pii, channel, queue);
  return { svc, redis, channel };
}

const issueInput = { emailHash: EMAIL_HASH, email: EMAIL, phone: null, payerId: "p1" };

describe("PayerOtpService.issueAndSend", () => {
  it("stores the code's HMAC (never the plaintext) and delivers via the channel", async () => {
    const { svc, redis, channel } = setup();
    const out = await svc.issueAndSend(issueInput);
    expect(channel.deliver).toHaveBeenCalledTimes(1);
    // Real-only: the result carries ONLY the resend cooldown — the code is never echoed.
    expect(out).toEqual({ resendInSeconds: config.OTP_RESEND_COOLDOWN_SECONDS });
    expect(Object.keys(out)).toEqual(["resendInSeconds"]);

    const code = deliveredCode(channel); // the plaintext handed to the channel for delivery
    expect(code).toMatch(/^\d{6}$/);
    const stored = redis.store.get(`payer_otp:code:${EMAIL_HASH}`);
    expect(stored).toBe(`hmac<${code}>`); // the HMAC, NOT the plaintext code
    expect(stored).not.toBe(code);
  });

  it("NEVER echoes a code back to the caller (real-only — no devCode field on any channel)", async () => {
    const real = setup({ mock: false });
    const realOut = await real.svc.issueAndSend(issueInput);
    expect(realOut).toEqual({ resendInSeconds: config.OTP_RESEND_COOLDOWN_SECONDS });

    const dflt = setup();
    const dfltOut = await dflt.svc.issueAndSend(issueInput);
    expect(dfltOut).toEqual({ resendInSeconds: config.OTP_RESEND_COOLDOWN_SECONDS });
  });

  it("arms a resend cooldown — a second immediate issue is rejected (429)", async () => {
    const { svc } = setup();
    await svc.issueAndSend(issueInput);
    await expect(svc.issueAndSend(issueInput)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
  });

  it("a delivery failure rolls back the code (deletes it) and surfaces 502", async () => {
    const { svc, redis } = setup({ deliverThrows: true });
    await expect(svc.issueAndSend(issueInput)).rejects.toMatchObject({
      status: HttpStatus.BAD_GATEWAY,
    });
    expect(redis.store.get(`payer_otp:code:${EMAIL_HASH}`)).toBeUndefined(); // no dangling code
  });

  it("FAILS CLOSED (503) on a Redis error rather than issuing", async () => {
    const { svc } = setup({ throwOn: "exists" });
    await expect(svc.issueAndSend(issueInput)).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
    });
  });
});

describe("PayerOtpService.issueWithoutDelivery (no-enumeration timing parity)", () => {
  it("reserves a code WITHOUT calling the channel (no delivery for an unknown account)", async () => {
    const { svc, redis, channel } = setup();
    const out = await svc.issueWithoutDelivery(EMAIL_HASH);
    expect(channel.deliver).not.toHaveBeenCalled();
    // Real-only: the result carries ONLY the resend cooldown (the reserved code is never echoed).
    expect(out).toEqual({ resendInSeconds: config.OTP_RESEND_COOLDOWN_SECONDS });
    // The reserve path still stores a code HMAC + arms the cooldown — identical observable
    // Redis state to issueAndSend, so timing/429 behavior matches a known account. The code
    // is unknown to the caller, so assert the stored value is an HMAC envelope (never raw).
    const stored = redis.store.get(`payer_otp:code:${EMAIL_HASH}`);
    expect(stored).toMatch(/^hmac<\d{6}>$/);
    expect(redis.store.has(`payer_otp:cooldown:${EMAIL_HASH}`)).toBe(true);
  });
});

describe("PayerOtpService global daily send circuit-breaker (OTP-5 spend ceiling — always enforces)", () => {
  // The email channel is real-only, so the breaker ALWAYS enforces; realConfig == config.
  const realConfig = { ...config } as unknown as ServerConfig;
  const globalKeyToday = (): string => {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, "0");
    const d = String(now.getUTCDate()).padStart(2, "0");
    return `payer_otp:global_sendcount:${y}${m}${d}`;
  };

  function realSetup(over: Partial<ServerConfig> = {}) {
    const redis = makeRedis();
    const queue = { client: Promise.resolve(redis.client) } as unknown as Queue;
    const channel: PayerLoginChannel = {
      method: "email_otp",
      mock: false, // a REAL channel — informational only; the breaker gates on config, not this
      deliver: vi.fn().mockResolvedValue(undefined),
    };
    const svc = new PayerOtpService({ ...realConfig, ...over } as ServerConfig, pii, channel, queue);
    return { svc, redis, channel };
  }

  it("blocks the REAL send (issueAndSend) once the global daily count reaches the cap", async () => {
    const { svc, redis, channel } = realSetup({ PAYER_OTP_GLOBAL_MAX_SENDS_PER_DAY: 3 } as Partial<ServerConfig>);
    redis.store.set(globalKeyToday(), "2"); // next INCR → 3 == cap
    const err = await svc.issueAndSend(issueInput).catch((e) => e);
    expect(err).toBeInstanceOf(OtpSendCapExceededException);
    expect(err.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(err.breach).toEqual({ channel: "payer_email", limit: 3, window: expect.any(String) });
    expect(channel.deliver).not.toHaveBeenCalled(); // real send refused
    expect(redis.store.has(`payer_otp:code:${EMAIL_HASH}`)).toBe(false); // code rolled back
  });

  it("ALSO blocks the unknown-account reserve (issueWithoutDelivery) at the SAME cap — parity", async () => {
    const { svc, redis } = realSetup({ PAYER_OTP_GLOBAL_MAX_SENDS_PER_DAY: 3 } as Partial<ServerConfig>);
    redis.store.set(globalKeyToday(), "2");
    const err = await svc.issueWithoutDelivery(EMAIL_HASH).catch((e) => e);
    // The breaker lives in the existence-INDEPENDENT reserve path, so an unknown account
    // hits the IDENTICAL breach (same exception/status) — no enumeration oracle.
    expect(err).toBeInstanceOf(OtpSendCapExceededException);
    expect(err.breach.channel).toBe("payer_email");
  });

  it("cap=0 (kill-switch) blocks the VERY FIRST real send", async () => {
    const { svc, channel } = realSetup({ PAYER_OTP_GLOBAL_MAX_SENDS_PER_DAY: 0 } as Partial<ServerConfig>);
    const err = await svc.issueAndSend(issueInput).catch((e) => e);
    expect(err).toBeInstanceOf(OtpSendCapExceededException);
    expect(err.breach.limit).toBe(0);
    expect(channel.deliver).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED (does not uncap) when the global counter INCR errors", async () => {
    const redis = makeRedis("incr");
    const queue = { client: Promise.resolve(redis.client) } as unknown as Queue;
    const channel: PayerLoginChannel = {
      method: "email_otp",
      mock: false,
      deliver: vi.fn().mockResolvedValue(undefined),
    };
    const svc = new PayerOtpService(realConfig, pii, channel, queue);
    await expect(svc.issueAndSend(issueInput)).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
    });
    expect(channel.deliver).not.toHaveBeenCalled();
  });

  it("breach metadata is aggregate-only (channel/limit/window) — no email/code/id", async () => {
    const { svc } = realSetup({ PAYER_OTP_GLOBAL_MAX_SENDS_PER_DAY: 0 } as Partial<ServerConfig>);
    const err = (await svc.issueAndSend(issueInput).catch((e) => e)) as OtpSendCapExceededException;
    expect(Object.keys(err.breach).sort()).toEqual(["channel", "limit", "window"].sort());
    const serialized = JSON.stringify(err.breach);
    expect(serialized).not.toContain(EMAIL);
    expect(serialized).not.toContain(EMAIL_HASH);
    expect(err.breach.window).toMatch(/^\d{8}$/);
  });
});

describe("PayerOtpService.verify", () => {
  it("verifies a correct code, then is single-use (a replay is rejected)", async () => {
    const { svc, channel } = setup();
    await svc.issueAndSend(issueInput);
    const code = deliveredCode(channel); // captured from the (mocked) channel, not the result
    await expect(svc.verify(EMAIL_HASH, code)).resolves.toBeUndefined();
    // single-use: the code was deleted on success → a replay now fails
    await expect(svc.verify(EMAIL_HASH, code)).rejects.toMatchObject({
      status: HttpStatus.UNAUTHORIZED,
    });
  });

  it("returns the SAME message for a wrong code and for no-code-on-file (no enumeration)", async () => {
    const wrong = setup();
    await wrong.svc.issueAndSend(issueInput);
    const wrongErr = await wrong.svc.verify(EMAIL_HASH, "000000").catch((e) => e);

    const none = setup();
    const noneErr = await none.svc.verify(EMAIL_HASH, "000000").catch((e) => e);

    expect(wrongErr.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    expect(noneErr.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    expect(wrongErr.message).toBe(noneErr.message); // identical → no account/code oracle
  });

  it("FAILS CLOSED (503) on a Redis error", async () => {
    const { svc } = setup({ throwOn: "get" });
    await expect(svc.verify(EMAIL_HASH, "123456")).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
    });
  });
});
