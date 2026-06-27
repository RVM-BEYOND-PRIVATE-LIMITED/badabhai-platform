import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import type { Queue } from "bullmq";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import { AdminMfaSecretStore } from "./admin-mfa.store";

// ---------------------------------------------------------------------------
// AdminMfaSecretStore (ADR-0025 ADMIN-1) — TOTP-secret-at-rest + OTP→MFA binding.
//
// The store persists an admin's TOTP secret ENCRYPTED in the Redis KV (the same
// AES-256-GCM PiiCryptoService used for at-rest PII) and holds a short-lived,
// single-use OTP-pending marker that binds an OTP success to the MFA step.
//
// Every test below pins a BadaBhai invariant:
//   - NO raw secret (plaintext TOTP secret / OTP code) is ever written to Redis,
//     returned in an error, or written to a log string;
//   - fail-CLOSED on a Redis/crypto error (load/consume yield null/false — never a
//     usable secret and never an "allow");
//   - the OTP-pending marker is TTL-bounded and SINGLE-USE (consume once → gone).
// ---------------------------------------------------------------------------

const ADMIN_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const SECRET = "JBSWY3DPEHPK3PXP"; // a representative base32 TOTP secret (the plaintext)
const MFA_PENDING_TTL_SECONDS = 300;

const SECRET_KEY = `admin_mfa_secret:${ADMIN_ID}`;
const PENDING_KEY = `admin_mfa_pending:${ADMIN_ID}`;

/**
 * In-memory AES stand-in for PiiCryptoService. `encrypt` wraps the plaintext in an
 * opaque, NON-plaintext token (so we can assert ciphertext != plaintext and that the
 * plaintext never lands in Redis); `decrypt` unwraps it. Either direction can be made
 * to throw to exercise the crypto-failure (fail-closed) branch.
 */
function makeCrypto(opts: { encryptThrows?: boolean; decryptThrows?: boolean } = {}) {
  const PREFIX = "enc::"; // ciphertext is deliberately not equal to the plaintext
  const encrypt = vi.fn((plaintext: string): string => {
    if (opts.encryptThrows) throw new Error("encrypt boom");
    // Reversible but non-plaintext: base64 of the secret behind a self-describing tag.
    return `${PREFIX}${Buffer.from(plaintext, "utf8").toString("base64")}`;
  });
  const decrypt = vi.fn((token: string): string => {
    if (opts.decryptThrows) throw new Error("auth tag mismatch");
    if (!token.startsWith(PREFIX)) throw new Error("malformed token");
    return Buffer.from(token.slice(PREFIX.length), "base64").toString("utf8");
  });
  return { encrypt, decrypt, PREFIX };
}

/**
 * Minimal ioredis-shaped fake of the client BullMQ's `queue.client` resolves to.
 * Backed by a Map so set/get/setex/del behave like a real KV (TTL is recorded, not
 * enforced by a clock). Any op can be scripted to throw to drive the fail-closed paths.
 */
function makeRedis(
  opts: {
    getThrows?: boolean;
    delThrows?: boolean;
    setThrows?: boolean;
    setexThrows?: boolean;
  } = {},
) {
  const kv = new Map<string, string>();
  const ttls = new Map<string, number>();

  const set = vi.fn(async (key: string, value: string) => {
    if (opts.setThrows) throw new Error("redis SET refused");
    kv.set(key, value);
    return "OK";
  });
  const setex = vi.fn(async (key: string, seconds: number, value: string) => {
    if (opts.setexThrows) throw new Error("redis SETEX refused");
    kv.set(key, value);
    ttls.set(key, seconds);
    return "OK";
  });
  const get = vi.fn(async (key: string) => {
    if (opts.getThrows) throw new Error("redis GET refused");
    return kv.get(key) ?? null;
  });
  const del = vi.fn(async (...keys: string[]) => {
    if (opts.delThrows) throw new Error("redis DEL refused");
    let removed = 0;
    for (const k of keys) {
      if (kv.delete(k)) {
        removed += 1;
        ttls.delete(k);
      }
    }
    return removed;
  });

  return { set, setex, get, del, kv, ttls };
}

