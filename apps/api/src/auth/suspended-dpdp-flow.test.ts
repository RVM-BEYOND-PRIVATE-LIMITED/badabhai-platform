import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { AuthService } from "./auth.service";
import { SessionService } from "./session.service";
import { WorkerAuthGuard } from "./worker-auth.guard";
import { AuthController } from "./auth.controller";
import {
  WorkerAccountSuspendedException,
  WORKER_ACCOUNT_SUSPENDED_CODE,
} from "./worker-account-deleted.exception";

/**
 * #2562 — the DPDP flow end to end, without HTTP:
 *
 *   suspended worker → OTP verify → 403 + restricted token → account-delete request passes
 *   the real guard → every other worker route is refused → refresh is refused.
 *
 * The services and the guard are REAL; only the storage/collaborator doubles are in-memory.
 * This is the test that proves ruling (a) is reachable, not merely a decorated guard method.
 */

const CONFIG = {
  SESSION_TTL_DAYS: 30,
  AUTH_ROLLING_TIERS_ENABLED: false,
  AUTH_SESSION_ABSOLUTE_MAX_DAYS: 90,
  AUTH_TIER_WINDOW_DAYS: 60,
  AUTH_REFRESH_TTL_DAYS: 90,
} as unknown as ServerConfig;

const WORKER_ID = "11111111-1111-4111-8111-111111111111";
const PHONE = "+919876500000";
const CTX = { correlationId: "22222222-2222-4222-8222-222222222222", requestId: "dpdp-e2e" };

function makeRedis() {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  return {
    store,
    sets,
    client: {
      async set(key: string, value: string, ...rest: unknown[]) {
        if (rest[0] === "NX" && store.has(key)) return null;
        store.set(key, value);
        return "OK";
      },
      async get(key: string) {
        return store.get(key) ?? null;
      },
      async del(...keys: string[]) {
        let n = 0;
        for (const k of keys) if (store.delete(k) || sets.delete(k)) n += 1;
        return n;
      },
      async expire(key: string, _sec: number) {
        return store.has(key) || sets.has(key) ? 1 : 0;
      },
      async sadd(key: string, ...members: string[]) {
        const s = sets.get(key) ?? new Set<string>();
        members.forEach((m) => s.add(m));
        sets.set(key, s);
        return members.length;
      },
      async srem() {
        return 0;
      },
      async smembers(key: string) {
        return [...(sets.get(key) ?? [])];
      },
    },
  };
}

function makeCtx(authHeader: string, handler: object) {
  const headers: Record<string, string> = { authorization: authHeader };
  const req: { header: (n: string) => string | undefined; worker?: { id: string; scope?: string } } =
    { header: (n) => headers[n.toLowerCase()] };
  const res = { setHeader: vi.fn() };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    getHandler: () => handler,
  } as unknown as ExecutionContext;
  return { ctx, req };
}

describe("#2562 — suspended DPDP flow", () => {
  it("issues a restricted token that opens only the DPDP exits", async () => {
    const redis = makeRedis();
    const queue = { client: Promise.resolve(redis.client) } as unknown as Queue;
    const jwt = new JwtService({
      secret: "suspended-dpdp-flow-secret",
      signOptions: { algorithm: "HS256" },
    });
    const session = new SessionService(
      CONFIG,
      jwt,
      { emit: vi.fn(async () => ({ event_id: "e" })) } as never,
      { encrypt: (v: string) => v, decrypt: (v: string) => v } as never,
      queue,
      { revokeAllForWorker: vi.fn(async () => []) } as never,
      { enqueue: vi.fn(async () => undefined) } as never,
    );

    const auth = new AuthService(
      { emit: vi.fn(async () => undefined) } as never,
      {
        findByPhoneHash: vi.fn(async () => ({
          id: WORKER_ID,
          status: "suspended",
          deletionScheduledAt: null,
        })),
        createOrGetByPhoneHash: vi.fn(),
      } as never,
      { hashPhone: () => "phone-hash" } as never,
      { verify: vi.fn(async () => undefined) } as never,
      session,
      { registerOnLogin: vi.fn() } as never,
      { findByWorkerId: vi.fn(async () => undefined) } as never,
    );

    const err = (await auth
      .verifyOtp(PHONE, "123456", CTX)
      .catch((e: unknown) => e)) as WorkerAccountSuspendedException;
    expect(err).toBeInstanceOf(WorkerAccountSuspendedException);
    const body = err.getResponse() as {
      code: string;
      restricted_token?: string;
      restricted_expires_in_seconds?: number;
    };
    expect(body.code).toBe(WORKER_ACCOUNT_SUSPENDED_CODE);
    expect(body.restricted_expires_in_seconds).toBe(900);
    expect(body.restricted_token).toBeTruthy();
    const token = body.restricted_token!;

    const guard = new WorkerAuthGuard(
      session,
      CONFIG,
      { findLatestByWorker: vi.fn(async () => undefined) } as never,
      {
        findSelfView: vi.fn(async () => ({
          status: "suspended",
          deletionScheduledAt: null,
        })),
      } as never,
    );

    // DPDP exit: reaches the handler.
    const allowed = makeCtx(`Bearer ${token}`, AuthController.prototype.accountDeleteRequest);
    await expect(guard.canActivate(allowed.ctx)).resolves.toBe(true);
    expect(allowed.req.worker).toMatchObject({ id: WORKER_ID, scope: "suspended_dpdp" });

    // Any other worker route: neutral 401.
    const refused = makeCtx(`Bearer ${token}`, AuthController.prototype.me);
    await expect(guard.canActivate(refused.ctx)).rejects.toBeInstanceOf(UnauthorizedException);

    // Refresh: no refresh family exists, and the legacy refresh refuses a restricted token.
    await expect(session.refresh(token)).resolves.toBeNull();
    await expect(session.refreshByToken(token, "idem-dpdp")).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });
  });
});
