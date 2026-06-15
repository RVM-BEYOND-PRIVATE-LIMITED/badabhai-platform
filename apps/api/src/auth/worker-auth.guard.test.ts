import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { SessionService } from "./session.service";
import { WorkerAuthGuard } from "./worker-auth.guard";

const config = { SESSION_TTL_DAYS: 30 } as unknown as ServerConfig;
const FULL_TTL = 30 * 86400;

/** Build an ExecutionContext whose request carries the given auth header. */
function makeCtx(authHeader?: string) {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) headers["authorization"] = authHeader;
  const req: {
    header: (name: string) => string | undefined;
    worker?: { id: string; sid: string };
  } = {
    header: (name: string) => headers[name.toLowerCase()],
  };
  const setHeader = vi.fn();
  const res = { setHeader };
  const ctx = {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as unknown as ExecutionContext;
  return { ctx, req, setHeader };
}

function makeSession(
  validateResult: { workerId: string; sid: string; remainingSeconds: number } | null,
) {
  return {
    validateAndTouch: vi.fn().mockResolvedValue(validateResult),
    mint: vi.fn().mockResolvedValue({ token: "fresh.jwt", expiresInSeconds: FULL_TTL }),
  } as unknown as SessionService;
}

describe("WorkerAuthGuard", () => {
  it("throws 401 when there is no Authorization header", async () => {
    const session = makeSession({ workerId: "w1", sid: "s1", remainingSeconds: FULL_TTL });
    const guard = new WorkerAuthGuard(session, config);
    const { ctx } = makeCtx(undefined);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("throws 401 when the scheme is not Bearer", async () => {
    const session = makeSession({ workerId: "w1", sid: "s1", remainingSeconds: FULL_TTL });
    const guard = new WorkerAuthGuard(session, config);
    const { ctx } = makeCtx("Basic abc");
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("throws 401 when the token is invalid (validateAndTouch null)", async () => {
    const session = makeSession(null);
    const guard = new WorkerAuthGuard(session, config);
    const { ctx } = makeCtx("Bearer bad.token");
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("attaches req.worker on a valid token and does NOT refresh when fresh", async () => {
    const session = makeSession({ workerId: "w1", sid: "s1", remainingSeconds: FULL_TTL });
    const guard = new WorkerAuthGuard(session, config);
    const { ctx, req, setHeader } = makeCtx("Bearer good.token");
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.worker).toEqual({ id: "w1", sid: "s1" });
    expect(setHeader).not.toHaveBeenCalled();
    expect(session.mint).not.toHaveBeenCalled();
  });

  it("sets x-session-token when the token is past its half-life (rolling refresh)", async () => {
    // remainingSeconds below half the full TTL → mint a fresh token.
    const session = makeSession({ workerId: "w1", sid: "s1", remainingSeconds: FULL_TTL / 2 - 1 });
    const guard = new WorkerAuthGuard(session, config);
    const { ctx, setHeader } = makeCtx("Bearer aging.token");
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(session.mint).toHaveBeenCalledWith("w1", "s1");
    expect(setHeader).toHaveBeenCalledWith("x-session-token", "fresh.jwt");
  });
});
