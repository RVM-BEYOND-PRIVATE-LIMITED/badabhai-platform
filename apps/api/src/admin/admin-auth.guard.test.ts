import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { AdminSessionService } from "./admin-session.service";
import { AdminAuthGuard } from "./admin-auth.guard";

const ADMIN_SECRET = "admin-secret-distinct-from-worker-and-payer";
const WORKER_PAYER_SECRET = "the-worker-and-payer-jwt-secret";
const ADMIN_ID = "aaaaaaaa-0000-4000-8000-000000000001";

const config = { SESSION_TTL_DAYS: 30 } as unknown as ServerConfig;

/** An in-memory Redis stub holding the admin session records. */
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
      async expire() {
        return 1;
      },
    },
  };
}

function makeSessionService(secret: string) {
  const redis = makeRedis();
  const queue = { client: Promise.resolve(redis.client) } as unknown as Queue;
  const jwt = new JwtService({ secret, signOptions: { algorithm: "HS256" } });
  return { svc: new AdminSessionService(config, jwt, queue), jwt, redis };
}

/** Build a request ExecutionContext with the given Authorization header. */
function ctxWithAuth(header: string | undefined): {
  ctx: ExecutionContext;
  res: { setHeader: ReturnType<typeof vi.fn> };
} {
  const res = { setHeader: vi.fn() };
  const req = { header: (name: string) => (name === "authorization" ? header : undefined) };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
  return { ctx, res };
}

describe("AdminSessionService — audience pin + own namespace (horizontal isolation)", () => {
  it("a minted admin token validates and carries the role (round-trip)", async () => {
    const { svc } = makeSessionService(ADMIN_SECRET);
    const { token } = await svc.create(ADMIN_ID, "super_admin");
    const v = await svc.validateAndTouch(token);
    expect(v).toMatchObject({ adminId: ADMIN_ID, role: "super_admin" });
  });

  it("REJECTS a token signed with the WORKER/PAYER secret (wrong signature → null)", async () => {
    // A token that LOOKS like an admin token (typ:"admin") but is signed with the worker/payer
    // secret must not validate — the admin session uses its OWN secret.
    const foreignJwt = new JwtService({ secret: WORKER_PAYER_SECRET, signOptions: { algorithm: "HS256" } });
    const forged = await foreignJwt.signAsync({ sub: ADMIN_ID, sid: "s", typ: "admin", role: "super_admin" });
    const { svc } = makeSessionService(ADMIN_SECRET);
    expect(await svc.validateAndTouch(forged)).toBeNull();
  });

  it("REJECTS a worker/payer-shaped token (typ != 'admin') even if signed with the admin secret", async () => {
    // Audience pin: a token without typ:"admin" (e.g. a worker token shape) never satisfies the
    // admin session, even under the admin signature.
    const { svc, jwt } = makeSessionService(ADMIN_SECRET);
    const workerShaped = await jwt.signAsync({ sub: ADMIN_ID, sid: "s", typ: "worker" });
    expect(await svc.validateAndTouch(workerShaped)).toBeNull();
    const payerShaped = await jwt.signAsync({ sub: ADMIN_ID, sid: "s", typ: "payer", role: "agent" });
    expect(await svc.validateAndTouch(payerShaped)).toBeNull();
  });

  it("REJECTS a valid token whose Redis session record is gone (revoked/expired → null)", async () => {
    const { svc, redis } = makeSessionService(ADMIN_SECRET);
    const { token } = await svc.create(ADMIN_ID, "ops_admin");
    redis.store.clear(); // simulate revoke / TTL expiry
    expect(await svc.validateAndTouch(token)).toBeNull();
  });

  it("revoke deletes the record so the token no longer validates", async () => {
    const { svc } = makeSessionService(ADMIN_SECRET);
    const { token } = await svc.create(ADMIN_ID, "ops_admin");
    const v = await svc.validateAndTouch(token);
    await svc.revoke(v!.sid);
    expect(await svc.validateAndTouch(token)).toBeNull();
  });
});

describe("AdminAuthGuard — fail closed", () => {
  it("ALLOWS a request bearing a valid admin token and attaches req.admin", async () => {
    const { svc } = makeSessionService(ADMIN_SECRET);
    const { token } = await svc.create(ADMIN_ID, "support");
    const guard = new AdminAuthGuard(svc, config);
    const { ctx } = ctxWithAuth(`Bearer ${token}`);
    expect(await guard.canActivate(ctx)).toBe(true);
  });

  it("REJECTS (401) a missing Authorization header", async () => {
    const { svc } = makeSessionService(ADMIN_SECRET);
    const guard = new AdminAuthGuard(svc, config);
    const { ctx } = ctxWithAuth(undefined);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("REJECTS (401) a malformed Authorization header (not Bearer)", async () => {
    const { svc } = makeSessionService(ADMIN_SECRET);
    const guard = new AdminAuthGuard(svc, config);
    const { ctx } = ctxWithAuth("Basic abc");
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("REJECTS (401) a token signed with the worker/payer secret (horizontal isolation at the guard)", async () => {
    const foreignJwt = new JwtService({ secret: WORKER_PAYER_SECRET, signOptions: { algorithm: "HS256" } });
    const forged = await foreignJwt.signAsync({ sub: ADMIN_ID, sid: "s", typ: "admin", role: "super_admin" });
    const { svc } = makeSessionService(ADMIN_SECRET);
    const guard = new AdminAuthGuard(svc, config);
    const { ctx } = ctxWithAuth(`Bearer ${forged}`);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
