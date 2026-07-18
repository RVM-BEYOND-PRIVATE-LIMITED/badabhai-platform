import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import type { JwtService } from "@nestjs/jwt";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { sha256Hex } from "@badabhai/db";
import { SessionService } from "./session.service";

const BASE_CONFIG = {
  SESSION_TTL_DAYS: 30,
  AUTH_ROLLING_TIERS_ENABLED: false,
  AUTH_SESSION_ABSOLUTE_MAX_DAYS: 90,
  AUTH_TIER_WINDOW_DAYS: 60,
  AUTH_REFRESH_TTL_DAYS: 90,
} as unknown as ServerConfig;

const TTL = 30 * 86400;

/**
 * In-memory Redis double supporting the string + set commands the service uses,
 * including the optional `SET key val NX EX sec` variadic form (the rotation lock).
 */
function makeRedis() {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  // Last EXPIRE seconds recorded per key — lets a test assert the lineage-set TTLs (the
  // re-arm fix) without a real clock.
  const ttls = new Map<string, number>();
  const calls: Array<[string, ...unknown[]]> = [];
  const client = {
    async set(key: string, value: string, ...rest: unknown[]) {
      calls.push(["set", key, value, ...rest]);
      // SET key val NX EX sec — create-if-absent.
      if (rest[0] === "NX") {
        if (store.has(key)) return null;
        store.set(key, value);
        return "OK";
      }
      store.set(key, value);
      return "OK";
    },
    async get(key: string) {
      calls.push(["get", key]);
      return store.get(key) ?? null;
    },
    async del(...keys: string[]) {
      calls.push(["del", ...keys]);
      let n = 0;
      for (const k of keys) {
        if (store.delete(k)) n += 1;
        else if (sets.delete(k)) n += 1;
      }
      return n;
    },
    async expire(key: string, sec: number) {
      calls.push(["expire", key, sec]);
      const exists = store.has(key) || sets.has(key);
      if (exists) ttls.set(key, sec);
      return exists ? 1 : 0;
    },
    async sadd(key: string, ...members: string[]) {
      calls.push(["sadd", key, ...members]);
      const s = sets.get(key) ?? new Set<string>();
      let added = 0;
      for (const m of members) {
        if (!s.has(m)) {
          s.add(m);
          added += 1;
        }
      }
      sets.set(key, s);
      return added;
    },
    async srem(key: string, ...members: string[]) {
      calls.push(["srem", key, ...members]);
      const s = sets.get(key);
      if (!s) return 0;
      let removed = 0;
      for (const m of members) if (s.delete(m)) removed += 1;
      return removed;
    },
    async smembers(key: string) {
      calls.push(["smembers", key]);
      return [...(sets.get(key) ?? [])];
    },
  };
  return { store, sets, ttls, calls, client };
}

/** A JwtService double that records claims and can simulate verify failure. */
function makeJwt(opts: { exp?: number; verifyThrows?: boolean } = {}) {
  let signed: { sub: string; sid: string } | null = null;
  return {
    signAsync: vi.fn(async (claims: { sub: string; sid: string }) => {
      signed = claims;
      return `jwt.${claims.sub}.${claims.sid}`;
    }),
    verifyAsync: vi.fn(async (token: string) => {
      if (opts.verifyThrows) throw new Error("bad signature");
      const [, sub, sid] = token.split(".");
      return { sub, sid, exp: opts.exp ?? Math.floor(Date.now() / 1000) + TTL };
    }),
    get lastSigned() {
      return signed;
    },
  };
}

/**
 * A reversible PiiCrypto double. encrypt() wraps the plaintext in an "enc(...)" envelope
 * so a test can assert the at-rest value is NOT the plaintext; decrypt() unwraps it. This
 * mirrors the real AES round-trip behavior (reversible, non-identity ciphertext).
 */
function makePii() {
  return {
    encrypt: (plaintext: string) => `enc(${Buffer.from(plaintext).toString("base64")})`,
    decrypt: (token: string) =>
      Buffer.from(token.replace(/^enc\(/, "").replace(/\)$/, ""), "base64").toString("utf8"),
    hashPhone: (p: string) => `ph:${p.length}`,
    hashIp: () => "ip",
    hmac: (v: string) => `hmac<${v}>`,
  } as never;
}

