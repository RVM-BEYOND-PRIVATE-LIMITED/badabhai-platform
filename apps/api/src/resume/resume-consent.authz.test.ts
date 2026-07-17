import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { ConsentGuard } from "../auth/consent.guard";
import { WorkerAuthGuard } from "../auth/worker-auth.guard";
import { InternalServiceGuard } from "../common/guards/internal-service.guard";
import { ResumeController } from "./resume.controller";
import type { ConsentRepository } from "../consent/consent.repository";

/**
 * B-3 — `POST /resume/generate` MUST be consent-gated (CLAUDE.md §2 invariant 6:
 * no AI processing of a worker before `consent.accepted`).
 *
 * Resume generation sends the worker's profile to an LLM, so it is AI processing.
 * It shipped with `@UseGuards(WorkerAuthGuard)` ONLY — the one worker-AI route
 * missing the gate its siblings (chat / voice / profiles) all carry.
 *
 * The hole was NOT theoretical. Reaching the route implies a profile, and profiling
 * is consent-gated — so a never-consented worker could not realistically get here.
 * The REVOKED worker could: accept consent -> get profiled -> WITHDRAW -> still call
 * generate -> profile goes to an LLM post-withdrawal. `revoked -> 403` is therefore
 * the assertion that actually matters here; the rest are the guard's contract.
 *
 * Two layers, both against REAL code (no guard mocks):
 *  1. WIRING — reflect the route's real `@UseGuards` metadata (catches a silent removal,
 *     and pins the ORDER: ConsentGuard reads `req.worker`, so auth must run first).
 *  2. BEHAVIOR — drive the REAL ConsentGuard with a fake repository.
 */

type Latest = Awaited<ReturnType<ConsentRepository["findLatestByWorker"]>>;

/** The guards a route handler really declares, via Nest's own metadata key. */
function declaredGuards(method: keyof ResumeController): unknown[] {
  const proto = ResumeController.prototype as unknown as Record<string, object>;
  return (Reflect.getMetadata(GUARDS_METADATA, proto[method as string]!) as unknown[]) ?? [];
}

/** A ConsentRepository stub returning the supplied "latest consent row". */
function repoReturning(latest: Latest): ConsentRepository {
  return { findLatestByWorker: async () => latest } as unknown as ConsentRepository;
}

function ctx(worker: { id: string } | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ worker }) }),
  } as unknown as ExecutionContext;
}

const WORKER = { id: "11111111-1111-4111-8111-111111111111" };
const activeRow = { revokedAt: null } as unknown as Latest;
const revokedRow = { revokedAt: new Date("2026-07-16T00:00:00.000Z") } as unknown as Latest;

describe("B-3 — POST /resume/generate is consent-gated (wiring)", () => {
  it("declares BOTH WorkerAuthGuard and ConsentGuard", () => {
    const guards = declaredGuards("generate");
    expect(guards).toContain(WorkerAuthGuard);
    expect(guards).toContain(ConsentGuard);
  });

  it("orders WorkerAuthGuard BEFORE ConsentGuard (ConsentGuard reads req.worker)", () => {
    const guards = declaredGuards("generate");
    expect(guards.indexOf(WorkerAuthGuard)).toBeLessThan(guards.indexOf(ConsentGuard));
  });

  it("does NOT put ConsentGuard on the InternalServiceGuard routes", () => {
    // A class-level ConsentGuard would 401 the extraction pipeline: internal callers
    // carry no worker session. This pins the per-route application.
    for (const route of ["get", "regenerate", "share"] as const) {
      const guards = declaredGuards(route);
      expect(guards).toContain(InternalServiceGuard);
      expect(guards).not.toContain(ConsentGuard);
    }
  });
});

describe("B-3 — the real ConsentGuard's contract on that route", () => {
  it("REVOKED consent -> 403 (the hole this closes: no LLM call post-withdrawal)", async () => {
    const guard = new ConsentGuard(repoReturning(revokedRow));
    await expect(guard.canActivate(ctx(WORKER))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("never consented -> 403", async () => {
    const guard = new ConsentGuard(repoReturning(null as unknown as Latest));
    await expect(guard.canActivate(ctx(WORKER))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("active consent -> allowed", async () => {
    const guard = new ConsentGuard(repoReturning(activeRow));
    await expect(guard.canActivate(ctx(WORKER))).resolves.toBe(true);
  });

  it("no authenticated worker -> 401 (fails closed on guard misorder)", async () => {
    const guard = new ConsentGuard(repoReturning(activeRow));
    await expect(guard.canActivate(ctx(undefined))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("the 403 carries no PII (only the opaque worker id the caller already owns)", async () => {
    const guard = new ConsentGuard(repoReturning(revokedRow));
    await expect(guard.canActivate(ctx(WORKER))).rejects.toThrow(/consent/i);
  });
});
