import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { HttpStatus } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import {
  OtpSendCapExceededException,
  PayerSmsSendCapExceededException,
} from "../common/otp-send-cap";
import { PayerOtpService } from "./payer-otp.service";
import type { PayerLoginChannel, SmsLoginChannel } from "./payer-login-channel";

/** #2754 — the SMS channel a phone route delivers through; a stub that records its calls. */
function smsStub(): SmsLoginChannel {
  return {
    method: "sms_otp",
    mock: false,
    deliver: vi.fn().mockResolvedValue(undefined),
  } as unknown as SmsLoginChannel;
}

const EMAIL_HASH = "ehash_abc";
const EMAIL = "boss@acme.com";

const config = {
  NODE_ENV: "test",
  OTP_LENGTH: 6,
  OTP_TTL_SECONDS: 300,
  OTP_MAX_ATTEMPTS: 500,
  OTP_RESEND_COOLDOWN_SECONDS: 30,
  OTP_MAX_SENDS_PER_HOUR: 500,
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
  const sms = smsStub();
  const svc = new PayerOtpService(config, pii, channel, queue, sms);
  return { svc, redis, channel, sms };
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
    const svc = new PayerOtpService(
      { ...realConfig, ...over } as ServerConfig,
      pii,
      channel,
      queue,
      smsStub(),
    );
    return { svc, redis, channel };
  }

  it("blocks the REAL send (issueAndSend) once the global daily count reaches the cap", async () => {
    const { svc, redis, channel } = realSetup({
      PAYER_OTP_GLOBAL_MAX_SENDS_PER_DAY: 3,
    } as Partial<ServerConfig>);
    redis.store.set(globalKeyToday(), "2"); // next INCR → 3 == cap
    const err = await svc.issueAndSend(issueInput).catch((e) => e);
    expect(err).toBeInstanceOf(OtpSendCapExceededException);
    expect(err.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(err.breach).toEqual({ channel: "payer_email", limit: 3, window: expect.any(String) });
    expect(channel.deliver).not.toHaveBeenCalled(); // real send refused
    expect(redis.store.has(`payer_otp:code:${EMAIL_HASH}`)).toBe(false); // code rolled back
  });

  it("ALSO blocks the unknown-account reserve (issueWithoutDelivery) at the SAME cap — parity", async () => {
    const { svc, redis } = realSetup({
      PAYER_OTP_GLOBAL_MAX_SENDS_PER_DAY: 3,
    } as Partial<ServerConfig>);
    redis.store.set(globalKeyToday(), "2");
    const err = await svc.issueWithoutDelivery(EMAIL_HASH).catch((e) => e);
    // The breaker lives in the existence-INDEPENDENT reserve path, so an unknown account
    // hits the IDENTICAL breach (same exception/status) — no enumeration oracle.
    expect(err).toBeInstanceOf(OtpSendCapExceededException);
    expect(err.breach.channel).toBe("payer_email");
  });

  it("cap=0 (kill-switch) blocks the VERY FIRST real send", async () => {
    const { svc, channel } = realSetup({
      PAYER_OTP_GLOBAL_MAX_SENDS_PER_DAY: 0,
    } as Partial<ServerConfig>);
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
    const svc = new PayerOtpService(realConfig, pii, channel, queue, smsStub());
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

describe("#2754 — a company phone's code goes by SMS, under its own daily ceiling", () => {
  const PHONE_HASH = "f".repeat(64);
  const phoneInput = { emailHash: PHONE_HASH, email: "", phone: "+919876543210", payerId: "p2" };
  const today = (): string => new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const smsKey = (): string => `payer_otp:global_sms_sendcount:${today()}`;
  const emailKey = (): string => `payer_otp:global_sendcount:${today()}`;

  function smsSetup(over: Partial<ServerConfig> = {}) {
    const redis = makeRedis();
    const queue = { client: Promise.resolve(redis.client) } as unknown as Queue;
    const channel: PayerLoginChannel = {
      method: "email_otp",
      mock: false,
      deliver: vi.fn().mockResolvedValue(undefined),
    };
    const sms = smsStub();
    const svc = new PayerOtpService(
      { ...config, PAYER_SMS_OTP_GLOBAL_MAX_SENDS_PER_DAY: 500, ...over } as ServerConfig,
      pii,
      channel,
      queue,
      sms,
    );
    return { svc, redis, channel, sms };
  }

  it("delivers the code through the SMS channel, never the email one, and counts only the SMS ceiling", async () => {
    const { svc, redis, channel, sms } = smsSetup();
    await svc.issueAndSend({ ...phoneInput, route: "sms" });
    expect(sms.deliver).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sms.deliver).mock.calls[0]![0]).toMatchObject({
      phone: "+919876543210",
      payerId: "p2",
    });
    expect(channel.deliver).not.toHaveBeenCalled();
    expect(redis.store.get(smsKey())).toBe("1");
    expect(redis.store.has(emailKey())).toBe(false);
    // The code is stored under the phone's keyed hash, so verify reads the same key.
    expect(redis.store.has(`payer_otp:code:${PHONE_HASH}`)).toBe(true);
  });

  it("the default route is unchanged: the configured channel and the email ceiling", async () => {
    const { svc, redis, channel, sms } = smsSetup();
    await svc.issueAndSend(issueInput);
    expect(channel.deliver).toHaveBeenCalledTimes(1);
    expect(sms.deliver).not.toHaveBeenCalled();
    expect(redis.store.get(emailKey())).toBe("1");
    expect(redis.store.has(smsKey())).toBe(false);
  });

  it("an unknown phone (issueWithoutDelivery on the SMS route) counts the same SMS ceiling, sending nothing", async () => {
    const { svc, redis, sms } = smsSetup();
    await svc.issueWithoutDelivery(PHONE_HASH, "sms");
    expect(sms.deliver).not.toHaveBeenCalled();
    expect(redis.store.get(smsKey())).toBe("1");
    expect(redis.store.has(emailKey())).toBe(false);
  });

  it("at the ceiling it refuses with the neutral 429, as its own exception, and leaves no code behind", async () => {
    const { svc, redis, sms } = smsSetup({ PAYER_SMS_OTP_GLOBAL_MAX_SENDS_PER_DAY: 2 });
    await svc.issueAndSend({ ...phoneInput, route: "sms" });
    redis.store.delete(`payer_otp:cooldown:${PHONE_HASH}`);
    const err = await svc.issueAndSend({ ...phoneInput, route: "sms" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayerSmsSendCapExceededException);
    expect(err).not.toBeInstanceOf(OtpSendCapExceededException);
    expect(err).toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
    expect((err as PayerSmsSendCapExceededException).breach).toEqual({ limit: 2, window: today() });
    expect(sms.deliver).toHaveBeenCalledTimes(1);
    expect(redis.store.has(`payer_otp:code:${PHONE_HASH}`)).toBe(false);
  });

  it("a ceiling of 0 pauses company SMS at once (the kill-switch), unknown phones included", async () => {
    const { svc, sms } = smsSetup({ PAYER_SMS_OTP_GLOBAL_MAX_SENDS_PER_DAY: 0 });
    await expect(svc.issueAndSend({ ...phoneInput, route: "sms" })).rejects.toBeInstanceOf(
      PayerSmsSendCapExceededException,
    );
    await expect(svc.issueWithoutDelivery("e".repeat(64), "sms")).rejects.toBeInstanceOf(
      PayerSmsSendCapExceededException,
    );
    expect(sms.deliver).not.toHaveBeenCalled();
  });
});

describe("#2754 — the SMS ceiling fails closed", () => {
  it("a Redis error on the company-SMS counter is a 503 and sends nothing (never uncaps)", async () => {
    const redis = makeRedis();
    // Fail ONLY the company-SMS daily counter, so the per-number checks before it all pass.
    const incr = redis.client.incr.bind(redis.client);
    redis.client.incr = async (key: string) => {
      if (key.startsWith("payer_otp:global_sms_sendcount:")) throw new Error("redis down");
      return incr(key);
    };
    const queue = { client: Promise.resolve(redis.client) } as unknown as Queue;
    const channel: PayerLoginChannel = {
      method: "email_otp",
      mock: false,
      deliver: vi.fn().mockResolvedValue(undefined),
    };
    const sms = smsStub();
    const svc = new PayerOtpService(config, pii, channel, queue, sms);
    await expect(
      svc.issueAndSend({
        emailHash: "f".repeat(64),
        email: "",
        phone: "+919876543210",
        payerId: "p2",
        route: "sms",
      }),
    ).rejects.toMatchObject({ status: HttpStatus.SERVICE_UNAVAILABLE });
    expect(sms.deliver).not.toHaveBeenCalled();
  });
});

describe("#2754 item 3 — a PHONE-PROOF code: its own slot, the SMS bounds, never a sign-in code", () => {
  const PAYER = "aaaaaaaa-0000-4000-8000-000000000001";
  const OTHER = "bbbbbbbb-0000-4000-8000-000000000002";
  const PHONE = "+919876543210";
  const PHONE_HASH = "e".repeat(64);
  const today = (): string => new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const smsKey = (): string => `payer_otp:global_sms_sendcount:${today()}`;

  function proofSetup(over: Partial<ServerConfig> = {}) {
    const redis = makeRedis();
    const queue = { client: Promise.resolve(redis.client) } as unknown as Queue;
    const channel: PayerLoginChannel = {
      method: "email_otp",
      mock: false,
      deliver: vi.fn().mockResolvedValue(undefined),
    };
    const sms = smsStub();
    const svc = new PayerOtpService(
      { ...config, PAYER_SMS_OTP_GLOBAL_MAX_SENDS_PER_DAY: 500, ...over } as ServerConfig,
      pii,
      channel,
      queue,
      sms,
    );
    return { svc, redis, channel, sms };
  }
  const smsCode = (sms: SmsLoginChannel, call = 0): string =>
    (vi.mocked(sms.deliver).mock.calls[call]?.[0] as { code: string }).code;

  it("sends by SMS to the given phone, keyed by the ACCOUNT, bound to the phone hash, counting the SMS ceiling", async () => {
    const { svc, redis, channel, sms } = proofSetup();
    const res = await svc.issuePhoneProof({ payerId: PAYER, phoneHash: PHONE_HASH, phone: PHONE });
    expect(res).toEqual({ resendInSeconds: 30 });
    expect(sms.deliver).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sms.deliver).mock.calls[0]![0]).toMatchObject({
      phone: PHONE,
      payerId: PAYER,
    });
    expect(channel.deliver).not.toHaveBeenCalled();
    const code = smsCode(sms);
    // Its own namespace — never the sign-in key of that phone.
    expect(redis.store.get(`payer_otp:phone_proof:code:${PAYER}`)).toBe(
      `hmac<phone_proof:${PHONE_HASH}:${code}>`,
    );
    expect(redis.store.has(`payer_otp:code:${PHONE_HASH}`)).toBe(false);
    // The company-SMS ceiling counts it.
    expect(redis.store.get(smsKey())).toBe("1");
  });

  it("verifies its own code once (single-use), then refuses a replay", async () => {
    const { svc, sms } = proofSetup();
    await svc.issuePhoneProof({ payerId: PAYER, phoneHash: PHONE_HASH, phone: PHONE });
    const code = smsCode(sms);
    await expect(
      svc.verifyPhoneProof({ payerId: PAYER, phoneHash: PHONE_HASH, code }),
    ).resolves.toBeUndefined();
    await expect(
      svc.verifyPhoneProof({ payerId: PAYER, phoneHash: PHONE_HASH, code }),
    ).rejects.toMatchObject({ status: HttpStatus.UNAUTHORIZED });
  });

  it("PURPOSES DON'T CROSS: a proof code is not a sign-in code for that phone", async () => {
    const { svc, sms } = proofSetup();
    await svc.issuePhoneProof({ payerId: PAYER, phoneHash: PHONE_HASH, phone: PHONE });
    await expect(svc.verify(PHONE_HASH, smsCode(sms))).rejects.toMatchObject({
      status: HttpStatus.UNAUTHORIZED,
    });
  });

  it("PURPOSES DON'T CROSS: a sign-in code for that phone is not a proof code", async () => {
    const { svc, sms } = proofSetup();
    await svc.issueAndSend({
      emailHash: PHONE_HASH,
      email: "",
      phone: PHONE,
      payerId: PAYER,
      route: "sms",
    });
    await expect(
      svc.verifyPhoneProof({ payerId: PAYER, phoneHash: PHONE_HASH, code: smsCode(sms) }),
    ).rejects.toMatchObject({ status: HttpStatus.UNAUTHORIZED });
    // …and the sign-in code is untouched by the failed proof attempt: it still signs in.
    await expect(svc.verify(PHONE_HASH, smsCode(sms))).resolves.toBeUndefined();
  });

  it("a code sent before a PHONE CHANGE is void after it (bound to the old hash)", async () => {
    const { svc, sms } = proofSetup();
    await svc.issuePhoneProof({ payerId: PAYER, phoneHash: PHONE_HASH, phone: PHONE });
    await expect(
      svc.verifyPhoneProof({ payerId: PAYER, phoneHash: "d".repeat(64), code: smsCode(sms) }),
    ).rejects.toMatchObject({ status: HttpStatus.UNAUTHORIZED });
  });

  it("another account cannot verify this account's proof code (keyed by the account)", async () => {
    const { svc, sms } = proofSetup();
    await svc.issuePhoneProof({ payerId: PAYER, phoneHash: PHONE_HASH, phone: PHONE });
    await expect(
      svc.verifyPhoneProof({ payerId: OTHER, phoneHash: PHONE_HASH, code: smsCode(sms) }),
    ).rejects.toMatchObject({ status: HttpStatus.UNAUTHORIZED });
  });

  it("has its own resend cooldown (a second immediate send is a 429)", async () => {
    const { svc, sms } = proofSetup();
    await svc.issuePhoneProof({ payerId: PAYER, phoneHash: PHONE_HASH, phone: PHONE });
    await expect(
      svc.issuePhoneProof({ payerId: PAYER, phoneHash: PHONE_HASH, phone: PHONE }),
    ).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
    expect(sms.deliver).toHaveBeenCalledTimes(1);
  });

  it("SHARES the per-number hourly cap with sign-in codes to the same phone", async () => {
    const { svc, sms } = proofSetup({ OTP_MAX_SENDS_PER_HOUR: 1 } as Partial<ServerConfig>);
    await svc.issueAndSend({
      emailHash: PHONE_HASH,
      email: "",
      phone: PHONE,
      payerId: PAYER,
      route: "sms",
    });
    await expect(
      svc.issuePhoneProof({ payerId: PAYER, phoneHash: PHONE_HASH, phone: PHONE }),
    ).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
    expect(sms.deliver).toHaveBeenCalledTimes(1);
  });

  it("at the company-SMS ceiling it refuses with its own exception and leaves no code behind", async () => {
    const { svc, redis, sms } = proofSetup({
      PAYER_SMS_OTP_GLOBAL_MAX_SENDS_PER_DAY: 0,
    } as Partial<ServerConfig>);
    await expect(
      svc.issuePhoneProof({ payerId: PAYER, phoneHash: PHONE_HASH, phone: PHONE }),
    ).rejects.toBeInstanceOf(PayerSmsSendCapExceededException);
    expect(sms.deliver).not.toHaveBeenCalled();
    expect(redis.store.has(`payer_otp:phone_proof:code:${PAYER}`)).toBe(false);
    expect(redis.store.has(`payer_otp:phone_proof:cooldown:${PAYER}`)).toBe(false);
  });

  it("a delivery failure rolls the code back and is a 502 (the caller's own account: no oracle)", async () => {
    const { svc, redis, sms } = proofSetup();
    vi.mocked(sms.deliver).mockRejectedValueOnce(new Error("provider down"));
    await expect(
      svc.issuePhoneProof({ payerId: PAYER, phoneHash: PHONE_HASH, phone: PHONE }),
    ).rejects.toMatchObject({ status: HttpStatus.BAD_GATEWAY });
    expect(redis.store.has(`payer_otp:phone_proof:code:${PAYER}`)).toBe(false);
  });

  it("FAILS CLOSED (503) on a Redis error, sending nothing", async () => {
    const redis = makeRedis("exists");
    const queue = { client: Promise.resolve(redis.client) } as unknown as Queue;
    const sms = smsStub();
    const svc = new PayerOtpService(
      config,
      pii,
      { method: "email_otp", mock: false, deliver: vi.fn() },
      queue,
      sms,
    );
    await expect(
      svc.issuePhoneProof({ payerId: PAYER, phoneHash: PHONE_HASH, phone: PHONE }),
    ).rejects.toMatchObject({ status: HttpStatus.SERVICE_UNAVAILABLE });
    expect(sms.deliver).not.toHaveBeenCalled();
  });

  it("a sign-in code issued before this change (the raw-code HMAC, the old keys) still verifies", async () => {
    const { svc, redis } = proofSetup();
    redis.store.set(`payer_otp:code:${EMAIL_HASH}`, "hmac<123456>");
    await expect(svc.verify(EMAIL_HASH, "123456")).resolves.toBeUndefined();
  });
});
