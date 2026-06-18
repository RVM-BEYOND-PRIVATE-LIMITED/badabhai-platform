import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { PayerSessionService } from "./payer-session.service";
import { PayerAuthGuard } from "./payer-auth.guard";

const config = { SESSION_TTL_DAYS: 30 } as unknown as ServerConfig;
const FULL_TTL = 30 * 86400;

function makeCtx(authHeader?: string) {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) headers["authorization"] = authHeader;
  const req: {
    header: (name: string) => string | undefined;
    payer?: { id: string; sid: string };
  } = {
    header: (name: string) => headers[name.toLowerCase()],
  };
  const setHeader = vi.fn();
  const res = { setHeader };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
  return { ctx, req, setHeader };
}

function makeSession(
  validateResult: { payerId: string; sid: string; remainingSeconds: number } | null,
) {
  return {
    validateAndTouch: vi.fn().mockResolvedValue(validateResult),
    mint: vi.fn().mockResolvedValue({ token: "fresh.jwt", expiresInSeconds: FULL_TTL }),
  } as unknown as PayerSessionService;
}

describe("PayerAuthGuard", () => {
  it("throws 401 when there is no Authorization header", async () => {
    const guard = new PayerAuthGuard(makeSession({ payerId: "p1", sid: "s1", remainingSeconds: FULL_TTL }), config);
    await expect(guard.canActivate(makeCtx(undefined).ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("throws 401 when the scheme is not Bearer", async () => {
    const guard = new PayerAuthGuard(makeSession({ payerId: "p1", sid: "s1", remainingSeconds: FULL_TTL }), config);
    await expect(guard.canActivate(makeCtx("Basic abc").ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("throws 401 when the payer session is invalid (validateAndTouch null) — e.g. a worker token", async () => {
    const guard = new PayerAuthGuard(makeSession(null), config);
    await expect(guard.canActivate(makeCtx("Bearer worker.or.bad.token").ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("attaches req.payer on a valid token and does NOT refresh when fresh", async () => {
    const session = makeSession({ payerId: "p1", sid: "s1", remainingSeconds: FULL_TTL });
    const guard = new PayerAuthGuard(session, config);
    const { ctx, req, setHeader } = makeCtx("Bearer good.token");
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.payer).toEqual({ id: "p1", sid: "s1" });
    expect(setHeader).not.toHaveBeenCalled();
    expect(session.mint).not.toHaveBeenCalled();
  });

  it("sets x-session-token past the half-life (rolling refresh)", async () => {
    const session = makeSession({ payerId: "p1", sid: "s1", remainingSeconds: FULL_TTL / 2 - 1 });
    const guard = new PayerAuthGuard(session, config);
    const { ctx, setHeader } = makeCtx("Bearer aging.token");
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(session.mint).toHaveBeenCalledWith("p1", "s1");
    expect(setHeader).toHaveBeenCalledWith("x-session-token", "fresh.jwt");
  });
});
