import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { HttpStatus } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import type { PiiCryptoService } from "../common/pii-crypto.service";
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
} as unknown as ServerConfig;

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
    expect(out.devCode).toMatch(/^\d{6}$/); // dev/test + mock echo

    const stored = redis.store.get(`payer_otp:code:${EMAIL_HASH}`);
    expect(stored).toBe(`hmac<${out.devCode}>`); // the HMAC, NOT the plaintext code
    expect(stored).not.toBe(out.devCode);
  });

  it("does NOT echo a code on a REAL (non-mock) channel even in test env", async () => {
    const { svc } = setup({ mock: false });
    const out = await svc.issueAndSend(issueInput);
    expect(out.devCode).toBeUndefined();
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
    expect(out.devCode).toMatch(/^\d{6}$/);
    // The reserve path still stores a code HMAC + arms the cooldown — identical observable
    // Redis state to issueAndSend, so timing/429 behavior matches a known account.
    expect(redis.store.get(`payer_otp:code:${EMAIL_HASH}`)).toBe(`hmac<${out.devCode}>`);
    expect(redis.store.has(`payer_otp:cooldown:${EMAIL_HASH}`)).toBe(true);
  });
});

describe("PayerOtpService.verify", () => {
  it("verifies a correct code, then is single-use (a replay is rejected)", async () => {
    const { svc } = setup();
    const { devCode } = await svc.issueAndSend(issueInput);
    await expect(svc.verify(EMAIL_HASH, devCode!)).resolves.toBeUndefined();
    // single-use: the code was deleted on success → a replay now fails
    await expect(svc.verify(EMAIL_HASH, devCode!)).rejects.toMatchObject({
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
