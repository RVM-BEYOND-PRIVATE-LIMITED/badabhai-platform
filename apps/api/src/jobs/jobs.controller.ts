import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from "@nestjs/common";
import {
  WorkerAuthGuard,
  CurrentWorker,
  type AuthenticatedWorker,
} from "../auth/worker-auth.guard";
import { ConsentGuard } from "../auth/consent.guard";
import { JobsService } from "./jobs.service";

/**
 * Worker-scoped job detail HTTP surface (ADR-0024 final addendum, 2026-07-16 —
 * the ruling of record). Thin — the projection + neutral 404 live in
 * {@link JobsService}.
 *
 * No `@Controller` prefix: the route root is `/jobs/:jobId` (2 segments), which
 * does NOT collide with the ops `GET /jobs/:jobId/applicants` (3 segments, in
 * ApplicationsController behind InternalServiceGuard) — no other `/jobs` root
 * route exists. The ops `GET /job-postings/:id` (employer org label) remains
 * FORBIDDEN on the worker path (ADR-0024 §Surfaces).
 *
 * GUARD ORDER: `WorkerAuthGuard` first (authenticates + attaches `req.worker`),
 * then `ConsentGuard` (reads that worker, requires active consent) — same chain
 * as `/feed`. There is no body/query DTO: the ONLY input is the `:jobId` path
 * param, validated by `ParseUUIDPipe` (so no zod DTO file exists for this module
 * by design — a lone UUID param needs no schema).
 */
@Controller()
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  /**
   * Worker-visible job detail: the explicit PII-free projection of ONE open job.
   * Neutral 404 for unknown AND closed ids alike (no oracle). NO event — see the
   * load-bearing §"Event ruling" comment on {@link JobsService.getWorkerVisibleJob}.
   */
  @Get("jobs/:jobId")
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  getJob(
    @Param("jobId", new ParseUUIDPipe()) jobId: string,
    // Worker identity is REQUIRED by the guard chain but deliberately unused:
    // the projection is worker-independent (the same open job reads identically
    // for every consented worker — ADR-0024: no per-worker reveal on this path).
    @CurrentWorker() _worker: AuthenticatedWorker,
  ) {
    return this.jobs.getWorkerVisibleJob(jobId);
  }
}
