import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { HttpException, HttpStatus } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import type { SmsProvider } from "../sms/sms.provider";
import { OtpService } from "./otp.service";

const PHONE = "+919876543210";

const config = {
  OTP_LENGTH: 6,
  OTP_TTL_SECONDS: 300,
  OTP_MAX_ATTEMPTS: 5,
  OTP_RESEND_COOLDOWN_SECONDS: 30,
  OTP_MAX_SENDS_PER_HOUR: 5,
} as unknown as ServerConfig;

// A keyed-HMAC stub: deterministic, length-stable, and (like the real HMAC) it
// does NOT echo the input — so we can prove the plaintext code is never stored.
const pii = {
  hashPhone: (phone: string) => `phash_${phone.length}`,
  hmac: (value: string) => `hmac<${value}>`,
} as unknown as PiiCryptoService;

/**
 * In-memory Redis double covering the commands OtpService uses. Each test can
 * seed/inspect the store. `throwOn` forces a specific command to throw (outage).
 */
function makeRedis(throwOn?: string) {
  const store = new Map<string, string>();
  const calls: Array<[string, ...unknown[]]> = [];
  const guard = (cmd: string) => {
    if (throwOn === cmd) throw new Error(`redis ${cmd} failed`);
  };
  return {
    store,
    calls,
    client: {
      async set(key: string, value: string, _mode: string, _sec: number) {
        calls.push(["set", key, value]);
        guard("set");
        store.set(key, value);
        return "OK";
      },
      async get(key: string) {
        calls.push(["get", key]);
        guard("get");
        return store.get(key) ?? null;
      },
      async del(...keys: string[]) {
        calls.push(["del", ...keys]);
        guard("del");
        let n = 0;
        for (const k of keys) if (store.delete(k)) n += 1;
        return n;
      },
      async incr(key: string) {
        calls.push(["incr", key]);
        guard("incr");
        const next = Number(store.get(key) ?? "0") + 1;
        store.set(key, String(next));
        return next;
      },
      async expire(key: string, sec: number) {
        calls.push(["expire", key, sec]);
        guard("expire");
        return store.has(key) ? 1 : 0;
      },
      async exists(key: string) {
        calls.push(["exists", key]);
        guard("exists");
        return store.has(key) ? 1 : 0;
      },
    },
  };
}

function setup(opts: { throwOn?: string; sendThrows?: boolean } = {}) {
  const redis = makeRedis(opts.throwOn);
  const queue = { client: Promise.resolve(redis.client) } as unknown as Queue;
  const sms: SmsProvider = {
    sendOtp: opts.sendThrows
      ? vi.fn().mockRejectedValue(new Error("gateway down"))
      : vi.fn().mockResolvedValue(undefined),
  };
  const svc = new OtpService(config, pii, sms, queue);
  return { svc, redis, sms };
}

const phoneHash = `phash_${PHONE.length}`;
const codeKey = `otp:code:${phoneHash}`;
const attemptsKey = `otp:attempts:${phoneHash}`;
const cooldownKey = `otp:cooldown:${phoneHash}`;

