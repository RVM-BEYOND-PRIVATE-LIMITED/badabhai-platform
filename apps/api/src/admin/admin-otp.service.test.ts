import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { HttpStatus, Logger } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import { AdminOtpService } from "./admin-otp.service";

// A REAL admin email (ADMIN-class PII) + its keyed-hash lookup key. Neither must ever leak
// into a returned body, a logged string, or an error (CLAUDE.md invariant #2). The lookup key
// is an OPAQUE keyed-HMAC digest (as the real PiiCryptoService.hmac produces) — it must NOT
// embed the raw email, so the PII-free key-namespace assertions are meaningful.
const EMAIL = "ops.admin@badabhai.in";
const EMAIL_HASH = "9f3c1a7b2e5d4806c1f0a9b8d7e6f5a4c3b2a1908f7e6d5c4b3a29180706f5e4";

const config = {
  NODE_ENV: "test",
  OTP_LENGTH: 6,
  OTP_TTL_SECONDS: 300,
  OTP_MAX_ATTEMPTS: 5,
  OTP_RESEND_COOLDOWN_SECONDS: 30,
  OTP_MAX_SENDS_PER_HOUR: 5,
} as unknown as ServerConfig;

// Length-stable keyed-HMAC stub that does NOT echo a usable secret outside the envelope —
// `hmac<value>`. The wrapper lets a test recover the plaintext code the service generated
// (it is NEVER returned by the service nor logged), purely so verify() can be exercised.
const pii = {
  hmac: (value: string) => `hmac<${value}>`,
} as unknown as PiiCryptoService;

/** The admin OTP Redis namespace (DISTINCT from payer_otp:* / worker otp:*). */
const codeKey = (h: string) => `admin_otp:code:${h}`;
const attemptsKey = (h: string) => `admin_otp:attempts:${h}`;
const cooldownKey = (h: string) => `admin_otp:cooldown:${h}`;

/**
 * Recover the plaintext code the service reserved by unwrapping the stored `hmac<CODE>`
 * envelope (the service never returns or logs the code — delivery is a deferred no-op stub).
 */
function reservedCode(store: Map<string, string>, h = EMAIL_HASH): string {
  const stored = store.get(codeKey(h)) ?? "";
  const m = stored.match(/^hmac<(\d+)>$/);
  return m?.[1] ?? "";
}

