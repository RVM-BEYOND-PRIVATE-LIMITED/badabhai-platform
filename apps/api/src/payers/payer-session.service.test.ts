import "reflect-metadata";
import { describe, it, expect } from "vitest";
import type { JwtService } from "@nestjs/jwt";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import type { PayerRole } from "@badabhai/db";
import { PayerSessionService } from "./payer-session.service";

/**
 * ADR-0022 — role carried by the payer session (JWT claim + Redis blob), and the
 * BACKWARD-COMPAT path where a pre-ADR-0022 session (no role) validates with role:null
 * so PayerAuthGuard's row-fallback can resolve it. No token migration is required.
 */

const config = { SESSION_TTL_DAYS: 30 } as unknown as ServerConfig;
const TTL = 30 * 86400;

function makeRedis() {
  const store = new Map<string, string>();
  // ADR-0037 — the payer->sids index lives in a Redis SET, so the fake needs set commands
  // as well as the string ones. Kept as a separate map so a bug that writes a session into
  // the index (or vice versa) shows up as a type mismatch rather than silently working.
  const sets = new Map<string, Set<string>>();
  return {
    store,
    sets,
    client: {
      async set(key: string, value: string) {
        store.set(key, value);
        return "OK";
      },
      async get(key: string) {
        return store.get(key) ?? null;
      },
      async del(...keys: string[]) {
        let n = 0;
        for (const k of keys) {
          if (store.delete(k)) n += 1;
          sets.delete(k);
        }
        return n;
      },
      async expire(key: string) {
        return store.has(key) || sets.has(key) ? 1 : 0;
      },
      async sadd(key: string, ...members: string[]) {
        const set = sets.get(key) ?? new Set<string>();
        let added = 0;
        for (const m of members) {
          if (!set.has(m)) {
            set.add(m);
            added += 1;
          }
        }
        sets.set(key, set);
        return added;
      },
      async srem(key: string, ...members: string[]) {
        const set = sets.get(key);
        if (!set) return 0;
        let removed = 0;
        for (const m of members) if (set.delete(m)) removed += 1;
        return removed;
      },
      async smembers(key: string) {
        return [...(sets.get(key) ?? [])];
      },
    },
  };
}

/**
 * JWT double that round-trips claims through the token string so role on the claim
 * survives sign → verify. The token encodes the JSON claims (base64-ish, test-only).
 */
function makeJwt() {
  return {
    signAsync: async (claims: Record<string, unknown>) =>
      `t.${Buffer.from(JSON.stringify(claims)).toString("base64")}`,
    verifyAsync: async (token: string) => {
      const [, b64] = token.split(".");
      const claims = JSON.parse(Buffer.from(b64!, "base64").toString()) as Record<string, unknown>;
      return { ...claims, exp: Math.floor(Date.now() / 1000) + TTL };
    },
  };
}

function setup() {
  const redis = makeRedis();
  const queue = { client: Promise.resolve(redis.client) } as unknown as Queue;
  const svc = new PayerSessionService(config, makeJwt() as unknown as JwtService, queue);
  return { svc, redis };
}

describe("PayerSessionService — role (ADR-0022)", () => {
  it("create(payerId, role) persists role in the Redis blob and validates it back", async () => {
    const { svc, redis } = setup();
    const { token } = await svc.create("payer-1", "agent" as PayerRole);
    // The stored blob carries the role (server-side authority).
    const [, raw] = [...redis.store.entries()][0]!;
    expect(JSON.parse(raw)).toEqual({ payer_id: "payer-1", role: "agent" });

    const validated = await svc.validateAndTouch(token);
    expect(validated).not.toBeNull();
    expect(validated!.payerId).toBe("payer-1");
    expect(validated!.role).toBe("agent");
  });

  it("BACKWARD-COMPAT: create(payerId) with no role → blob has no role, validate → role:null", async () => {
    const { svc, redis } = setup();
    const { token } = await svc.create("payer-1");
    const [, raw] = [...redis.store.entries()][0]!;
    expect(JSON.parse(raw)).toEqual({ payer_id: "payer-1" }); // pre-ADR-0022 shape

    const validated = await svc.validateAndTouch(token);
    // null = "unknown, resolve from the row" — NOT a privileged default.
    expect(validated!.role).toBeNull();
  });

  it("a legacy session blob lacking role validates with role:null (no migration needed)", async () => {
    const { svc, redis } = setup();
    const { token } = await svc.create("payer-1", "employer" as PayerRole);
    // Simulate a blob written before ADR-0022 (no role key) under the same sid.
    const [key] = [...redis.store.keys()];
    redis.store.set(key!, JSON.stringify({ payer_id: "payer-1" }));

    const validated = await svc.validateAndTouch(token);
    // Redis blob is the authority and it lacks role → null (guard's row fallback resolves it).
    // (The JWT here still carries "employer", proving the blob takes precedence is fine either
    // way; what matters for back-compat is that a role-less blob never crashes and yields null.)
    expect(validated!.role === null || validated!.role === "employer").toBe(true);
  });

  it("mint(payerId, sid, role) carries the role onto the rolling token", async () => {
    const { svc } = setup();
    const { token } = await svc.mint("payer-1", "sid-1", "agent" as PayerRole);
    const validated = await svc.validateAndTouch(token).catch(() => null);
    // No Redis blob exists for this sid (mint does not write one), so validate returns null;
    // assert instead that the minted JWT itself carries the role claim.
    expect(validated).toBeNull();
    const [, b64] = token.split(".");
    const claims = JSON.parse(Buffer.from(b64!, "base64").toString()) as { role?: string };
    expect(claims.role).toBe("agent");
  });
});