function setup(
  opts: {
    crypto?: { encryptThrows?: boolean; decryptThrows?: boolean };
    redis?: { getThrows?: boolean; delThrows?: boolean; setThrows?: boolean; setexThrows?: boolean };
    clientThrows?: boolean;
  } = {},
) {
  const crypto = makeCrypto(opts.crypto);
  const redis = makeRedis(opts.redis);
  // `queue.client` is a Promise in production; mirror that here.
  const queue = {
    client: opts.clientThrows
      ? Promise.reject(new Error("redis connection refused"))
      : Promise.resolve(redis),
  };

  const store = new AdminMfaSecretStore(
    crypto as unknown as PiiCryptoService,
    queue as unknown as Queue,
  );
  return { store, crypto, redis };
}

/** Capture everything the Nest Logger writes (it routes through console). */
function captureLogs(): { logged: () => string; restore: () => void } {
  const sink: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const spies = methods.map((m) =>
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      sink.push(args.map(String).join(" "));
    }),
  );
  return { logged: () => sink.join(" "), restore: () => spies.forEach((s) => s.mockRestore()) };
}

// ---------------------------------------------------------------------------
// save/load — TOTP secret encryption round-trip (encrypted at rest, never plaintext).
// ---------------------------------------------------------------------------
describe("AdminMfaSecretStore — secret encryption round-trip (at rest)", () => {
  it("save() writes the ENCRYPTED secret under the namespaced key — plaintext never touches Redis", async () => {
    const { store, crypto, redis } = setup();
    await store.save(ADMIN_ID, SECRET);

    expect(crypto.encrypt).toHaveBeenCalledWith(SECRET);
    expect(redis.set).toHaveBeenCalledTimes(1);
    const [key, stored] = redis.set.mock.calls[0]!;
    expect(key).toBe(SECRET_KEY);
    // What landed in Redis is the ciphertext — NOT the plaintext secret.
    expect(stored).not.toBe(SECRET);
    expect(stored).not.toContain(SECRET);
    expect(stored.startsWith(crypto.PREFIX)).toBe(true);
  });

  it("load() decrypts the stored ciphertext back to the ORIGINAL plaintext (round-trip)", async () => {
    const { store } = setup();
    await store.save(ADMIN_ID, SECRET);
    const loaded = await store.load(ADMIN_ID);
    expect(loaded).toBe(SECRET);
  });

  it("save() overwrites a prior secret (re-enroll replaces, never appends)", async () => {
    const { store, redis } = setup();
    await store.save(ADMIN_ID, SECRET);
    await store.save(ADMIN_ID, "NEWSECRET234567");
    // `set` (not append): only one value lives at the key, and it round-trips to the latest.
    expect(redis.kv.get(SECRET_KEY)).toBeDefined();
    expect(await store.load(ADMIN_ID)).toBe("NEWSECRET234567");
  });

  it("load() returns null when no secret is stored (not-enrolled is absent, not an error)", async () => {
    const { store, crypto } = setup();
    const loaded = await store.load(ADMIN_ID);
    expect(loaded).toBeNull();
    // No ciphertext → decrypt is never attempted (no spurious decrypt of an empty value).
    expect(crypto.decrypt).not.toHaveBeenCalled();
  });

  it("the namespaced secret key is distinct from the OTP-pending key (separate concerns)", async () => {
    const { store, redis } = setup();
    await store.save(ADMIN_ID, SECRET);
    await store.markOtpPassed(ADMIN_ID);
    expect(redis.kv.has(SECRET_KEY)).toBe(true);
    expect(redis.kv.has(PENDING_KEY)).toBe(true);
    expect(SECRET_KEY).not.toBe(PENDING_KEY);
  });
});