function setup(
  opts: {
    jwt?: { exp?: number; verifyThrows?: boolean };
    config?: Partial<ServerConfig>;
    devices?: { revokeAllForWorker: ReturnType<typeof vi.fn> };
    push?: { enqueue: ReturnType<typeof vi.fn> };
  } = {},
) {
  const redis = makeRedis();
  const queue = { client: Promise.resolve(redis.client) } as unknown as Queue;
  const jwt = makeJwt(opts.jwt);
  // emit() returns the persisted event — revokeAll reads `event_id` to link the push.
  const emit = vi.fn().mockResolvedValue({ event_id: "99999999-9999-4999-8999-999999999999" });
  const events = { emit } as never;
  const pii = makePii();
  const config = { ...BASE_CONFIG, ...opts.config } as ServerConfig;
  // ADR-0034 — logout-all also revokes device rows (panic button) and warns them.
  const devices = opts.devices ?? { revokeAllForWorker: vi.fn().mockResolvedValue([]) };
  const push = opts.push ?? { enqueue: vi.fn().mockResolvedValue(undefined) };
  const svc = new SessionService(
    config,
    jwt as unknown as JwtService,
    events,
    pii,
    queue,
    devices as never,
    push as never,
  );
  return { svc, redis, jwt, emit, devices, push };
}

describe("SessionService.create", () => {
  it("stores an extended session record, tracks the sid, and mints access + refresh", async () => {
    const { svc, redis, jwt } = setup();
    const res = await svc.create("worker-1");

    expect(res.access.token).toBeTruthy();
    expect(res.access.expiresInSeconds).toBe(TTL);
    expect(res.refresh.token).toMatch(/^[0-9a-f]{64}$/); // 256-bit hex opaque token
    expect(res.refresh.expiresInSeconds).toBe(90 * 86400);
    expect(res.session.tier).toBe(0);

    const sid = jwt.lastSigned!.sid;
    const stored = JSON.parse(redis.store.get(`session:${sid}`)!);
    expect(stored.worker_id).toBe("worker-1");
    expect(stored.family_id).toMatch(/^[0-9a-f-]{36}$/); // the refresh family is on the record
    expect(stored.created_via_otp_at_ms).toBeGreaterThan(0);
    expect(stored.active_days).toHaveLength(1);
    expect(stored.tier).toBe(0);

    // The sid + its family are registered under the worker lineage sets (so logout can
    // kill the refresh tokens, not just the session record).
    expect(redis.sets.get("worker_sessions:worker-1")!.has(sid)).toBe(true);
    expect(redis.sets.get("worker_families:worker-1")!.has(stored.family_id)).toBe(true);

    // The refresh token VALUE is never persisted — only sha256(token) is a key. The
    // refresh record carries the immutable OTP anchor.
    const refreshHash = sha256Hex(res.refresh.token);
    expect(redis.store.has(`refresh:${refreshHash}`)).toBe(true);
    const refreshRec = JSON.parse(redis.store.get(`refresh:${refreshHash}`)!);
    expect(refreshRec.created_via_otp_at_ms).toBe(stored.created_via_otp_at_ms);
    expect([...redis.store.keys()].some((k) => k.includes(res.refresh.token))).toBe(false);
    // No log/store value contains the raw token.
    expect(JSON.stringify([...redis.store.values()])).not.toContain(res.refresh.token);
  });

  it("flat idle TTL stays SESSION_TTL_DAYS when tiers are OFF (no behavior change)", async () => {
    const { svc, redis, jwt } = setup();
    await svc.create("worker-1");
    const sid = jwt.lastSigned!.sid;
    const setCall = redis.calls.find(
      (c) => c[0] === "set" && String(c[1]) === `session:${sid}`,
    )!;
    expect(setCall[setCall.length - 1]).toBe(TTL); // EX seconds
  });
});

describe("SessionService.validateAndTouch (legacy flat behavior, tiers OFF)", () => {
  it("returns claims and RESETS the flat session TTL (sliding)", async () => {
    const { svc, redis } = setup();
    const created = await svc.create("worker-1");
    const validated = await svc.validateAndTouch(created.access.token);
    expect(validated).not.toBeNull();
    expect(validated!.workerId).toBe("worker-1");
    const expireCall = redis.calls.find(
      (c) => c[0] === "expire" && String(c[1]).startsWith("session:"),
    );
    expect(expireCall).toBeDefined();
    expect(expireCall![2]).toBe(TTL);
  });

  it("returns null when the session record is missing (revoked/expired)", async () => {
    const { svc, redis } = setup();
    const created = await svc.create("worker-1");
    redis.store.clear();
    expect(await svc.validateAndTouch(created.access.token)).toBeNull();
  });

  it("returns null when the JWT signature/exp is invalid", async () => {
    const { svc } = setup({ jwt: { verifyThrows: true } });
    expect(await svc.validateAndTouch("anything")).toBeNull();
  });
});