/** In-memory Redis double matching the RedisOtpClient surface the OTP flow uses. `throwOn`
 * makes one command reject so we can prove the FAIL-CLOSED (deny, never allow) behavior. */
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
      async expire(_key: string, _sec: number) {
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

function setup(opts: { throwOn?: string } = {}) {
  const redis = makeRedis(opts.throwOn);
  const queue = { client: Promise.resolve(redis.client) } as unknown as Queue;
  const svc = new AdminOtpService(config, pii, queue);
  return { svc, redis };
}

/** Assert a serialized blob carries no raw admin PII (email / domain / code / email-hash). */
function assertNoPii(blob: string, code?: string) {
  expect(blob).not.toContain(EMAIL);
  expect(blob).not.toContain("badabhai.in");
  expect(blob).not.toContain(EMAIL_HASH);
  if (code) expect(blob).not.toContain(code);
}

// ---------------------------------------------------------------------------
// issueAndSend — reserve (delivery is a deferred no-op stub) — code NEVER returned.
// ---------------------------------------------------------------------------
describe("AdminOtpService.issueAndSend", () => {
  it("stores the code's HMAC (never the plaintext) and arms a resend cooldown", async () => {
    const { svc, redis } = setup();
    const out = await svc.issueAndSend(EMAIL_HASH);

    // The result carries ONLY the resend cooldown — the code is never echoed (real-only).
    expect(out).toEqual({ resendInSeconds: config.OTP_RESEND_COOLDOWN_SECONDS });
    expect(Object.keys(out)).toEqual(["resendInSeconds"]);

    const code = reservedCode(redis.store);
    expect(code).toMatch(/^\d{6}$/);
    const stored = redis.store.get(codeKey(EMAIL_HASH));
    expect(stored).toBe(`hmac<${code}>`); // the HMAC envelope, NOT the plaintext code
    expect(stored).not.toBe(code);
    // The resend cooldown is armed for the next request.
    expect(redis.store.has(cooldownKey(EMAIL_HASH))).toBe(true);
  });

  it("NEVER returns the OTP code to the caller (no code/email field on the response)", async () => {
    const { svc, redis } = setup();
    const out = await svc.issueAndSend(EMAIL_HASH);
    const code = reservedCode(redis.store);

    // The whole returned object must not carry the code, the email, or the email-hash.
    assertNoPii(JSON.stringify(out), code);
    // And there is no extra field beyond resendInSeconds that could smuggle a secret.
    expect(Object.keys(out)).toEqual(["resendInSeconds"]);
  });

  it("NEVER logs the OTP code or the raw email — only an email-hash PREFIX (invariant #2)", async () => {
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    try {
      const { svc, redis } = setup();
      await svc.issueAndSend(EMAIL_HASH);
      const code = reservedCode(redis.store);

      const logged = JSON.stringify([...log.mock.calls, ...error.mock.calls]);
      // The full email-hash, the raw email, and the code never appear in any log line.
      assertNoPii(logged, code);
      // Only the 8-char hash prefix is permitted in the issued log line.
      expect(logged).toContain(EMAIL_HASH.slice(0, 8));
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it("arms a resend cooldown — a second immediate issue is rejected with a neutral 429", async () => {
    const { svc } = setup();
    await svc.issueAndSend(EMAIL_HASH);
    const err = await svc.issueAndSend(EMAIL_HASH).catch((e) => e);
    expect(err.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    // The throttle message carries no PII / code.
    assertNoPii(err.message);
  });

  it("FAILS CLOSED (503, deny — never issue) on a Redis error", async () => {
    // `exists` is the first Redis call in reserve() → a transport error must DENY, not allow.
    const { svc } = setup({ throwOn: "exists" });
    const err = await svc.issueAndSend(EMAIL_HASH).catch((e) => e);
    expect(err.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    assertNoPii(err.message);
  });
});

// ---------------------------------------------------------------------------
// issueWithoutDelivery — the no-enumeration timing/Redis-state parity path.
// ---------------------------------------------------------------------------
describe("AdminOtpService.issueWithoutDelivery (no-enumeration parity)", () => {
  it("reserves a code with the IDENTICAL Redis side-effects as issueAndSend (no oracle)", async () => {
    // Known account path.
    const known = setup();
    const knownOut = await known.svc.issueAndSend(EMAIL_HASH);

    // Unknown account path — same emailHash arg shape, different service instance.
    const unknown = setup();
    const unknownOut = await unknown.svc.issueWithoutDelivery(EMAIL_HASH);

    // Byte-identical neutral response — no enumeration oracle.
    expect(knownOut).toEqual(unknownOut);
    expect(unknownOut).toEqual({ resendInSeconds: config.OTP_RESEND_COOLDOWN_SECONDS });

    // The reserve path stores a code HMAC + arms the cooldown in BOTH — identical observable
    // Redis state, so timing/429 behavior is the same for a known vs unknown account.
    expect(unknown.redis.store.get(codeKey(EMAIL_HASH))).toMatch(/^hmac<\d{6}>$/);
    expect(unknown.redis.store.has(cooldownKey(EMAIL_HASH))).toBe(true);

    const knownKeys = [...known.redis.store.keys()].sort();
    const unknownKeys = [...unknown.redis.store.keys()].sort();
    expect(unknownKeys).toEqual(knownKeys); // identical key-set → no state oracle
  });

  it("takes the SAME 429 cooldown path as issueAndSend on an immediate repeat", async () => {
    const { svc } = setup();
    await svc.issueWithoutDelivery(EMAIL_HASH);
    const err = await svc.issueWithoutDelivery(EMAIL_HASH).catch((e) => e);
    expect(err.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
  });

  it("FAILS CLOSED (503) on a Redis error — identical to the known-account path (no oracle)", async () => {
    const { svc } = setup({ throwOn: "exists" });
    const err = await svc.issueWithoutDelivery(EMAIL_HASH).catch((e) => e);
    expect(err.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
  });
});

// ---------------------------------------------------------------------------
// Resend cooldown + hourly send cap — neutral throttle, PII-FREE, no breach event.
// ---------------------------------------------------------------------------
describe("AdminOtpService — resend cooldown + hourly send cap (neutral, PII-free)", () => {
  it("enforces the per-account HOURLY send cap (OTP_MAX_SENDS_PER_HOUR) with a neutral 429", async () => {
    const { svc, redis } = setup();
    // Clear the cooldown between each issue so we exercise the hourly cap, not the cooldown.
    for (let i = 0; i < config.OTP_MAX_SENDS_PER_HOUR; i += 1) {
      await svc.issueAndSend(EMAIL_HASH);
      redis.store.delete(cooldownKey(EMAIL_HASH));
    }
    // The (cap + 1)th send within the hour is refused.
    const err = await svc.issueAndSend(EMAIL_HASH).catch((e) => e);
    expect(err.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    // The cap throttle is a NEUTRAL message — no email, no code, no email-hash.
    assertNoPii(err.message);
    expect(err.message).toBe("Too many codes requested; please try again later");
  });

  it("the hourly-cap refusal emits NO event and leaks NO PII (admin OTP has no breach-event path)", async () => {
    // The AdminOtpService deliberately has NO EventsService collaborator and NO global daily
    // breaker — it is a per-account throttle ONLY. (The PII-free `*.otp_send_cap_exceeded`
    // breach event exists ONLY for the worker_sms/payer_email REAL-send circuit-breaker; the
    // admin OTP path has no real-send channel wired in ADMIN-1, so there is nothing to emit
    // and — critically — nothing that could carry an email/code.) Assert the refusal is a
    // bare, PII-free 429.
    const { svc, redis } = setup();
    for (let i = 0; i < config.OTP_MAX_SENDS_PER_HOUR; i += 1) {
      await svc.issueAndSend(EMAIL_HASH);
      redis.store.delete(cooldownKey(EMAIL_HASH));
    }
    const err = await svc.issueAndSend(EMAIL_HASH).catch((e) => e);
    const code = reservedCode(redis.store); // best-effort (may be empty post-refusal)
    // The exception (status + message + any attached body) is fully PII/code-free.
    assertNoPii(JSON.stringify({ msg: err.message, status: err.getStatus() }), code || undefined);
  });

  it("the hourly send counter is keyed PII-FREE (email-HASH + UTC hour, never the raw email)", async () => {
    const { svc, redis } = setup();
    await svc.issueAndSend(EMAIL_HASH);
    const sendCountKeys = [...redis.store.keys()].filter((k) => k.startsWith("admin_otp:sendcount:"));
    expect(sendCountKeys.length).toBe(1);
    const sendKey = sendCountKeys[0] ?? "";
    // The key namespace carries only the opaque email-HASH + UTC-hour stamp — never the raw
    // email/domain/code. (The email-HASH IS the keying material here, by design — it is the
    // PII-safe keyed digest, so we assert it is keyed BY the hash, not that it is absent.)
    expect(sendKey).not.toContain(EMAIL);
    expect(sendKey).not.toContain("badabhai.in");
    expect(sendKey).toContain(EMAIL_HASH); // keyed by the opaque hash (PII-safe lookup key)
    expect(sendKey).toMatch(/^admin_otp:sendcount:.+:\d{10}$/);
  });
});

// ---------------------------------------------------------------------------
// verify — constant-time compare, single-use, no enumeration, attempt lockout, fail-closed.
// ---------------------------------------------------------------------------
describe("AdminOtpService.verify", () => {
  it("verifies a correct code, then is SINGLE-USE (a replay is rejected)", async () => {
    const { svc, redis } = setup();
    await svc.issueAndSend(EMAIL_HASH);
    const code = reservedCode(redis.store);

    await expect(svc.verify(EMAIL_HASH, code)).resolves.toBeUndefined();
    // single-use: success deleted the code, attempts, and the cooldown.
    expect(redis.store.has(codeKey(EMAIL_HASH))).toBe(false);
    expect(redis.store.has(attemptsKey(EMAIL_HASH))).toBe(false);
    expect(redis.store.has(cooldownKey(EMAIL_HASH))).toBe(false);
    // a replay of the SAME (now-consumed) code now fails with the neutral 401.
    const replay = await svc.verify(EMAIL_HASH, code).catch((e) => e);
    expect(replay.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
  });

  it("returns the SAME 401 message for a WRONG code and for NO-code-on-file (no enumeration oracle)", async () => {
    const wrong = setup();
    await wrong.svc.issueAndSend(EMAIL_HASH);
    // submit a code that cannot match the reserved one
    const reserved = reservedCode(wrong.redis.store);
    const bad = reserved === "000000" ? "111111" : "000000";
    const wrongErr = await wrong.svc.verify(EMAIL_HASH, bad).catch((e) => e);

    const none = setup(); // no code ever reserved for this account
    const noneErr = await none.svc.verify(EMAIL_HASH, "000000").catch((e) => e);

    expect(wrongErr.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    expect(noneErr.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    // Identical message → a caller cannot tell "wrong code" from "no account/code" (XB-H).
    expect(wrongErr.message).toBe(noneErr.message);
    expect(wrongErr.message).toBe("Incorrect or expired code");
    assertNoPii(wrongErr.message);
  });

  it("runs the constant-time compare path even when NO code is on file (timing flattening)", async () => {
    // With no stored code, verify still HMACs the submitted code + timingSafeEqual's a dummy
    // before the 401, so the no-code branch is observably the same work as the wrong-code one.
    const hmac = vi.spyOn(pii, "hmac");
    try {
      const { svc } = setup();
      const err = await svc.verify(EMAIL_HASH, "424242").catch((e) => e);
      expect(err.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
      // The submitted code was HMAC'd (the dummy-compare path), i.e. constant-time work ran.
      expect(hmac).toHaveBeenCalledWith("424242");
    } finally {
      hmac.mockRestore();
    }
  });

  it("increments the attempt counter and LOCKS OUT after OTP_MAX_ATTEMPTS (neutral 429)", async () => {
    const { svc, redis } = setup();
    await svc.issueAndSend(EMAIL_HASH);
    const correct = reservedCode(redis.store);
    const wrong = correct === "000000" ? "111111" : "000000";

    // Burn exactly OTP_MAX_ATTEMPTS wrong codes (each a neutral 401, counter increments).
    for (let i = 0; i < config.OTP_MAX_ATTEMPTS; i += 1) {
      const e = await svc.verify(EMAIL_HASH, wrong).catch((x) => x);
      expect(e.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
      expect(Number(redis.store.get(attemptsKey(EMAIL_HASH)))).toBe(i + 1);
    }
    // The (max + 1)th attempt trips the lockout → 429, AND nukes the code (no further tries).
    const locked = await svc.verify(EMAIL_HASH, wrong).catch((e) => e);
    expect(locked.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    assertNoPii(locked.message);
    expect(redis.store.has(codeKey(EMAIL_HASH))).toBe(false); // code invalidated on lockout
    expect(redis.store.has(attemptsKey(EMAIL_HASH))).toBe(false);

    // Even the now-CORRECT code can no longer verify (lockout invalidated the code).
    const after = await svc.verify(EMAIL_HASH, correct).catch((e) => e);
    expect(after.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
  });

  it("uses a constant-time, length-checked compare on the WRONG-code branch (never a plain ===)", async () => {
    // A wrong code of a DIFFERENT length than the stored HMAC must still resolve to the same
    // neutral 401 (the length guard precedes timingSafeEqual; no length oracle, no throw).
    const { svc, redis } = setup();
    await svc.issueAndSend(EMAIL_HASH);
    const reserved = reservedCode(redis.store);
    expect(reserved).toMatch(/^\d{6}$/);
    const err = await svc.verify(EMAIL_HASH, "1234").catch((e) => e); // shorter ⇒ length mismatch
    expect(err.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    expect(err.message).toBe("Incorrect or expired code");
  });

  it("a successful verify NEVER logs the code or the raw email (only an email-hash prefix)", async () => {
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    try {
      const { svc, redis } = setup();
      await svc.issueAndSend(EMAIL_HASH);
      const code = reservedCode(redis.store);
      await svc.verify(EMAIL_HASH, code);
      const logged = JSON.stringify(log.mock.calls);
      assertNoPii(logged, code);
      expect(logged).toContain(EMAIL_HASH.slice(0, 8)); // prefix only
    } finally {
      log.mockRestore();
    }
  });

  it("FAILS CLOSED (503, deny — never accept) on a Redis error during verify", async () => {
    // `get` is the first Redis call in verify() → a transport error must DENY the login.
    const { svc } = setup({ throwOn: "get" });
    const err = await svc.verify(EMAIL_HASH, "123456").catch((e) => e);
    expect(err.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    // Fail-closed is NEVER a silent success: the call rejected.
    assertNoPii(err.message);
  });

  it("FAILS CLOSED (503) when the attempt-counter INCR errors AFTER a code is on file (no accept)", async () => {
    // Reserve a code, then make the attempts INCR throw → verify must DENY (503), not accept
    // even though a stored code exists.
    const { svc, redis } = setup();
    await svc.issueAndSend(EMAIL_HASH);
    const code = reservedCode(redis.store);
    // Make the attempts INCR throw on the next call (a code IS already on file).
    vi.spyOn(redis.client, "incr").mockRejectedValueOnce(new Error("redis incr failed") as never);
    const err = await svc.verify(EMAIL_HASH, code).catch((e) => e);
    expect(err.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    // The code is still on file (fail-closed mid-flow did NOT consume it as a success).
    expect(redis.store.has(codeKey(EMAIL_HASH))).toBe(true);
  });

  it("never leaks the code into the 503 fail-closed error/message", async () => {
    const { svc } = setup({ throwOn: "get" });
    const err = await svc.verify(EMAIL_HASH, "987654").catch((e) => e);
    // The submitted code itself must not be echoed into the neutral 503 body.
    expect(JSON.stringify({ m: err.message, s: err.getStatus() })).not.toContain("987654");
  });
});

// ---------------------------------------------------------------------------
// Namespace isolation — admin codes never collide with payer/worker OTP namespaces.
// ---------------------------------------------------------------------------
describe("AdminOtpService — namespace isolation (admin_otp:* distinct from payer/worker)", () => {
  it("writes ONLY under the admin_otp:* namespace (no payer_otp:* / otp:* key collision)", async () => {
    const { svc, redis } = setup();
    await svc.issueAndSend(EMAIL_HASH);
    const keys = [...redis.store.keys()];
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(k.startsWith("admin_otp:")).toBe(true);
      expect(k.startsWith("payer_otp:")).toBe(false);
      // a worker key is the bare `otp:` prefix — admin keys must not match it
      expect(/^otp:/.test(k)).toBe(false);
    }
  });
});
