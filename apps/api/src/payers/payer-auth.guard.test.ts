import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { PayerRole } from "@badabhai/db";
import type { PayerSessionService } from "./payer-session.service";
import type { PayersRepository } from "./payers.repository";
import { PayerAuthGuard } from "./payer-auth.guard";

const config = { SESSION_TTL_DAYS: 30 } as unknown as ServerConfig;
const FULL_TTL = 30 * 86400;

/**
 * Repository stub for the ADR-0022 role fallback: `findById` returns a row carrying the
 * given role (or `undefined` to exercise the fail-closed → null path). Defaults to
 * "employer" so the default tests below don't depend on the fallback's row shape.
 */
function makeRepo(role: PayerRole | undefined = "employer") {
  const findById = vi.fn(async () => (role ? ({ id: "p1", role } as never) : undefined));
  return { findById } as unknown as PayersRepository;
}

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
  validateResult:
    | { payerId: string; sid: string; remainingSeconds: number; role?: PayerRole | null }
    | null,
) {
  return {
    validateAndTouch: vi.fn().mockResolvedValue(validateResult),
    mint: vi.fn().mockResolvedValue({ token: "fresh.jwt", expiresInSeconds: FULL_TTL }),
  } as unknown as PayerSessionService;
}

describe("PayerAuthGuard", () => {
  it("throws 401 when there is no Authorization header", async () => {
    const guard = new PayerAuthGuard(makeSession({ payerId: "p1", sid: "s1", remainingSeconds: FULL_TTL }), config, makeRepo());
    await expect(guard.canActivate(makeCtx(undefined).ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("throws 401 when the scheme is not Bearer", async () => {
    const guard = new PayerAuthGuard(makeSession({ payerId: "p1", sid: "s1", remainingSeconds: FULL_TTL }), config, makeRepo());
    await expect(guard.canActivate(makeCtx("Basic abc").ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("throws 401 when the payer session is invalid (validateAndTouch null) — e.g. a worker token", async () => {
    const guard = new PayerAuthGuard(makeSession(null), config, makeRepo());
    await expect(guard.canActivate(makeCtx("Bearer worker.or.bad.token").ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("attaches req.payer (incl. role) on a valid token and does NOT refresh when fresh", async () => {
    // Session already carries the role (post-ADR-0022): no DB fallback needed.
    const session = makeSession({ payerId: "p1", sid: "s1", remainingSeconds: FULL_TTL, role: "agent" });
    const repo = makeRepo();
    const guard = new PayerAuthGuard(session, config, repo);
    const { ctx, req, setHeader } = makeCtx("Bearer good.token");
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.payer).toEqual({ id: "p1", sid: "s1", role: "agent" });
    expect(repo.findById).not.toHaveBeenCalled(); // fast path — role on the session
    expect(setHeader).not.toHaveBeenCalled();
    expect(session.mint).not.toHaveBeenCalled();
  });

  it("ADR-0022 fallback: a pre-ADR-0022 session (no role) resolves role from the payers row", async () => {
    const session = makeSession({ payerId: "p1", sid: "s1", remainingSeconds: FULL_TTL });
    const repo = makeRepo("employer");
    const guard = new PayerAuthGuard(session, config, repo);
    const { ctx, req } = makeCtx("Bearer legacy.token");
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(repo.findById).toHaveBeenCalledExactlyOnceWith("p1");
    expect(req.payer).toEqual({ id: "p1", sid: "s1", role: "employer" });
  });

  it("ADR-0022 fail-closed: an unresolvable role (row gone) attaches role:null (never a default)", async () => {
    const session = makeSession({ payerId: "p1", sid: "s1", remainingSeconds: FULL_TTL });
    // Explicit no-row repo: passing makeRepo(undefined) would re-trigger its "employer"
    // default-parameter, so construct the row-gone case directly.
    const repo = { findById: vi.fn(async () => undefined) } as unknown as PayersRepository;
    const guard = new PayerAuthGuard(session, config, repo);
    const { ctx, req } = makeCtx("Bearer ghost.token");
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.payer).toEqual({ id: "p1", sid: "s1", role: null });
  });

  it("sets x-session-token past the half-life (rolling refresh) carrying the resolved role", async () => {
    const session = makeSession({ payerId: "p1", sid: "s1", remainingSeconds: FULL_TTL / 2 - 1, role: "agent" });
    const guard = new PayerAuthGuard(session, config, makeRepo());
    const { ctx, setHeader } = makeCtx("Bearer aging.token");
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(session.mint).toHaveBeenCalledWith("p1", "s1", "agent");
    expect(setHeader).toHaveBeenCalledWith("x-session-token", "fresh.jwt");
  });
});
