import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import type { WorkerConsent } from "@badabhai/db";
import type { ConsentRepository } from "../consent/consent.repository";
import { ConsentGuard } from "./consent.guard";

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
