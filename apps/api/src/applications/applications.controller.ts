import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { InternalServiceGuard } from "../common/guards/internal-service.guard";
import {
  WorkerAuthGuard,
  CurrentWorker,
  type AuthenticatedWorker,
} from "../auth/worker-auth.guard";
import { ConsentGuard } from "../auth/consent.guard";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { ApplicationsService } from "./applications.service";
import {
  ApplyJobSchema,
  FeedQuerySchema,
  SkipJobSchema,
  type ApplyJobDto,
  type FeedQueryDto,
  type SkipJobDto,
} from "./applications.dto";

/**
 * Alpha swipe-to-apply HTTP surface (ADR-0009 Stream B). Thin — all logic + event
 * emission live in {@link ApplicationsService}.
 *
 * No `@Controller` prefix: the five routes span four path roots (`/feed`,
 * `/applications/...`, `/jobs/.../applicants`, `/workers/.../applications`) and
 * the ADR pins those exact paths. The ops reads do NOT collide with the existing
 * `WorkersController` (`/workers`, `/workers/:id/profile`, `/workers/:id/name`)
 * or any jobs controller (there is none).
 *
 * GUARD ORDER (worker routes): `WorkerAuthGuard` first (authenticates + attaches
 * `req.worker`), then `ConsentGuard` (reads that worker, requires active consent).
 * The worker id always comes from `@CurrentWorker` — never from the body/param.
 */
@Controller()
export class ApplicationsController {
  constructor(private readonly applications: ApplicationsService) {}

  /**
   * Worker feed: up to `limit` open jobs, deterministic order, rank = 1-based
   * position. Emits one `feed.shown` per returned job. PII-free (no pay, no
   * employer).
   */
  @Get("feed")
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  feed(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Query(new ZodValidationPipe(FeedQuerySchema)) query: FeedQueryDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.applications.getFeed(worker.id, query.limit, ctx);
  }

  /**
   * Apply to a job (idempotent upsert). 404 if the job is unknown. Emits
   * `application.submitted`.
   */
  @Post("applications/:jobId/apply")
  @HttpCode(200)
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  apply(
    @Param("jobId", new ParseUUIDPipe()) jobId: string,
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(ApplyJobSchema)) dto: ApplyJobDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.applications.apply(worker.id, jobId, dto, ctx);
  }

  /**
   * Skip a job (idempotent upsert). 404 if the job is unknown. Emits
   * `application.skipped`.
   */
  @Post("applications/:jobId/skip")
  @HttpCode(200)
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  skip(
    @Param("jobId", new ParseUUIDPipe()) jobId: string,
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(SkipJobSchema)) dto: SkipJobDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.applications.skip(worker.id, jobId, dto, ctx);
  }

  /** Ops: applicants per job. PII-free projection (worker_id only). */
  @Get("jobs/:jobId/applicants")
  @UseGuards(InternalServiceGuard)
  applicants(@Param("jobId", new ParseUUIDPipe()) jobId: string) {
    return this.applications.applicantsForJob(jobId);
  }

  /** Ops: a worker's decisions, joined to coarse job fields. No employer, no pay. */
  @Get("workers/:workerId/applications")
  @UseGuards(InternalServiceGuard)
  workerApplications(@Param("workerId", new ParseUUIDPipe()) workerId: string) {
    return this.applications.applicationsForWorker(workerId);
  }
}