// ---------------------------------------------------------------------------
// load — fail-CLOSED on Redis/crypto error (never returns a usable secret).
// ---------------------------------------------------------------------------
describe("AdminMfaSecretStore — load() fails closed (deny, never a usable secret)", () => {
  it("a Redis GET outage returns null (cannot verify second factor → treat as absent)", async () => {
    const { store } = setup({ redis: { getThrows: true } });
    const loaded = await store.load(ADMIN_ID);
    expect(loaded).toBeNull();
  });

  it("a queue/client connection failure returns null (does not throw, does not leak)", async () => {
    const { store } = setup({ clientThrows: true });
    await expect(store.load(ADMIN_ID)).resolves.toBeNull();
  });

  it("a DECRYPT error degrades silently to null (does not throw) — auth-tag mismatch / key rotation", async () => {
    // Seed a ciphertext with a healthy crypto, then load with a decrypt that throws.
    const seed = setup();
    await seed.store.save(ADMIN_ID, SECRET);
    const stored = seed.redis.kv.get(SECRET_KEY)!;

    const broken = setup({ crypto: { decryptThrows: true } });
    broken.redis.kv.set(SECRET_KEY, stored);
    await expect(broken.store.load(ADMIN_ID)).resolves.toBeNull();
  });

  it("on a decrypt error the raw secret / ciphertext is NEVER written to a log", async () => {
    const seed = setup();
    await seed.store.save(ADMIN_ID, SECRET);
    const stored = seed.redis.kv.get(SECRET_KEY)!;

    const broken = setup({ crypto: { decryptThrows: true } });
    broken.redis.kv.set(SECRET_KEY, stored);

    const logs = captureLogs();
    try {
      await broken.store.load(ADMIN_ID);
    } finally {
      logs.restore();
    }
    const out = logs.logged();
    // Neither the plaintext secret nor the stored ciphertext may appear in any log line.
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(stored);
  });

  it("on a Redis GET outage the failure log carries no raw secret and no full admin id", async () => {
    const { store } = setup({ redis: { getThrows: true } });
    const logs = captureLogs();
    try {
      await store.load(ADMIN_ID);
    } finally {
      logs.restore();
    }
    const out = logs.logged();
    expect(out).not.toContain(SECRET);
    // The id is truncated (only an 8-char prefix is logged) — the full id is never logged.
    expect(out).not.toContain(ADMIN_ID);
  });
});

// ---------------------------------------------------------------------------
// markOtpPassed / consumeOtpPending — TTL-bounded, single-use OTP→MFA binding.
// ---------------------------------------------------------------------------
describe("AdminMfaSecretStore — OTP-pending marker (single-flow binding)", () => {
  it("markOtpPassed() sets the pending marker with the bounded TTL (cannot live forever)", async () => {
    const { store, redis } = setup();
    await store.markOtpPassed(ADMIN_ID);
    expect(redis.setex).toHaveBeenCalledTimes(1);
    const [key, ttl, value] = redis.setex.mock.calls[0]!;
    expect(key).toBe(PENDING_KEY);
    expect(ttl).toBe(MFA_PENDING_TTL_SECONDS);
    expect(redis.ttls.get(PENDING_KEY)).toBe(MFA_PENDING_TTL_SECONDS);
    // The marker value is an opaque flag — it carries no secret/PII.
    expect(value).toBe("1");
  });

  it("consumeOtpPending() returns true when the marker is present (a valid in-flow MFA step)", async () => {
    const { store } = setup();
    await store.markOtpPassed(ADMIN_ID);
    await expect(store.consumeOtpPending(ADMIN_ID)).resolves.toBe(true);
  });

  it("the marker is SINGLE-USE: consume once → true, immediately again → false (gone, no replay)", async () => {
    const { store, redis } = setup();
    await store.markOtpPassed(ADMIN_ID);

    expect(await store.consumeOtpPending(ADMIN_ID)).toBe(true);
    expect(redis.kv.has(PENDING_KEY)).toBe(false); // deleted on first consume
    // A second consume in the same/next flow finds nothing → deny.
    expect(await store.consumeOtpPending(ADMIN_ID)).toBe(false);
  });

  it("consumeOtpPending() with NO prior markOtpPassed denies (false) — a TOTP secret alone cannot mint", async () => {
    const { store } = setup();
    await expect(store.consumeOtpPending(ADMIN_ID)).resolves.toBe(false);
  });

  it("consume targets the pending key only — it never deletes the stored secret", async () => {
    const { store, redis } = setup();
    await store.save(ADMIN_ID, SECRET);
    await store.markOtpPassed(ADMIN_ID);
    await store.consumeOtpPending(ADMIN_ID);
    expect(redis.kv.has(PENDING_KEY)).toBe(false);
    expect(redis.kv.has(SECRET_KEY)).toBe(true); // the enrolled secret survives the OTP-step consume
  });
});