describe("SessionService.refresh (legacy /auth/refresh — unchanged)", () => {
  it("mints a fresh access token for a valid session, same sid", async () => {
    const { svc, jwt } = setup();
    const created = await svc.create("worker-1");
    const firstSid = jwt.lastSigned!.sid;
    const refreshed = await svc.refresh(created.access.token);
    expect(refreshed).not.toBeNull();
    expect(refreshed!.expiresInSeconds).toBe(TTL);
    expect(jwt.lastSigned!.sid).toBe(firstSid);
  });

  it("returns null when the session is invalid", async () => {
    const { svc } = setup({ jwt: { verifyThrows: true } });
    expect(await svc.refresh("bad")).toBeNull();
  });
});

describe("SessionService.refreshByToken — rotation", () => {
  it("rotates: marks the old token used, mints a new valid token, fresh access JWT", async () => {
    const { svc, redis } = setup();
    const created = await svc.create("worker-1");
    const oldHash = sha256Hex(created.refresh.token);

    const out = await svc.refreshByToken(created.refresh.token, "idem-1");
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // A brand-new refresh token, different from the old one.
    expect(out.minted.refresh.token).not.toBe(created.refresh.token);
    const newHash = sha256Hex(out.minted.refresh.token);
    expect(redis.store.has(`refresh:${newHash}`)).toBe(true);

    // The OLD record is now used + superseded_by the new hash.
    const oldRec = JSON.parse(redis.store.get(`refresh:${oldHash}`)!);
    expect(oldRec.used).toBe(true);
    expect(oldRec.superseded_by).toBe(newHash);

    // The new token belongs to the SAME family.
    const newRec = JSON.parse(redis.store.get(`refresh:${newHash}`)!);
    expect(newRec.family_id).toBe(oldRec.family_id);
    expect(redis.sets.get(`refresh_family:${oldRec.family_id}`)!.has(newHash)).toBe(true);

    // A fresh access token is returned.
    expect(out.minted.access.token).toBeTruthy();
  });

  it("returns invalid (401) for an unknown refresh token", async () => {
    const { svc } = setup();
    const out = await svc.refreshByToken("deadbeef".repeat(8), "idem-x");
    expect(out).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("SessionService.refreshByToken — REUSE DETECTION", () => {
  it("replaying a USED token revokes the whole family, emits the event, and 401s", async () => {
    const { svc, redis, emit } = setup();
    const created = await svc.create("worker-1");
    const familyId = JSON.parse(redis.store.get(`refresh:${sha256Hex(created.refresh.token)}`)!)
      .family_id as string;

    // First rotation succeeds (token now used).
    const first = await svc.refreshByToken(created.refresh.token, "idem-1");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const newHash = sha256Hex(first.minted.refresh.token);

    // Replay the ORIGINAL (now-used) token with a DIFFERENT idem key → reuse detected.
    const replay = await svc.refreshByToken(created.refresh.token, "idem-2");
    expect(replay).toEqual({ ok: false, reason: "reuse_detected" });

    // The entire family is revoked: both hashes + the family set + the session gone.
    expect(redis.store.has(`refresh:${sha256Hex(created.refresh.token)}`)).toBe(false);
    expect(redis.store.has(`refresh:${newHash}`)).toBe(false);
    expect(redis.sets.has(`refresh_family:${familyId}`)).toBe(false);

    // Exactly one PII-free reuse event with ONLY worker_id + family_id.
    const reuse = emit.mock.calls
      .map((c) => c[0] as { event_name: string; payload: Record<string, unknown> })
      .find((e) => e.event_name === "worker.refresh_reuse_detected");
    expect(reuse).toBeDefined();
    expect(Object.keys(reuse!.payload).sort()).toEqual(["family_id", "worker_id"].sort());
    expect(reuse!.payload.worker_id).toBe("worker-1");
    // No token value / phone anywhere in the event.
    expect(JSON.stringify(reuse)).not.toContain(created.refresh.token);
    expect(JSON.stringify(reuse)).not.toContain(first.minted.refresh.token);
  });
});

describe("SessionService.refreshByToken — IDEMPOTENCY GRACE", () => {
  it("the same idem key replays the SAME minted result, NO rotation, NO reuse flag", async () => {
    const { svc, redis, emit } = setup();
    const created = await svc.create("worker-1");

    const first = await svc.refreshByToken(created.refresh.token, "idem-1");
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const storeSizeAfterFirst = redis.store.size;

    // Replay with the SAME idem key → identical result, no new token, no reuse event.
    const second = await svc.refreshByToken(created.refresh.token, "idem-1");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.minted.refresh.token).toBe(first.minted.refresh.token);
    expect(second.minted.access.token).toBe(first.minted.access.token);

    // No second rotation occurred (store didn't grow with a new refresh record).
    expect(redis.store.size).toBe(storeSizeAfterFirst);

    // The family was NOT revoked and NO reuse event was emitted.
    const reuse = emit.mock.calls.find(
      (c) => (c[0] as { event_name: string }).event_name === "worker.refresh_reuse_detected",
    );
    expect(reuse).toBeUndefined();
  });
});

describe("SessionService.revoke / revokeAll", () => {
  it("revoke deletes the session record and drops it from the worker set", async () => {
    const { svc, redis, jwt } = setup();
    await svc.create("worker-1");
    const sid = jwt.lastSigned!.sid;
    expect(redis.store.has(`session:${sid}`)).toBe(true);
    await svc.revoke(sid, "worker-1");
    expect(redis.store.has(`session:${sid}`)).toBe(false);
    expect(redis.sets.get("worker_sessions:worker-1")?.has(sid)).toBeFalsy();
  });

  it("revokeAll deletes every session, clears the set, returns the count, emits the event", async () => {
    const { svc, redis, jwt, emit } = setup();
    await svc.create("worker-1");
    const sid1 = jwt.lastSigned!.sid;
    await svc.create("worker-1");
    const sid2 = jwt.lastSigned!.sid;
    expect(sid1).not.toBe(sid2);

    const count = await svc.revokeAll("worker-1");
    expect(count).toBe(2);
    expect(redis.store.has(`session:${sid1}`)).toBe(false);
    expect(redis.store.has(`session:${sid2}`)).toBe(false);
    expect(redis.sets.has("worker_sessions:worker-1")).toBe(false);
    expect(redis.sets.has("worker_families:worker-1")).toBe(false);

    const ev = emit.mock.calls
      .map((c) => c[0] as { event_name: string; payload: Record<string, unknown> })
      .find((e) => e.event_name === "worker.logged_out_all");
    expect(ev).toBeDefined();
    expect(Object.keys(ev!.payload).sort()).toEqual(["sessions_revoked", "worker_id"].sort());
    expect(ev!.payload).toEqual({ worker_id: "worker-1", sessions_revoked: 2 });
  });

  // ADR-0034 D5b.3 — REGRESSION LOCK. revokeAll used to kill only Redis sessions,
  // leaving device rows active with live push tokens. So a worker who hit "log out
  // everywhere" because their handset was STOLEN left that handset receiving every
  // future push, indefinitely. The panic button has to stop delivery too.
  it("revokeAll REVOKES the device rows — the panic button stops push, not just sessions", async () => {
    const devices = {
      revokeAllForWorker: vi.fn().mockResolvedValue([{ id: "device-1" }, { id: "device-2" }]),
    };
    const push = { enqueue: vi.fn().mockResolvedValue(undefined) };
    const { svc } = setup({ devices, push });

    await svc.revokeAll("worker-1");

    expect(devices.revokeAllForWorker).toHaveBeenCalledWith("worker-1");
    // ...and warns exactly those devices. This is the ONE case allowed to target
    // just-revoked devices, because telling them is the entire point of the alert.
    expect(push.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        workerId: "worker-1",
        eventName: "worker.logged_out_all",
        deviceIds: ["device-1", "device-2"],
      }),
    );
  });

  it("revokeAll: a device-revoke failure never fails the logout itself", async () => {
    const devices = {
      revokeAllForWorker: vi.fn().mockRejectedValue(new Error("db down")),
    };
    const push = { enqueue: vi.fn() };
    const { svc } = setup({ devices, push });
    await svc.create("worker-1");

    // Must still resolve — signing out is more important than the courtesy alert.
    await expect(svc.revokeAll("worker-1")).resolves.toBe(1);
    expect(push.enqueue).not.toHaveBeenCalled();
  });

  it("revokeAll with no devices enqueues nothing", async () => {
    const push = { enqueue: vi.fn() };
    const { svc } = setup({ devices: { revokeAllForWorker: vi.fn().mockResolvedValue([]) }, push });
    await svc.revokeAll("worker-1");
    expect(push.enqueue).not.toHaveBeenCalled();
  });
});

// FIX 1 (CRITICAL) — a deliberate logout/logout-all must kill the refresh lineage so a
// replayed (un-rotated) refresh token cannot RESURRECT the session. Live even gate-OFF.
describe("SessionService — logout kills refresh tokens (no resurrection)", () => {
  it("revokeAll(worker) ⇒ that worker's refresh token is invalid (no resurrection)", async () => {
    const { svc, redis } = setup();
    const created = await svc.create("worker-1");
    // The refresh record exists before logout-all.
    expect(redis.store.has(`refresh:${sha256Hex(created.refresh.token)}`)).toBe(true);

    await svc.revokeAll("worker-1");

    // The refresh record is GONE → a replay hits the `!raw` guard → invalid (401).
    expect(redis.store.has(`refresh:${sha256Hex(created.refresh.token)}`)).toBe(false);
    const out = await svc.refreshByToken(created.refresh.token, "idem-after-logoutall");
    expect(out).toEqual({ ok: false, reason: "invalid" });
  });

  it("revoke(sid, worker) ⇒ that session's family refresh token is invalid", async () => {
    const { svc, redis, jwt } = setup();
    const created = await svc.create("worker-1");
    const sid = jwt.lastSigned!.sid;

    await svc.revoke(sid, "worker-1");

    expect(redis.store.has(`session:${sid}`)).toBe(false);
    expect(redis.store.has(`refresh:${sha256Hex(created.refresh.token)}`)).toBe(false);
    const out = await svc.refreshByToken(created.refresh.token, "idem-after-logout");
    expect(out).toEqual({ ok: false, reason: "invalid" });
  });

  // RESIDUAL (gate-OFF, no absolute cap): the lineage SETS are the index logout-all reaps
  // refresh tokens through. Before the fix they were armed ONLY at create() (to absoluteMax)
  // and never re-armed, so a worker who kept rotating past that TTL would let the sets
  // expire while the refresh records (re-armed each rotation) stayed alive — logout-all then
  // iterated an EMPTY set and a stolen token SURVIVED (resurrection). The fix re-arms BOTH
  // sets to refreshTtl on EVERY rotation, so they always outlive the refresh records.

  it("rotation re-arms BOTH lineage sets to refreshTtl (not absoluteMax) — they outlive the refresh records", async () => {
    const REFRESH_TTL = 90 * 86400;
    const { svc, redis } = setup(); // gate OFF (default)
    const created = await svc.create("worker-1");

    // Create already arms to refreshTtl; prove a ROTATION re-arms it (the key fix), by
    // first scrambling the recorded TTLs and confirming rotation restores them.
    redis.ttls.set("worker_families:worker-1", 1);
    redis.ttls.set("worker_sessions:worker-1", 1);

    const rotated = await svc.refreshByToken(created.refresh.token, "idem-rot");
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;

    // Re-armed to refreshTtl on rotation — and refreshTtl >= absoluteMax (boot guard), so
    // the sets can never expire before the refresh records they index.
    expect(redis.ttls.get("worker_families:worker-1")).toBe(REFRESH_TTL);
    expect(redis.ttls.get("worker_sessions:worker-1")).toBe(REFRESH_TTL);
  });

  it("after a rotation, logout-all reaps the ROTATED (long-rotating) token ⇒ replay invalid", async () => {
    const { svc, redis } = setup(); // gate OFF
    const created = await svc.create("worker-1");
    const rotated = await svc.refreshByToken(created.refresh.token, "idem-rot");
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;

    // The rotated token is live and indexed by the (re-armed) lineage sets.
    const liveHash = sha256Hex(rotated.minted.refresh.token);
    expect(redis.store.has(`refresh:${liveHash}`)).toBe(true);
    expect(redis.sets.get("worker_families:worker-1")!.size).toBeGreaterThan(0);

    await svc.revokeAll("worker-1");

    // logout-all reaped it (the sets were alive because rotation re-armed them) → replay 401.
    expect(redis.store.has(`refresh:${liveHash}`)).toBe(false);
    const replay = await svc.refreshByToken(rotated.minted.refresh.token, "idem-after-logoutall-2");
    expect(replay).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("SessionService tiered behavior (gate ON)", () => {
  it("create returns a non-null requires_otp_after (absolute cap) when tiers are ON", async () => {
    const { svc } = setup({ config: { AUTH_ROLLING_TIERS_ENABLED: true } });
    const res = await svc.create("worker-1");
    expect(res.session.requiresOtpAfterMs).not.toBeNull();
    // The cap is ~90d out.
    expect(res.session.requiresOtpAfterMs! - Date.now()).toBeGreaterThan(89 * 86400 * 1000);
  });

  it("describe returns tier + a null requires_otp_after when the gate is OFF", async () => {
    const { svc, jwt } = setup();
    await svc.create("worker-1");
    const sid = jwt.lastSigned!.sid;
    const view = await svc.describe("worker-1", sid);
    expect(view).not.toBeNull();
    expect(view!.tier).toBe(0);
    expect(view!.requiresOtpAfterMs).toBeNull();
  });
});

// FIX 2 (HIGH) — the 90d absolute cap is anchored to the ORIGINAL OTP and must NOT reset
// on a lapse-then-refresh. Simulate the session record absent (idle TTL lapsed) while the
// refresh record is still present, with an OTP anchor in the past.
describe("SessionService — absolute cap is NOT resettable without OTP (gate ON)", () => {
  const DAY = 86_400_000;

  /** Backdate a refresh record's OTP anchor + delete the session to simulate a lapse. */
  function lapseWithAnchor(redis: ReturnType<typeof makeRedis>, refreshToken: string, anchorMs: number) {
    const key = `refresh:${sha256Hex(refreshToken)}`;
    const rec = JSON.parse(redis.store.get(key)!);
    rec.created_via_otp_at_ms = anchorMs;
    redis.store.set(key, JSON.stringify(rec));
    // Simulate the session idle-TTL lapse: drop the session record only.
    redis.store.delete(`session:${rec.sid}`);
  }

  it("lapse-then-refresh PAST the absolute cap ⇒ requires_otp (forces OTP)", async () => {
    const { svc, redis } = setup({ config: { AUTH_ROLLING_TIERS_ENABLED: true } });
    const created = await svc.create("worker-1");
    // Backdate the OTP anchor to 91 days ago (past the 90d cap) and lapse the session.
    lapseWithAnchor(redis, created.refresh.token, Date.now() - 91 * DAY);

    const out = await svc.refreshByToken(created.refresh.token, "idem-cap");
    expect(out).toEqual({ ok: false, reason: "requires_otp" });
  });

  it("lapse-then-refresh WITHIN the cap re-anchors to the ORIGINAL OTP (cap not reset)", async () => {
    const { svc, redis } = setup({ config: { AUTH_ROLLING_TIERS_ENABLED: true } });
    const created = await svc.create("worker-1");
    // Backdate to 80 days ago (still inside the 90d cap) and lapse the session.
    const anchorMs = Date.now() - 80 * DAY;
    lapseWithAnchor(redis, created.refresh.token, anchorMs);

    const out = await svc.refreshByToken(created.refresh.token, "idem-within");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // The absolute cap is still ~10 days out (anchor + 90d), NOT ~90 days (would be a reset).
    const remainingMs = out.minted.session.requiresOtpAfterMs! - Date.now();
    expect(remainingMs).toBeLessThan(11 * DAY);
    expect(remainingMs).toBeGreaterThan(9 * DAY);
  });
});

// FIX 3 (MEDIUM) — the idempotency cache must NOT store the bearer secrets in plaintext.
describe("SessionService — idempotency cache is encrypted at rest", () => {
  it("refresh_idem:* value is ciphertext and contains no plaintext refresh/access token", async () => {
    const { svc, redis } = setup();
    const created = await svc.create("worker-1");
    const out = await svc.refreshByToken(created.refresh.token, "idem-enc");
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const idemKey = [...redis.store.keys()].find((k) => k.startsWith("refresh_idem:"));
    expect(idemKey).toBeDefined();
    const stored = redis.store.get(idemKey!)!;
    // The at-rest blob is the encrypted envelope, not the plaintext minted JSON.
    expect(stored.startsWith("enc(")).toBe(true);
    expect(stored).not.toContain(out.minted.refresh.token);
    expect(stored).not.toContain(out.minted.access.token);
    // And no plaintext bearer secret appears anywhere at rest.
    const allValues = JSON.stringify([...redis.store.values()]);
    expect(allValues).not.toContain(out.minted.refresh.token);
    expect(allValues).not.toContain(out.minted.access.token);
  });
});

describe("SessionService device binding (ADR-0026 Phase 2)", () => {
  it("create(workerId, deviceId) signs `did` into the JWT + stores device_id on the session and refresh records", async () => {
    const { svc, redis, jwt } = setup();
    const res = await svc.create("worker-1", "device-abc");

    expect((jwt.lastSigned as unknown as Record<string, unknown>).did).toBe("device-abc");

    const sid = jwt.lastSigned!.sid;
    const stored = JSON.parse(redis.store.get(`session:${sid}`)!);
    expect(stored.device_id).toBe("device-abc");

    const refreshRec = JSON.parse(redis.store.get(`refresh:${sha256Hex(res.refresh.token)}`)!);
    expect(refreshRec.device_id).toBe("device-abc");
  });

  it("create() WITHOUT a deviceId keeps the legacy {sub, sid} token shape (no did) — back-compat", async () => {
    const { svc, jwt } = setup();
    await svc.create("worker-1");
    expect((jwt.lastSigned as unknown as Record<string, unknown>).did).toBeUndefined();
  });

  it("revokeByDevice kills ONLY the sessions bound to that device (the other device survives)", async () => {
    const { svc, redis } = setup();
    const a = await svc.create("worker-1", "deviceA");
    const b = await svc.create("worker-1", "deviceB");
    const sidA = a.access.token.split(".")[2]!;
    const sidB = b.access.token.split(".")[2]!;
    const hashA = sha256Hex(a.refresh.token);
    const hashB = sha256Hex(b.refresh.token);

    const n = await svc.revokeByDevice("worker-1", "deviceA");

    expect(n).toBe(1);
    // deviceA's session + its refresh token are gone (no resurrection).
    expect(redis.store.has(`session:${sidA}`)).toBe(false);
    expect(redis.store.has(`refresh:${hashA}`)).toBe(false);
    expect(redis.sets.get("worker_sessions:worker-1")!.has(sidA)).toBe(false);
    // deviceB's session + refresh token are untouched.
    expect(redis.store.has(`session:${sidB}`)).toBe(true);
    expect(redis.store.has(`refresh:${hashB}`)).toBe(true);
    expect(redis.sets.get("worker_sessions:worker-1")!.has(sidB)).toBe(true);
  });

  it("revokeByDevice revokes nothing (returns 0) when no live session is bound to that device", async () => {
    const { svc, redis } = setup();
    const a = await svc.create("worker-1", "deviceA");
    const sidA = a.access.token.split(".")[2]!;
    const n = await svc.revokeByDevice("worker-1", "deviceZ");
    expect(n).toBe(0);
    expect(redis.store.has(`session:${sidA}`)).toBe(true);
  });

  it("revokeByDevice ALSO cuts a device whose session record idle-LAPSED but still holds a live refresh token (no resurrection)", async () => {
    const { svc, redis } = setup();
    const a = await svc.create("worker-1", "deviceA");
    const sidA = a.access.token.split(".")[2]!;
    const familyA = JSON.parse(redis.store.get(`session:${sidA}`)!).family_id;
    const hashA = sha256Hex(a.refresh.token);

    // Simulate the session record idle-lapsing while its refresh token is still valid +
    // unused — the family set, worker_families membership, and refresh token all survive.
    redis.store.delete(`session:${sidA}`);
    expect(redis.store.has(`refresh:${hashA}`)).toBe(true);

    const n = await svc.revokeByDevice("worker-1", "deviceA");

    // Driven off worker_families (not the live-session set), the lapsed-but-refreshable
    // device is still caught: its refresh token is deleted, so it can never re-mint a
    // session on the just-revoked device. This is the durability gap the family-driven
    // sweep closes (a session-set-driven sweep would have skipped the lapsed record).
    expect(n).toBe(1);
    expect(redis.store.has(`refresh:${hashA}`)).toBe(false);
    expect(redis.sets.get("worker_families:worker-1")!.has(familyA)).toBe(false);
  });
});
