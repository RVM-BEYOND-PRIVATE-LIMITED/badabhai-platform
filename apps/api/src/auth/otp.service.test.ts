import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { HttpException, HttpStatus } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import { OtpSendCapExceededException } from "../common/otp-send-cap";
import type { SmsProvider } from "../sms/sms.provider";
import { OtpService } from "./otp.service";

const PHONE = "+919876543210";

const config = {
  OTP_LENGTH: 6,
  OTP_TTL_SECONDS: 300,
  OTP_MAX_ATTEMPTS: 5,
  OTP_RESEND_COOLDOWN_SECONDS: 30,
  OTP_MAX_SENDS_PER_HOUR: 5,
  // Worker OTP is REAL-ONLY (fast2sms; no console fallback), so isRealOtpSmsActive is always
  // true and the global daily breaker ALWAYS enforces. Default a HIGH global cap so the
  // breaker never trips for the throttle/verify suites (each test gets a fresh Redis store,
  // so the global counter resets per test). The breaker tests set a LOW cap explicitly.
  OTP_GLOBAL_MAX_SENDS_PER_DAY: 2000,
  SMS_PROVIDER: "fast2sms",
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

  it("returns ONLY { resendInSeconds } — the code is never echoed back (real-only, no dev seam)", async () => {
    // Real-only: the code is delivered ONLY to the phone via Fast2SMS; the result carries
    // the resend cooldown and nothing else (no devCode field exists anymore).
    const { svc } = setup();
    const res = await svc.issueAndSend(PHONE);
    expect(res).toEqual({ resendInSeconds: config.OTP_RESEND_COOLDOWN_SECONDS });
    expect(Object.keys(res)).toEqual(["resendInSeconds"]);
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

describe("OtpService global daily send circuit-breaker (OTP-5 spend ceiling — always enforces)", () => {
  // Worker OTP is real-only (fast2sms), so the breaker ALWAYS enforces; realConfig == config.
  const realConfig = { ...config } as unknown as ServerConfig;
  const globalKeyToday = (): string => {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, "0");
    const d = String(now.getUTCDate()).padStart(2, "0");
    return `otp:global_sendcount:${y}${m}${d}`;
  };

  function realSetup(over: Partial<ServerConfig> = {}, opts: { sendThrows?: boolean } = {}) {
    const redis = makeRedis();
    const queue = { client: Promise.resolve(redis.client) } as unknown as Queue;
    const sms: SmsProvider = {
      sendOtp: opts.sendThrows
        ? vi.fn().mockRejectedValue(new Error("gateway down"))
        : vi.fn().mockResolvedValue(undefined),
    };
    const svc = new OtpService({ ...realConfig, ...over } as ServerConfig, pii, sms, queue);
    return { svc, redis, sms };
  }

  it("blocks the REAL send once the global daily count reaches the cap (neutral 429, no send)", async () => {
    const { svc, redis, sms } = realSetup({ OTP_GLOBAL_MAX_SENDS_PER_DAY: 3 } as Partial<ServerConfig>);
    // Pre-seed the counter at cap-1 so the next send's INCR reaches the cap.
    redis.store.set(globalKeyToday(), "2");
    redis.store.delete(`otp:cooldown:${phoneHash}`);
    const err = await svc.issueAndSend(PHONE).catch((e) => e);
    expect(err).toBeInstanceOf(OtpSendCapExceededException);
    expect(err.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(err.breach).toEqual({ channel: "worker_sms", limit: 3, window: expect.any(String) });
    // The real send was REFUSED and the reserved code rolled back (no dangling code).
    expect(sms.sendOtp).not.toHaveBeenCalled();
    expect(redis.store.has(codeKey)).toBe(false);
  });

  it("cap=0 (kill-switch) blocks the VERY FIRST real send", async () => {
    const { svc, sms } = realSetup({ OTP_GLOBAL_MAX_SENDS_PER_DAY: 0 } as Partial<ServerConfig>);
    const err = await svc.issueAndSend(PHONE).catch((e) => e);
    expect(err).toBeInstanceOf(OtpSendCapExceededException);
    expect(err.breach.limit).toBe(0);
    expect(sms.sendOtp).not.toHaveBeenCalled();
  });

  it("allows the real send while under the cap and increments the global counter", async () => {
    const { svc, redis, sms } = realSetup({ OTP_GLOBAL_MAX_SENDS_PER_DAY: 5 } as Partial<ServerConfig>);
    await expect(svc.issueAndSend(PHONE)).resolves.toBeDefined();
    expect(sms.sendOtp).toHaveBeenCalledTimes(1);
    expect(redis.store.get(globalKeyToday())).toBe("1");
  });

  it("FAILS CLOSED (does not uncap) when the global counter INCR errors on the real path", async () => {
    const redis = makeRedis("incr");
    const queue = { client: Promise.resolve(redis.client) } as unknown as Queue;
    const sms: SmsProvider = { sendOtp: vi.fn().mockResolvedValue(undefined) };
    const svc = new OtpService(realConfig, pii, sms, queue);
    await expect(svc.issueAndSend(PHONE)).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE, // fail closed → never the real send
    });
    expect(sms.sendOtp).not.toHaveBeenCalled();
  });

  it("breach metadata carries NO phone/code — aggregate only (channel/limit/window)", async () => {
    const { svc } = realSetup({ OTP_GLOBAL_MAX_SENDS_PER_DAY: 0 } as Partial<ServerConfig>);
    const err = (await svc.issueAndSend(PHONE).catch((e) => e)) as OtpSendCapExceededException;
    // Aggregate shape ONLY: the channel kind, the cap limit, and the UTC-day window. NO
    // phone, no code, no id (the `window` is a non-PII calendar-day stamp by design).
    expect(Object.keys(err.breach).sort()).toEqual(["channel", "limit", "window"].sort());
    const serialized = JSON.stringify(err.breach);
    expect(serialized).not.toContain(PHONE); // never the raw phone
    expect(serialized).not.toContain("9876543210"); // nor its national-number digits
    expect(err.breach.window).toMatch(/^\d{8}$/); // a UTC-DAY stamp, not a phone/code
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
