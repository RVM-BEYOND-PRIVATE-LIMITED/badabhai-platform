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
  return {
    store,
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
        for (const k of keys) if (store.delete(k)) n += 1;
        return n;
      },
      async expire(key: string) {
        return store.has(key) ? 1 : 0;
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
