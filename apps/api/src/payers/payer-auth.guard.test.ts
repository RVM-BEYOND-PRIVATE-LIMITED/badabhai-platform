import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import {
  ForbiddenException,
  HttpStatus,
  UnauthorizedException,
  type ExecutionContext,
} from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { PayerRole, PayerStatus } from "@badabhai/db";
import type { PayerSessionService } from "./payer-session.service";
import type { PayersRepository } from "./payers.repository";
import {
  PayerAccountDeletedException,
  PAYER_ACCOUNT_DELETED_CODE,
} from "./payer-account-deleted.exception";
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

  it("never reads the FULL payer row — encrypted contact PII stays out of guard scope", async () => {
    const repo = makeRepo({ role: "employer", status: "active" });
    const guard = new PayerAuthGuard(makeSession({ ...VALID, role: "employer" }), config, repo);
    await expect(guard.canActivate(makeCtx("Bearer good.token").ctx)).resolves.toBe(true);
    // findById is `select()` — it returns email_enc / phone_enc / org_name_enc. Pulling that
    // onto the hot path of all 55 payer routes for two scalars would be a privacy regression.
    expect(repo.findById).not.toHaveBeenCalled();
  });
});

/**
 * The reserved 410 contract (#1231) — the payer mirror of `WORKER_ACCOUNT_DELETED`.
 *
 * The row-gone branch used to throw a generic 401, which the payer app cannot tell apart from
 * an expired session: it answers a 401 with a silent re-auth, so a payer whose row was deleted
 * out of band looped through a login that could never succeed. The client half already ships
 * (`payer_account_deleted_signal.dart` — dialog, wipe, hard-logout); these tests are the
 * backend half of that contract, and the three that assert what does NOT 410 are the ones that
 * keep a destructive client action from firing on anything but a real deletion.
 */
describe("PayerAuthGuard — reserved 410 PAYER_ACCOUNT_DELETED (#1231)", () => {
  /**
   * Built directly, NOT via `makeRepo(undefined)`: passing `undefined` re-triggers the default
   * parameter and would silently hand back an ACTIVE payer, making every test below vacuous.
   * (The original suite hit this exact trap and documented it.)
   */
  function ghostRepo() {
    return {
      findAuthFacts: vi.fn(async () => undefined),
      findById: vi.fn(),
    } as unknown as PayersRepository;
  }

  it("row GONE mid-session ⇒ 410, not the old 401", async () => {
    const guard = new PayerAuthGuard(makeSession({ ...VALID, role: "agent" }), config, ghostRepo());
    const err = await guard.canActivate(makeCtx("Bearer ghost.token").ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayerAccountDeletedException);
    expect((err as PayerAccountDeletedException).getStatus()).toBe(HttpStatus.GONE);
    // Explicit, because `UnauthorizedException` is what this branch threw before: a refactor
    // that reintroduced it would still be an `HttpException` and still fail closed, so only
    // naming the old type catches the regression that matters to the client.
    expect(err).not.toBeInstanceOf(UnauthorizedException);
  });

  it("carries the reserved code the shipped payer app keys on", async () => {
    const guard = new PayerAuthGuard(makeSession({ ...VALID, role: "agent" }), config, ghostRepo());
    const err = (await guard
      .canActivate(makeCtx("Bearer ghost.token").ctx)
      .catch((e: unknown) => e)) as PayerAccountDeletedException;
    expect(err.getResponse()).toMatchObject({ code: PAYER_ACCOUNT_DELETED_CODE });
  });

  it("mints NO rolling token on the 410 path — no fresh credential for a deleted account", async () => {
    // Past the half-life, so the refresh branch WOULD fire if the gate ran too late. Handing
    // back an `x-session-token` here would extend a session whose principal no longer exists.
    const session = makeSession({ ...VALID, remainingSeconds: FULL_TTL / 2 - 1, role: "agent" });
    const { ctx, setHeader } = makeCtx("Bearer aging.ghost");
    await expect(
      new PayerAuthGuard(session, config, ghostRepo()).canActivate(ctx),
    ).rejects.toBeInstanceOf(PayerAccountDeletedException);
    expect(session.mint).not.toHaveBeenCalled();
    expect(setHeader).not.toHaveBeenCalled();
  });

  it("attaches NO req.payer on the 410 path", async () => {
    const { ctx, req } = makeCtx("Bearer ghost.token");
    await expect(
      new PayerAuthGuard(makeSession(VALID), config, ghostRepo()).canActivate(ctx),
    ).rejects.toBeInstanceOf(PayerAccountDeletedException);
    expect(req.payer).toBeUndefined();
  });

  /**
   * ── THE THREE NON-410s. A 410 makes the client WIPE STORAGE AND HARD-LOGOUT, so a false one
   * destroys a live payer's session on a transient fault. Each of these asserts a different way
   * that could happen and does not.
   */
  it("a transient DB error is NOT a 410 — it propagates as a 5xx", async () => {
    // `findAuthFacts` awaits a drizzle `select()`, so a driver/connection failure REJECTS
    // rather than resolving `undefined` — which is the structural reason no try/catch is needed
    // to keep a Postgres incident from 410-storming every payer at once. This test is what
    // stops a future refactor into a swallow-and-return-undefined shape from shipping that.
    const repo = {
      findAuthFacts: vi.fn(async () => {
        throw new Error("pg down");
      }),
      findById: vi.fn(),
    } as unknown as PayersRepository;
    const err = await new PayerAuthGuard(makeSession(VALID), config, repo)
      .canActivate(makeCtx("Bearer valid.during.outage").ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PayerAccountDeletedException);
  });

  it("a DB error does NOT fail OPEN either — the ADR-0037 suspension gate still holds", async () => {
    // The worker helper degrades a probe error to "present" and lets the request through. That
    // is safe there (a pure existence probe) and would be a fail-OPEN here: the SAME read
    // carries `status`, so admitting a request with an unknown one serves a SUSPENDED payer for
    // the length of the incident. CLAUDE.md §3 — fail closed, never open, on an authz gate.
    const repo = {
      findAuthFacts: vi.fn(async () => {
        throw new Error("pg down");
      }),
      findById: vi.fn(),
    } as unknown as PayersRepository;
    const { ctx, req } = makeCtx("Bearer valid.during.outage");
    await expect(
      new PayerAuthGuard(makeSession(VALID), config, repo).canActivate(ctx),
    ).rejects.toThrow();
    expect(req.payer).toBeUndefined();
  });

  it("an expired/invalid session is still a 401, never a 410", async () => {
    // The 401 → silent re-auth path must stay intact: turning THIS into a 410 would wipe every
    // payer's storage the moment their session aged out.
    const guard = new PayerAuthGuard(makeSession(null), config, makeRepo());
    const err = await guard.canActivate(makeCtx("Bearer expired.token").ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(err).not.toBeInstanceOf(PayerAccountDeletedException);
  });

  it("a SUSPENDED payer is still a 403, never a 410 — the row exists", async () => {
    // Suspension is reversible and the account is not gone; a 410 would tell the app to wipe
    // and hard-logout a payer who will be reinstated.
    const guard = new PayerAuthGuard(
      makeSession({ ...VALID, role: "employer" }),
      config,
      makeRepo({ role: "employer", status: "suspended" }),
    );
    const err = await guard.canActivate(makeCtx("Bearer suspended.token").ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err).not.toBeInstanceOf(PayerAccountDeletedException);
  });
});
