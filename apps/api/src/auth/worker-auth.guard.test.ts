import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { WorkerConsent } from "@badabhai/db";
import type { ConsentRepository } from "../consent/consent.repository";
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

/** Consent repository double — mirrors the consent.guard.test.ts fixtures. */
function makeConsents(latest: Partial<WorkerConsent> | undefined) {
  return {
    findLatestByWorker: vi.fn().mockResolvedValue(latest as WorkerConsent | undefined),
  } as unknown as ConsentRepository;
}

/** Active (not-revoked) consent — the common case; re-mint must stay enabled. */
const ACTIVE_CONSENT = { id: "c-1", workerId: "w1", revokedAt: null };

describe("WorkerAuthGuard", () => {
  it("throws 401 when there is no Authorization header", async () => {
    const session = makeSession({ workerId: "w1", sid: "s1", remainingSeconds: FULL_TTL });
    const guard = new WorkerAuthGuard(session, config, makeConsents(ACTIVE_CONSENT));
    const { ctx } = makeCtx(undefined);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("throws 401 when the scheme is not Bearer", async () => {
    const session = makeSession({ workerId: "w1", sid: "s1", remainingSeconds: FULL_TTL });
    const guard = new WorkerAuthGuard(session, config, makeConsents(ACTIVE_CONSENT));
    const { ctx } = makeCtx("Basic abc");
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("throws 401 when the token is invalid (validateAndTouch null)", async () => {
    const session = makeSession(null);
    const guard = new WorkerAuthGuard(session, config, makeConsents(ACTIVE_CONSENT));
    const { ctx } = makeCtx("Bearer bad.token");
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("attaches req.worker on a valid token and does NOT refresh when fresh", async () => {
    const session = makeSession({ workerId: "w1", sid: "s1", remainingSeconds: FULL_TTL });
    const consents = makeConsents(ACTIVE_CONSENT);
    const guard = new WorkerAuthGuard(session, config, consents);
    const { ctx, req, setHeader } = makeCtx("Bearer good.token");
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.worker).toEqual({ id: "w1", sid: "s1" });
    expect(setHeader).not.toHaveBeenCalled();
    expect(session.mint).not.toHaveBeenCalled();
    // A5 residual: the consent read rides ONLY the half-life re-mint branch — the
    // ordinary per-request path never touches the DB (at most one read per half-life).
    expect(consents.findLatestByWorker).not.toHaveBeenCalled();
  });

  it("sets x-session-token when the token is past its half-life (rolling refresh)", async () => {
    // remainingSeconds below half the full TTL → mint a fresh token.
    const session = makeSession({ workerId: "w1", sid: "s1", remainingSeconds: FULL_TTL / 2 - 1 });
    const guard = new WorkerAuthGuard(session, config, makeConsents(ACTIVE_CONSENT));
    const { ctx, setHeader } = makeCtx("Bearer aging.token");
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    // The rolling-refresh mint preserves the (here absent) device binding — the deviceId
    // arg is undefined for an unbound session.
    expect(session.mint).toHaveBeenCalledWith("w1", "s1", undefined);
    expect(setHeader).toHaveBeenCalledWith("x-session-token", "fresh.jwt");
  });

  // A5 residual (ADR-0026 amendment): the half-life re-mint is consent-gated.
  describe("consent-gated half-life re-mint (A5 residual)", () => {
    it("REVOKED consent ⇒ no x-session-token on the re-mint path (request still passes)", async () => {
      const session = makeSession({
        workerId: "w1",
        sid: "s1",
        remainingSeconds: FULL_TTL / 2 - 1,
      });
      const consents = makeConsents({ id: "c-1", workerId: "w1", revokedAt: new Date() });
      const guard = new WorkerAuthGuard(session, config, consents);
      const { ctx, req, setHeader } = makeCtx("Bearer aging.token");
      // The request itself PASSES — a revoked worker can still call e.g. POST /auth/logout;
      // only the silent session EXTENSION is withheld.
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(req.worker).toEqual({ id: "w1", sid: "s1" });
      expect(consents.findLatestByWorker).toHaveBeenCalledWith("w1");
      expect(session.mint).not.toHaveBeenCalled();
      expect(setHeader).not.toHaveBeenCalled();
    });

    it("ACTIVE consent ⇒ x-session-token present on the re-mint path", async () => {
      const session = makeSession({
        workerId: "w1",
        sid: "s1",
        remainingSeconds: FULL_TTL / 2 - 1,
      });
      const consents = makeConsents(ACTIVE_CONSENT);
      const guard = new WorkerAuthGuard(session, config, consents);
      const { ctx, setHeader } = makeCtx("Bearer aging.token");
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(consents.findLatestByWorker).toHaveBeenCalledWith("w1");
      expect(session.mint).toHaveBeenCalledWith("w1", "s1", undefined);
      expect(setHeader).toHaveBeenCalledWith("x-session-token", "fresh.jwt");
    });

    it("consent read THROWS ⇒ no x-session-token, but the already-authenticated request STILL PASSES (fail-safe, never a 500)", async () => {
      // The consent read is this guard's ONLY Postgres dependency — a PG blip must not
      // 500 logout/logout-all past the half-life. Unknown consent state ⇒ withhold the
      // extension (security property holds), let the request through.
      const session = makeSession({
        workerId: "w1",
        sid: "s1",
        remainingSeconds: FULL_TTL / 2 - 1,
      });
      const consents = {
        findLatestByWorker: vi.fn().mockRejectedValue(new Error("pg down")),
      } as unknown as ConsentRepository;
      const guard = new WorkerAuthGuard(session, config, consents);
      const { ctx, req, setHeader } = makeCtx("Bearer aging.token");
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(req.worker).toEqual({ id: "w1", sid: "s1" });
      expect(session.mint).not.toHaveBeenCalled();
      expect(setHeader).not.toHaveBeenCalled();
    });

    it("NEVER-consented (no row) ⇒ x-session-token present — the pre-consent onboarding window is not broken", async () => {
      // Same asymmetry as ConsentNotRevokedGuard: a worker logs in BEFORE consenting;
      // the profiling routes still carry ConsentGuard, so §6 is never relaxed.
      const session = makeSession({
        workerId: "w1",
        sid: "s1",
        remainingSeconds: FULL_TTL / 2 - 1,
      });
      const consents = makeConsents(undefined);
      const guard = new WorkerAuthGuard(session, config, consents);
      const { ctx, setHeader } = makeCtx("Bearer aging.token");
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(session.mint).toHaveBeenCalledWith("w1", "s1", undefined);
      expect(setHeader).toHaveBeenCalledWith("x-session-token", "fresh.jwt");
    });
  });
});