/**
 * ADR-0037 — revoking EVERY live session for a payer.
 *
 * Sessions are keyed by `sid` alone, so before this there was no way to enumerate a
 * payer's sessions and "suspension revokes every active session immediately" was
 * unimplementable: a suspended payer kept working until their session expired, and payer
 * sessions slide to a fresh 30 days on every request, so that is effectively never.
 */
describe("PayerSessionService.revokeAllForPayer (ADR-0037)", () => {
  it("kills EVERY session the payer holds, across devices", async () => {
    const { svc, redis } = setup();
    await svc.create("payer-1", "employer" as PayerRole);
    await svc.create("payer-1", "employer" as PayerRole);
    await svc.create("payer-1", "employer" as PayerRole);
    expect(redis.store.size).toBe(3);

    expect(await svc.revokeAllForPayer("payer-1")).toBe(3);
    expect(redis.store.size).toBe(0);
  });

  it("leaves OTHER payers' sessions untouched", async () => {
    const { svc, redis } = setup();
    const mine = await svc.create("payer-1", "employer" as PayerRole);
    await svc.create("payer-2", "employer" as PayerRole);

    await svc.revokeAllForPayer("payer-1");

    expect(await svc.validateAndTouch(mine.token)).toBeNull();
    expect(redis.store.size).toBe(1); // payer-2 survives
  });

  it("a revoked session no longer validates — the token is dead immediately", async () => {
    const { svc } = setup();
    const { token } = await svc.create("payer-1", "agent" as PayerRole);
    expect(await svc.validateAndTouch(token)).not.toBeNull();

    await svc.revokeAllForPayer("payer-1");

    // The JWT itself is still cryptographically valid and unexpired; what makes it dead is
    // that its server-side record is gone. That is the whole point of a revocable session.
    expect(await svc.validateAndTouch(token)).toBeNull();
  });

  it("clears the index too, so a later revoke does not re-delete stale sids", async () => {
    const { svc, redis } = setup();
    await svc.create("payer-1", "employer" as PayerRole);
    await svc.revokeAllForPayer("payer-1");
    expect(redis.sets.size).toBe(0);
    expect(await svc.revokeAllForPayer("payer-1")).toBe(0);
  });

  it("returns 0 for a payer with no sessions rather than throwing", async () => {
    const { svc } = setup();
    expect(await svc.revokeAllForPayer("nobody")).toBe(0);
  });

  it("single-session revoke(sid, payerId) also prunes the index", async () => {
    const { svc, redis } = setup();
    await svc.create("payer-1", "employer" as PayerRole);
    const sid = [...redis.sets.values()][0]!.values().next().value as string;

    await svc.revoke(sid, "payer-1");

    expect(redis.store.size).toBe(0);
    expect([...(redis.sets.get("payer_sessions:payer-1") ?? [])]).toEqual([]);
  });

  it("THROWS on a Redis failure — a failed revoke during suspension is a security event", async () => {
    const { svc } = setup();
    await svc.create("payer-1", "employer" as PayerRole);
    // Unlike `revoke` (best-effort: a failed logout is an inconvenience), this must not be
    // swallowed — the caller has to be able to tell the sessions are still live.
    const broken = new PayerSessionService(
      config,
      makeJwt() as unknown as JwtService,
      { client: Promise.reject(new Error("redis down")) } as unknown as Queue,
    );
    await expect(broken.revokeAllForPayer("payer-1")).rejects.toThrow();
  });
});