describe("OtpService.issueAndSend", () => {
  it("generates a numeric code of OTP_LENGTH and sends it", async () => {
    const { svc, sms } = setup();
    const res = await svc.issueAndSend(PHONE);
    expect(res.resendInSeconds).toBe(config.OTP_RESEND_COOLDOWN_SECONDS);
    const sent = (sms.sendOtp as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { code: string };
    expect(sent.code).toMatch(/^\d{6}$/);
  });

  it("stores the HMAC of the code (via pii.hmac), never the plaintext itself", async () => {
    const { svc, redis, sms } = setup();
    await svc.issueAndSend(PHONE);
    const sent = (sms.sendOtp as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { code: string };
    const stored = redis.store.get(codeKey)!;
    // The stored value is the HMAC the service computed, NOT the raw code. (The
    // stub HMAC wraps the value for readability; the real HMAC.SHA256 hides it
    // entirely — see crypto.test.ts which proves the digest never echoes the code.)
    expect(stored).toBe(pii.hmac(sent.code));
    expect(stored).not.toBe(sent.code); // never the plaintext code
    expect(stored.startsWith("hmac<")).toBe(true); // went through pii.hmac, not stored raw
  });

  it("429s when a cooldown is already active (too-soon resend)", async () => {
    const { svc, redis } = setup();
    redis.store.set(cooldownKey, "1");
    await expect(svc.issueAndSend(PHONE)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
  });

  it("429s when the hourly send cap is exceeded", async () => {
    const { svc, redis } = setup();
    // Drive the hourly counter to the cap by issuing repeatedly (clearing the
    // cooldown between issues so only the hourly cap can trip), then expect 429.
    for (let i = 0; i < config.OTP_MAX_SENDS_PER_HOUR; i += 1) {
      redis.store.delete(cooldownKey);
      await svc.issueAndSend(PHONE);
    }
    redis.store.delete(cooldownKey);
    await expect(svc.issueAndSend(PHONE)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
  });

  it("on send failure deletes the code key and throws 502", async () => {
    const { svc, redis } = setup({ sendThrows: true });
    await expect(svc.issueAndSend(PHONE)).rejects.toMatchObject({
      status: HttpStatus.BAD_GATEWAY,
    });
    // No dangling code left behind.
    expect(redis.store.has(codeKey)).toBe(false);
  });

  it("FAILS CLOSED with 503 when Redis throws", async () => {
    const { svc } = setup({ throwOn: "exists" });
    await expect(svc.issueAndSend(PHONE)).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
    });
  });
});

describe("OtpService.verify", () => {
  async function seedCode(): Promise<{ svc: OtpService; redis: ReturnType<typeof makeRedis>; code: string }> {
    const { svc, redis, sms } = setup();
    await svc.issueAndSend(PHONE);
    const code = (sms.sendOtp as ReturnType<typeof vi.fn>).mock.calls[0]![0].code as string;
    // Clear cooldown so it doesn't interfere with verify-side keys.
    return { svc, redis, code };
  }

  it("succeeds on the correct code and deletes it (single-use)", async () => {
    const { svc, redis, code } = await seedCode();
    await expect(svc.verify(PHONE, code)).resolves.toBeUndefined();
    expect(redis.store.has(codeKey)).toBe(false);
    expect(redis.store.has(attemptsKey)).toBe(false);
    expect(redis.store.has(cooldownKey)).toBe(false);
    // A second verify with the same code now fails (code consumed).
    await expect(svc.verify(PHONE, code)).rejects.toMatchObject({
      status: HttpStatus.UNAUTHORIZED,
    });
  });

  it("401s when there is no stored code (expired/missing)", async () => {
    const { svc } = setup();
    await expect(svc.verify(PHONE, "123456")).rejects.toMatchObject({
      status: HttpStatus.UNAUTHORIZED,
    });
  });

  it("a wrong code increments attempts and 401s", async () => {
    const { svc, redis, code } = await seedCode();
    const wrong = code === "000000" ? "111111" : "000000";
    await expect(svc.verify(PHONE, wrong)).rejects.toMatchObject({
      status: HttpStatus.UNAUTHORIZED,
    });
    expect(redis.store.get(attemptsKey)).toBe("1");
    // The code is NOT consumed on a wrong attempt.
    expect(redis.store.has(codeKey)).toBe(true);
  });

  it("429s and deletes the code once max attempts are exceeded", async () => {
    const { svc, redis, code } = await seedCode();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < config.OTP_MAX_ATTEMPTS; i += 1) {
      await expect(svc.verify(PHONE, wrong)).rejects.toMatchObject({
        status: HttpStatus.UNAUTHORIZED,
      });
    }
    // The (max+1)th attempt trips the cap → 429 + code deleted.
    await expect(svc.verify(PHONE, wrong)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
    expect(redis.store.has(codeKey)).toBe(false);
    expect(redis.store.has(attemptsKey)).toBe(false);
  });

  it("FAILS CLOSED with 503 when Redis throws during verify", async () => {
    const { svc } = setup({ throwOn: "get" });
    await expect(svc.verify(PHONE, "123456")).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
    });
  });
});

describe("OtpService error semantics", () => {
  it("all thrown errors are HttpException (filterable by the exceptions filter)", async () => {
    const { svc } = setup({ throwOn: "get" });
    await svc.verify(PHONE, "123456").catch((e) => {
      expect(e).toBeInstanceOf(HttpException);
    });
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