// ---------------------------------------------------------------------------
// consumeOtpPending — fail-CLOSED on a Redis error (deny the MFA step, never allow).
// ---------------------------------------------------------------------------
describe("AdminMfaSecretStore — consumeOtpPending() fails closed (deny, never allow)", () => {
  it("a Redis DEL outage returns false (deny the MFA step — an outage must not mint a session)", async () => {
    const { store } = setup({ redis: { delThrows: true } });
    await expect(store.consumeOtpPending(ADMIN_ID)).resolves.toBe(false);
  });

  it("a queue/client connection failure returns false (does not throw, denies)", async () => {
    const { store } = setup({ clientThrows: true });
    await expect(store.consumeOtpPending(ADMIN_ID)).resolves.toBe(false);
  });

  it("a Redis outage during consume leaks nothing into a log line", async () => {
    const { store } = setup({ redis: { delThrows: true } });
    const logs = captureLogs();
    try {
      await store.consumeOtpPending(ADMIN_ID);
    } finally {
      logs.restore();
    }
    const out = logs.logged();
    expect(out).not.toContain(SECRET);
  });
});

// ---------------------------------------------------------------------------
// clear — best-effort secret removal (a reset), tolerant of Redis errors.
// ---------------------------------------------------------------------------
describe("AdminMfaSecretStore — clear() (best-effort reset)", () => {
  it("clear() deletes the secret key so a subsequent load() returns null (reset took effect)", async () => {
    const { store, redis } = setup();
    await store.save(ADMIN_ID, SECRET);
    await store.clear(ADMIN_ID);
    expect(redis.del).toHaveBeenCalledWith(SECRET_KEY);
    expect(await store.load(ADMIN_ID)).toBeNull();
  });

  it("clear() targets only the secret key (it does not touch the OTP-pending marker)", async () => {
    const { store, redis } = setup();
    await store.save(ADMIN_ID, SECRET);
    await store.markOtpPassed(ADMIN_ID);
    await store.clear(ADMIN_ID);
    expect(redis.del).toHaveBeenCalledWith(SECRET_KEY);
    expect(redis.del).not.toHaveBeenCalledWith(PENDING_KEY);
    expect(redis.kv.has(PENDING_KEY)).toBe(true);
  });

  it("clear() swallows a Redis error (best-effort) — it never throws to the caller", async () => {
    const { store } = setup({ redis: { delThrows: true } });
    await expect(store.clear(ADMIN_ID)).resolves.toBeUndefined();
  });

  it("clear() swallows a client connection failure too (best-effort)", async () => {
    const { store } = setup({ clientThrows: true });
    await expect(store.clear(ADMIN_ID)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// No-secret-leak regression across the WHOLE lifecycle (save→load→mark→consume→clear).
// ---------------------------------------------------------------------------
describe("AdminMfaSecretStore — no plaintext secret in Redis at any lifecycle point", () => {
  it("at no point does the raw secret appear as a stored Redis value", async () => {
    const { store, redis } = setup();
    await store.save(ADMIN_ID, SECRET);
    await store.markOtpPassed(ADMIN_ID);
    await store.consumeOtpPending(ADMIN_ID);

    // Every value ever written to the KV must be free of the plaintext secret.
    for (const value of redis.kv.values()) {
      expect(value).not.toContain(SECRET);
    }
    // And the secret round-trips correctly out the front door regardless.
    expect(await store.load(ADMIN_ID)).toBe(SECRET);

    await store.clear(ADMIN_ID);
    expect(await store.load(ADMIN_ID)).toBeNull();
  });
});
