import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import type { Queue } from "bullmq";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import type { AdminRepository } from "./admin.repository";
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

/**
 * ADR-0038 — the TOTP seed now lives in `admin_users.mfa_secret_enc`, not Redis. This is
 * the column, faked: a single nullable cell plus the two accessors the store calls. Either
 * can be scripted to throw, which is what drives the fail-closed branches that a Redis
 * outage used to drive.
 */
function makeAdmins(opts: { readThrows?: boolean; writeThrows?: boolean } = {}) {
  let cell: string | null = null;
  const setMfaSecret = vi.fn(async (_id: string, enc: string | null) => {
    if (opts.writeThrows) throw new Error("db UPDATE refused");
    cell = enc;
  });
  const findMfaSecret = vi.fn(async (_id: string) => {
    if (opts.readThrows) throw new Error("db SELECT refused");
    return cell;
  });
  return { setMfaSecret, findMfaSecret, column: () => cell };
}

function setup(
  opts: {
    crypto?: { encryptThrows?: boolean; decryptThrows?: boolean };
    redis?: { getThrows?: boolean; delThrows?: boolean; setThrows?: boolean; setexThrows?: boolean };
    admins?: { readThrows?: boolean; writeThrows?: boolean };
    clientThrows?: boolean;
  } = {},
) {
  const crypto = makeCrypto(opts.crypto);
  const redis = makeRedis(opts.redis);
  const admins = makeAdmins(opts.admins);
  // `queue.client` is a Promise in production; mirror that here.
  // A GETTER, not a field. Built eagerly, a rejected `client` promise that no code path
  // consumes surfaces as an unhandled rejection and fails the whole run — which is exactly
  // what happened once ADR-0038 moved the seed off Redis and `clear()` stopped resolving
  // the client. Lazily, the rejection only exists when something actually asks for it.
  const queue = {
    get client(): Promise<unknown> {
      return opts.clientThrows
        ? Promise.reject(new Error("redis connection refused"))
        : Promise.resolve(redis);
    },
  };

  const store = new AdminMfaSecretStore(
    crypto as unknown as PiiCryptoService,
    queue as unknown as Queue,
    admins as unknown as AdminRepository,
  );
  return { store, crypto, redis, admins };
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
  it("save() writes the ENCRYPTED seed to the COLUMN — plaintext is never persisted", async () => {
    const { store, crypto, admins, redis } = setup();
    await store.save(ADMIN_ID, SECRET);

    expect(crypto.encrypt).toHaveBeenCalledWith(SECRET);
    expect(admins.setMfaSecret).toHaveBeenCalledTimes(1);
    const [id, stored] = admins.setMfaSecret.mock.calls[0]!;
    expect(id).toBe(ADMIN_ID);
    // What lands in the column is ciphertext — NOT the plaintext seed.
    expect(stored).not.toBe(SECRET);
    expect(stored).not.toContain(SECRET);
    expect(String(stored).startsWith(crypto.PREFIX)).toBe(true);

    // ADR-0038 — and it does NOT go to Redis any more. The old key had no TTL and no
    // persistence guarantee, so a flush destroyed a seed that is shown exactly once.
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.kv.has(SECRET_KEY)).toBe(false);
  });

  it("load() decrypts the stored ciphertext back to the ORIGINAL plaintext (round-trip)", async () => {
    const { store } = setup();
    await store.save(ADMIN_ID, SECRET);
    const loaded = await store.load(ADMIN_ID);
    expect(loaded).toBe(SECRET);
  });

  it("save() overwrites a prior seed (re-enroll replaces, never appends)", async () => {
    const { store, admins } = setup();
    await store.save(ADMIN_ID, SECRET);
    await store.save(ADMIN_ID, "NEWSECRET234567");
    // One column, one value: the cell holds the latest and the round-trip proves it.
    expect(admins.column()).not.toBeNull();
    expect(await store.load(ADMIN_ID)).toBe("NEWSECRET234567");
  });

  it("load() returns null when no secret is stored (not-enrolled is absent, not an error)", async () => {
    const { store, crypto } = setup();
    const loaded = await store.load(ADMIN_ID);
    expect(loaded).toBeNull();
    // No ciphertext → decrypt is never attempted (no spurious decrypt of an empty value).
    expect(crypto.decrypt).not.toHaveBeenCalled();
  });

  it("the durable seed and the ephemeral OTP-pending marker live in different stores", async () => {
    // ADR-0038 split these deliberately. The seed is long-lived and must survive a Redis
    // flush, so it is a DB column; the pending marker is a short-lived single-flow binding
    // that SHOULD evaporate, so it stays a TTL'd Redis key.
    const { store, redis, admins } = setup();
    await store.save(ADMIN_ID, SECRET);
    await store.markOtpPassed(ADMIN_ID);

    expect(admins.column()).not.toBeNull();
    expect(redis.kv.has(PENDING_KEY)).toBe(true);
    expect(redis.kv.has(SECRET_KEY)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// load — fail-CLOSED on Redis/crypto error (never returns a usable secret).
// ---------------------------------------------------------------------------
describe("AdminMfaSecretStore — load() fails closed (deny, never a usable secret)", () => {
  it("a DB read outage returns null (cannot verify second factor → treat as absent)", async () => {
    // ADR-0038 — this used to script a Redis GET failure. After the move that would pass
    // TRIVIALLY (load never touches Redis, so the empty column returns null on its own),
    // proving nothing. The outage now has to be on the store the seed actually lives in.
    const { store, admins } = setup({ admins: { readThrows: true } });
    await store.save(ADMIN_ID, SECRET);
    expect(admins.column()).not.toBeNull(); // a seed IS present — so null means fail-closed
    await expect(store.load(ADMIN_ID)).resolves.toBeNull();
  });

  it("a DECRYPT error degrades silently to null (auth-tag mismatch / key rotation)", async () => {
    // Seed the column through a healthy crypto, then read it back with a decrypt that
    // throws — the ciphertext is genuinely present, so null can only come from the catch.
    const broken = setup({ crypto: {} });
    await broken.store.save(ADMIN_ID, SECRET);
    broken.crypto.decrypt.mockImplementationOnce(() => {
      throw new Error("auth tag mismatch");
    });
    await expect(broken.store.load(ADMIN_ID)).resolves.toBeNull();
  });

  it("on a decrypt error the raw seed / ciphertext is NEVER written to a log", async () => {
    const broken = setup({ crypto: {} });
    await broken.store.save(ADMIN_ID, SECRET);
    const stored = broken.admins.column()!;
    broken.crypto.decrypt.mockImplementation(() => {
      throw new Error("auth tag mismatch");
    });

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

  it("consume targets the pending marker only — the enrolled seed survives", async () => {
    const { store, redis, admins } = setup();
    await store.save(ADMIN_ID, SECRET);
    await store.markOtpPassed(ADMIN_ID);
    await store.consumeOtpPending(ADMIN_ID);
    expect(redis.kv.has(PENDING_KEY)).toBe(false);
    // The seed is in the column, so consuming a Redis marker cannot reach it — an admin is
    // not silently un-enrolled by completing a login.
    expect(admins.column()).not.toBeNull();
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
  it("clear() NULLs the column so a subsequent load() returns null (reset took effect)", async () => {
    const { store, admins } = setup();
    await store.save(ADMIN_ID, SECRET);
    await store.clear(ADMIN_ID);
    expect(admins.setMfaSecret).toHaveBeenLastCalledWith(ADMIN_ID, null);
    expect(admins.column()).toBeNull();
    expect(await store.load(ADMIN_ID)).toBeNull();
  });

  it("clear() touches only the seed (it does not consume the OTP-pending marker)", async () => {
    const { store, redis, admins } = setup();
    await store.save(ADMIN_ID, SECRET);
    await store.markOtpPassed(ADMIN_ID);
    await store.clear(ADMIN_ID);
    expect(admins.column()).toBeNull();
    // A reset must not silently satisfy or destroy an in-flight login's binding.
    expect(redis.del).not.toHaveBeenCalledWith(PENDING_KEY);
    expect(redis.kv.has(PENDING_KEY)).toBe(true);
  });

  it("clear() swallows a write error (best-effort) — it never throws to the caller", async () => {
    const { store } = setup({ admins: { writeThrows: true } });
    await expect(store.clear(ADMIN_ID)).resolves.toBeUndefined();
  });

  it("clear() does not depend on Redis at all (the seed is in the column)", async () => {
    // ADR-0038 — this used to script a Redis client failure. After the move `clear()` never
    // resolves the client, so the assertion passed trivially AND the rejected promise
    // leaked as an unhandled rejection. What is worth pinning now is the property that
    // replaced it: an admin reset works even when Redis is completely unavailable.
    const { store, admins } = setup({ clientThrows: true });
    await store.save(ADMIN_ID, SECRET);
    await expect(store.clear(ADMIN_ID)).resolves.toBeUndefined();
    expect(admins.column()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// No-secret-leak regression across the WHOLE lifecycle (save→load→mark→consume→clear).
// ---------------------------------------------------------------------------
describe("AdminMfaSecretStore — no plaintext seed in ANY store at any lifecycle point", () => {
  it("neither Redis nor the column ever holds the raw seed", async () => {
    const { store, redis, admins } = setup();
    await store.save(ADMIN_ID, SECRET);
    await store.markOtpPassed(ADMIN_ID);
    await store.consumeOtpPending(ADMIN_ID);

    // Every value ever written to the KV must be free of the plaintext seed.
    for (const value of redis.kv.values()) {
      expect(value).not.toContain(SECRET);
    }
    // ...and so must the column, which is where the seed ACTUALLY lives now. Without this
    // the sweep above is hollow: it scans a store the seed no longer passes through.
    expect(admins.column()).not.toBeNull();
    expect(admins.column()).not.toContain(SECRET);
    // And the secret round-trips correctly out the front door regardless.
    expect(await store.load(ADMIN_ID)).toBe(SECRET);

    await store.clear(ADMIN_ID);
    expect(await store.load(ADMIN_ID)).toBeNull();
  });
});
