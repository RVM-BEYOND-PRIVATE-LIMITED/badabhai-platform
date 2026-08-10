import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { WorkerConsent } from "@badabhai/db";
import type { ConsentPurpose } from "@badabhai/types";
import type { ConsentRepository } from "../consent/consent.repository";
import { ConsentGuard, ConsentNotRevokedGuard, RequireConsentPurpose } from "./consent.guard";

/**
 * Real controller shapes rather than a stubbed Reflector, so these tests exercise the ACTUAL
 * metadata wiring — including method-over-class precedence, which a hand-rolled fake would
 * assert about itself rather than about Nest.
 */
class UngatedRoutes {
  noPurpose() {}
}

class VoiceRoutes {
  @RequireConsentPurpose("voice_processing")
  gated() {}
  inherited() {}
}

@RequireConsentPurpose("employer_sharing")
class ClassLevelRoutes {
  inherited() {}
  @RequireConsentPurpose("voice_processing")
  overridden() {}
}

/** ExecutionContext whose request carries the given (already-authenticated) worker. */
function makeCtx(
  worker?: { id: string; sid: string },
  handler: (...args: never[]) => unknown = UngatedRoutes.prototype.noPurpose,
  cls: new () => unknown = UngatedRoutes,
) {
  const req: { worker?: { id: string; sid: string } } = {};
  if (worker) req.worker = worker;
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () => cls,
  } as unknown as ExecutionContext;
}

/** The guard under test, wired with a REAL Reflector. */
function makeGuard(consents: ConsentRepository) {
  return new ConsentGuard(consents, new Reflector());
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
    const guard = makeGuard(consents);
    await expect(guard.canActivate(makeCtx(WORKER))).resolves.toBe(true);
    expect(consents.findLatestByWorker).toHaveBeenCalledWith("w-1");
  });

  it("throws 403 when the worker has never consented (no row)", async () => {
    const guard = makeGuard(makeConsents(undefined));
    await expect(guard.canActivate(makeCtx(WORKER))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("throws 403 when the latest consent has been revoked", async () => {
    const consents = makeConsents({ id: "c-1", workerId: "w-1", revokedAt: new Date() });
    const guard = makeGuard(consents);
    await expect(guard.canActivate(makeCtx(WORKER))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("throws 401 when no authenticated worker is on the request (guard misordered)", async () => {
    const consents = makeConsents({ id: "c-1", workerId: "w-1", revokedAt: null });
    const guard = makeGuard(consents);
    // No req.worker → WorkerAuthGuard did not run first; fail closed, do not query.
    await expect(guard.canActivate(makeCtx(undefined))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(consents.findLatestByWorker).not.toHaveBeenCalled();
  });

  it("does NOT trust a client-supplied worker id — only reads req.worker", async () => {
    const consents = makeConsents({ id: "c-1", workerId: "w-1", revokedAt: null });
    const guard = makeGuard(consents);
    // A request whose body/query tried to pass another worker_id is irrelevant:
    // the guard only ever consults req.worker.id (from the session).
    const ctx = makeCtx(WORKER);
    await guard.canActivate(ctx);
    expect(consents.findLatestByWorker).toHaveBeenCalledWith("w-1");
    expect(consents.findLatestByWorker).not.toHaveBeenCalledWith("attacker-id");
  });
});

describe("ConsentGuard — @RequireConsentPurpose (V9)", () => {
  const active = (purposes: ConsentPurpose[]) => ({
    id: "c-1",
    workerId: "w-1",
    revokedAt: null,
    purposes,
  });

  it("BACKWARD COMPATIBILITY: a route declaring NO purpose still passes on any active consent", async () => {
    // The load-bearing case. ConsentGuard is mounted on a dozen controllers that predate
    // purposes; if a missing declaration denied, this file would 403 every worker everywhere.
    const guard = makeGuard(makeConsents(active(["profiling"])));
    await expect(guard.canActivate(makeCtx(WORKER))).resolves.toBe(true);
  });

  it("ALLOWS when the latest consent carries the declared purpose", async () => {
    const guard = makeGuard(makeConsents(active(["profiling", "voice_processing"])));
    await expect(
      guard.canActivate(makeCtx(WORKER, VoiceRoutes.prototype.gated, VoiceRoutes)),
    ).resolves.toBe(true);
  });

  it("DENIES (403) an active consent that lacks the declared purpose", async () => {
    // Consented to profiling, never to being recorded — the exact case the purpose exists for.
    const guard = makeGuard(makeConsents(active(["profiling", "resume_generation"])));
    await expect(
      guard.canActivate(makeCtx(WORKER, VoiceRoutes.prototype.gated, VoiceRoutes)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("DENIES with a message INDISTINGUISHABLE from a missing consent (no purpose oracle)", async () => {
    const missing = makeGuard(makeConsents(undefined));
    const wrongPurpose = makeGuard(makeConsents(active(["profiling"])));
    const a = await missing.canActivate(makeCtx(WORKER)).catch((e: Error) => e.message);
    const b = await wrongPurpose
      .canActivate(makeCtx(WORKER, VoiceRoutes.prototype.gated, VoiceRoutes))
      .catch((e: Error) => e.message);
    expect(a).toBe(b);
  });

  it("DENIES a REVOKED consent even when it carries the purpose (revocation wins)", async () => {
    const guard = makeGuard(
      makeConsents({
        id: "c-1",
        workerId: "w-1",
        revokedAt: new Date(),
        purposes: ["voice_processing"],
      }),
    );
    await expect(
      guard.canActivate(makeCtx(WORKER, VoiceRoutes.prototype.gated, VoiceRoutes)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("DENIES when `purposes` is absent entirely (legacy/partial row → fail closed)", async () => {
    const guard = makeGuard(
      makeConsents({ id: "c-1", workerId: "w-1", revokedAt: null } as Partial<WorkerConsent>),
    );
    await expect(
      guard.canActivate(makeCtx(WORKER, VoiceRoutes.prototype.gated, VoiceRoutes)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("inherits a CLASS-level purpose on a route that declares none", async () => {
    const guard = makeGuard(makeConsents(active(["employer_sharing"])));
    await expect(
      guard.canActivate(makeCtx(WORKER, ClassLevelRoutes.prototype.inherited, ClassLevelRoutes)),
    ).resolves.toBe(true);
  });

  it("lets a METHOD-level purpose OVERRIDE the class-level one", async () => {
    // Carries only the method's purpose, not the class's → must still pass.
    const guard = makeGuard(makeConsents(active(["voice_processing"])));
    await expect(
      guard.canActivate(makeCtx(WORKER, ClassLevelRoutes.prototype.overridden, ClassLevelRoutes)),
    ).resolves.toBe(true);
  });
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
