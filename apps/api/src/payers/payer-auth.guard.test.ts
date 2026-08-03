import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { PayerRole, PayerStatus } from "@badabhai/db";
import type { PayerSessionService } from "./payer-session.service";
import type { PayersRepository } from "./payers.repository";
import { PayerAuthGuard } from "./payer-auth.guard";

const config = { SESSION_TTL_DAYS: 30 } as unknown as ServerConfig;
const FULL_TTL = 30 * 86400;

/**
 * Repository stub. `findAuthFacts` is the ONLY read the guard makes (ADR-0037): the
 * narrow `{role, status}` projection. Returning `undefined` exercises the row-gone
 * fail-closed path.
 *
 * `findById` is stubbed too, purely so the tests can assert it is NEVER called — the guard
 * must not reach for the full row, which carries the payer's encrypted email/phone/org-name.
 */
function makeRepo(
  facts: { role: PayerRole; status: PayerStatus } | undefined = {
    role: "employer",
    status: "active",
  },
) {
  const findAuthFacts = vi.fn(async () => facts);
  const findById = vi.fn(async () => ({ id: "p1" }) as never);
  return { findAuthFacts, findById } as unknown as PayersRepository;
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

const VALID = { payerId: "p1", sid: "s1", remainingSeconds: FULL_TTL };

describe("PayerAuthGuard", () => {
  it("throws 401 when there is no Authorization header", async () => {
    const guard = new PayerAuthGuard(makeSession(VALID), config, makeRepo());
    await expect(guard.canActivate(makeCtx(undefined).ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("throws 401 when the scheme is not Bearer", async () => {
    const guard = new PayerAuthGuard(makeSession(VALID), config, makeRepo());
    await expect(guard.canActivate(makeCtx("Basic abc").ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("throws 401 when the payer session is invalid (validateAndTouch null) — e.g. a worker token", async () => {
    const guard = new PayerAuthGuard(makeSession(null), config, makeRepo());
    await expect(guard.canActivate(makeCtx("Bearer worker.or.bad.token").ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("attaches req.payer (incl. role) on a valid token and does NOT refresh when fresh", async () => {
    const session = makeSession({ ...VALID, role: "agent" });
    const repo = makeRepo({ role: "agent", status: "active" });
    const guard = new PayerAuthGuard(session, config, repo);
    const { ctx, req, setHeader } = makeCtx("Bearer good.token");
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.payer).toEqual({ id: "p1", sid: "s1", role: "agent" });
    expect(setHeader).not.toHaveBeenCalled();
    expect(session.mint).not.toHaveBeenCalled();
  });

  it("sets x-session-token past the half-life (rolling refresh) carrying the resolved role", async () => {
    const session = makeSession({ ...VALID, remainingSeconds: FULL_TTL / 2 - 1, role: "agent" });
    const guard = new PayerAuthGuard(session, config, makeRepo({ role: "agent", status: "active" }));
    const { ctx, setHeader } = makeCtx("Bearer aging.token");
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(session.mint).toHaveBeenCalledWith("p1", "s1", "agent");
    expect(setHeader).toHaveBeenCalledWith("x-session-token", "fresh.jwt");
  });
});

/**
 * ADR-0037 — the platform-wide suspension gate. Before this, `payers.status` was written
 * by the admin actions and read by NOTHING on the request path: a suspended payer kept
 * full access to all 55 payer routes until their (indefinitely sliding) session expired.
 */
describe("PayerAuthGuard — lifecycle gate (ADR-0037)", () => {
  it("403s a SUSPENDED payer holding an otherwise-valid session", async () => {
    const guard = new PayerAuthGuard(
      makeSession({ ...VALID, role: "employer" }),
      config,
      makeRepo({ role: "employer", status: "suspended" }),
    );
    await expect(guard.canActivate(makeCtx("Bearer valid.but.suspended").ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("403s a PENDING payer — a never-verified account may not act", async () => {
    const guard = new PayerAuthGuard(
      makeSession({ ...VALID, role: "employer" }),
      config,
      makeRepo({ role: "employer", status: "pending" }),
    );
    await expect(guard.canActivate(makeCtx("Bearer valid.but.pending").ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("does NOT mint a rolling token for a rejected payer (no refreshed credential leaks out)", async () => {
    // Past the half-life, so the refresh branch WOULD fire if the gate ran too late.
    const session = makeSession({ ...VALID, remainingSeconds: FULL_TTL / 2 - 1, role: "agent" });
    const guard = new PayerAuthGuard(session, config, makeRepo({ role: "agent", status: "suspended" }));
    const { ctx, setHeader } = makeCtx("Bearer aging.suspended");
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    expect(session.mint).not.toHaveBeenCalled();
    expect(setHeader).not.toHaveBeenCalled();
  });

  it("reads status from the ROW every request — a stale session role claim cannot outrank it", async () => {
    // The session still claims "agent"; the row says the payer is now an employer. The row
    // wins, because a session minted before a role change must not keep the old privilege.
    const session = makeSession({ ...VALID, role: "agent" });
    const repo = makeRepo({ role: "employer", status: "active" });
    const guard = new PayerAuthGuard(session, config, repo);
    const { ctx, req } = makeCtx("Bearer stale.role.claim");
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(repo.findAuthFacts).toHaveBeenCalledExactlyOnceWith("p1");
    expect(req.payer).toEqual({ id: "p1", sid: "s1", role: "employer" });
  });

  it("401s when the payer row is GONE mid-session (fail closed, not role:null)", async () => {
    // Built directly, NOT via makeRepo(undefined): passing `undefined` re-triggers the
    // default parameter and would silently hand back an ACTIVE payer, making this test
    // vacuous. (The original suite hit this exact trap and documented it.)
    const repo = {
      findAuthFacts: vi.fn(async () => undefined),
      findById: vi.fn(),
    } as unknown as PayersRepository;
    const guard = new PayerAuthGuard(makeSession({ ...VALID, role: "agent" }), config, repo);
    await expect(guard.canActivate(makeCtx("Bearer ghost.token").ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("never reads the FULL payer row — encrypted contact PII stays out of guard scope", async () => {
    const repo = makeRepo({ role: "employer", status: "active" });
    const guard = new PayerAuthGuard(makeSession({ ...VALID, role: "employer" }), config, repo);
    await expect(guard.canActivate(makeCtx("Bearer good.token").ctx)).resolves.toBe(true);
    // findById is `select()` — it returns email_enc / phone_enc / org_name_enc. Pulling that
    // onto the hot path of all 55 payer routes for two scalars would be a privacy regression.
    expect(repo.findById).not.toHaveBeenCalled();
  });
});
