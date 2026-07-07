import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import type { WorkerConsent } from "@badabhai/db";
import { type ConsentRepository, isConsentAccepted } from "../consent/consent.repository";
import { ConsentGuard, ConsentNotRevokedGuard } from "./consent.guard";

/** ExecutionContext whose request carries the given (already-authenticated) worker. */
function makeCtx(worker?: { id: string; sid: string }) {
  const req: { worker?: { id: string; sid: string } } = {};
  if (worker) req.worker = worker;
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function makeConsents(latest: Partial<WorkerConsent> | undefined) {
  return {
    findLatestByWorker: vi.fn().mockResolvedValue(latest as WorkerConsent | undefined),
  } as unknown as ConsentRepository;
}

const WORKER = { id: "w-1", sid: "s-1" };

describe("ConsentGuard", () => {
  it("allows a worker whose latest consent is accepted and not revoked", async () => {
    const consents = makeConsents({ id: "c-1", workerId: "w-1", revokedAt: null });
    const guard = new ConsentGuard(consents);
    await expect(guard.canActivate(makeCtx(WORKER))).resolves.toBe(true);
    expect(consents.findLatestByWorker).toHaveBeenCalledWith("w-1");
  });

  it("throws 403 when the worker has never consented (no row)", async () => {
    const guard = new ConsentGuard(makeConsents(undefined));
    await expect(guard.canActivate(makeCtx(WORKER))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("throws 403 when the latest consent has been revoked", async () => {
    const consents = makeConsents({ id: "c-1", workerId: "w-1", revokedAt: new Date() });
    const guard = new ConsentGuard(consents);
    await expect(guard.canActivate(makeCtx(WORKER))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("throws 401 when no authenticated worker is on the request (guard misordered)", async () => {
    const consents = makeConsents({ id: "c-1", workerId: "w-1", revokedAt: null });
    const guard = new ConsentGuard(consents);
    // No req.worker → WorkerAuthGuard did not run first; fail closed, do not query.
    await expect(guard.canActivate(makeCtx(undefined))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(consents.findLatestByWorker).not.toHaveBeenCalled();
  });

  it("does NOT trust a client-supplied worker id — only reads req.worker", async () => {
    const consents = makeConsents({ id: "c-1", workerId: "w-1", revokedAt: null });
    const guard = new ConsentGuard(consents);
    // A request whose body/query tried to pass another worker_id is irrelevant:
    // the guard only ever consults req.worker.id (from the session).
    const ctx = makeCtx(WORKER);
    await guard.canActivate(ctx);
    expect(consents.findLatestByWorker).toHaveBeenCalledWith("w-1");
    expect(consents.findLatestByWorker).not.toHaveBeenCalledWith("attacker-id");
  });
});

// The `consent_accepted` auth-response flag (finding #172-#1) is DERIVED from the exact same
// pure predicate ConsentGuard admits on (isConsentAccepted). This block pins that parity so the
// worker-app's returning-worker routing decision stays byte-for-byte the server-side gate — a
// future drift between the two would be caught here.
describe("isConsentAccepted == ConsentGuard admit (the consent_accepted derivation source)", () => {
  const cases: Array<{ label: string; row: Partial<WorkerConsent> | undefined; admit: boolean }> = [
    { label: "never consented (no row)", row: undefined, admit: false },
    { label: "active consent (revokedAt null)", row: { revokedAt: null }, admit: true },
    { label: "revoked consent (revokedAt set)", row: { revokedAt: new Date() }, admit: false },
  ];

  for (const { label, row, admit } of cases) {
    it(`${label}: predicate=${admit} matches whether ConsentGuard admits`, async () => {
      // 1) The pure predicate (the single source of truth for consent_accepted).
      expect(isConsentAccepted(row as WorkerConsent | undefined)).toBe(admit);

      // 2) The GUARD's live decision for the same row — admit ⇒ resolves true, deny ⇒ 403.
      const guard = new ConsentGuard(makeConsents(row));
      if (admit) {
        await expect(guard.canActivate(makeCtx(WORKER))).resolves.toBe(true);
      } else {
        await expect(guard.canActivate(makeCtx(WORKER))).rejects.toBeInstanceOf(ForbiddenException);
      }
    });
  }
});

describe("ConsentNotRevokedGuard (A5 — session resume/refresh, defense-in-depth)", () => {
  it("ALLOWS a never-consented worker (no row) — the pre-consent onboarding window is not broken", async () => {
    // KEY difference from ConsentGuard: a missing consent row is ALLOWED here (a worker logs in
    // BEFORE consenting; the profiling routes still carry ConsentGuard to block processing).
    const consents = makeConsents(undefined);
    const guard = new ConsentNotRevokedGuard(consents);
    await expect(guard.canActivate(makeCtx(WORKER))).resolves.toBe(true);
    expect(consents.findLatestByWorker).toHaveBeenCalledWith("w-1");
  });

  it("ALLOWS a worker with active (not-revoked) consent", async () => {
    const consents = makeConsents({ id: "c-1", workerId: "w-1", revokedAt: null });
    const guard = new ConsentNotRevokedGuard(consents);
    await expect(guard.canActivate(makeCtx(WORKER))).resolves.toBe(true);
  });

  it("DENIES (403) a worker whose latest consent has been REVOKED", async () => {
    const consents = makeConsents({ id: "c-1", workerId: "w-1", revokedAt: new Date() });
    const guard = new ConsentNotRevokedGuard(consents);
    await expect(guard.canActivate(makeCtx(WORKER))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("throws 401 when no authenticated worker is on the request (guard misordered) and does NOT query", async () => {
    const consents = makeConsents({ id: "c-1", workerId: "w-1", revokedAt: null });
    const guard = new ConsentNotRevokedGuard(consents);
    await expect(guard.canActivate(makeCtx(undefined))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(consents.findLatestByWorker).not.toHaveBeenCalled();
  });
});
