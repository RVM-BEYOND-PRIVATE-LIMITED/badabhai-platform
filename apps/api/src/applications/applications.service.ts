import { Injectable, NotFoundException } from "@nestjs/common";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { RequestContext } from "../common/request-context";
import { EventsService, type EmitParams } from "../events/events.service";
import { ApplicationsRepository, type FeedJob } from "./applications.repository";
import type { ApplyJobDto, SkipJobDto } from "./applications.dto";

/** A feed item the worker sees — PII-free (no pay, no employer). */
export interface FeedItem {
  job_id: string;
  trade_key: string;
  title: string;
  city: string;
  area: string | null;
  rank: number;
}

/**
 * Alpha swipe-to-apply business logic + event emission (ADR-0009 Stream B).
 *
 * Pure CRUD + PII-free behavioural events — NO LLM, NO ranking (`score`/`hot`
 * take their honest unranked defaults of 0/false; `rank` is seed display order,
 * not relevance). The `worker_id` is always the AUTHENTICATED worker passed by the
 * controller from `@CurrentWorker` — never a client-supplied value.
 */
@Injectable()
export class ApplicationsService {
  constructor(
    private readonly repo: ApplicationsRepository,
    private readonly events: EventsService,
  ) {}

  /**
   * Return up to `limit` open jobs in deterministic order and emit ONE
   * `feed.shown` per returned job (one impression each, rank = 1-based position).
   * R-A resolved: bounded per-impression, NO dedupe — every fetch records the
   * impressions, so the emits are intentionally UNKEYED (always insert), batched
   * into a single DB round-trip via `emitMany`.
   */
  async getFeed(workerId: string, limit: number, ctx: RequestContext): Promise<{ jobs: FeedItem[] }> {
    const openJobs = await this.repo.findOpenJobs(limit);
    const items: FeedItem[] = openJobs.map((job: FeedJob, index) => ({
      job_id: job.id,
      trade_key: job.tradeKey,
      title: job.title,
      city: job.city,
      area: job.area,
      rank: index + 1, // 1-based seed display position
    }));

    if (items.length > 0) {
      await this.events.emitMany(
        items.map((item): EmitParams<"feed.shown"> => {
          const payload: PayloadInputOf<"feed.shown"> = {
            worker_id: workerId,
            job_id: item.job_id,
            rank: item.rank,
            // Honest unranked values — nothing scored this alpha surface. score/hot
            // also have schema defaults; passed explicitly for clarity.
            score: 0,
            hot: false,
          };
          return {
            event_name: "feed.shown",
            actor: { actor_type: "worker", actor_id: workerId },
            subject: { subject_type: "job", subject_id: item.job_id },
            payload,
            correlationId: ctx.correlationId,
            requestId: ctx.requestId,
          };
        }),
      );
    }

    return { jobs: items };
  }

  /**
   * Record an APPLY. Upserts the (worker, job) decision (last-write-wins) and
   * emits `application.submitted`. Idempotent: a repeat apply hits the unique
   * (worker_id, job_id) and updates in place — one row, no duplicate. The emit is
   * keyed `application.submitted:{worker_id}:{job_id}` so a double-tap is one
   * logical event in the spine (ADR-0009 §4 recommendation). 404 if the job is
   * unknown (no existence oracle).
   */
  async apply(workerId: string, jobId: string, dto: ApplyJobDto, ctx: RequestContext) {
    await this.assertJobExists(jobId);

    const saved = await this.repo.upsertDecision({
      workerId,
      jobId,
      action: "applied",
      reason: null,
      sourceSurface: dto.source_surface,
      rank: dto.rank,
    });

    const payload: PayloadInputOf<"application.submitted"> = {
      worker_id: workerId,
      job_id: jobId,
      rank: dto.rank,
      source_surface: dto.source_surface,
    };
    await this.events.emit({
      event_name: "application.submitted",
      actor: { actor_type: "worker", actor_id: workerId },
      subject: { subject_type: "job", subject_id: jobId },
      payload,
      idempotencyKey: `application.submitted:${workerId}:${jobId}`,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    return { ok: true as const, application_id: saved.id, action: "applied" as const };
  }

  /**
   * Record a SKIP. Upserts the (worker, job) decision (last-write-wins) and emits
   * `application.skipped` with a coarse enum reason. Idempotent like apply; the
   * emit is keyed `application.skipped:{worker_id}:{job_id}`. 404 if the job is
   * unknown.
   */
  async skip(workerId: string, jobId: string, dto: SkipJobDto, ctx: RequestContext) {
    await this.assertJobExists(jobId);

    const saved = await this.repo.upsertDecision({
      workerId,
      jobId,
      action: "skipped",
      reason: dto.reason,
      sourceSurface: "feed",
      rank: null,
    });

    const payload: PayloadInputOf<"application.skipped"> = {
      worker_id: workerId,
      job_id: jobId,
      reason: dto.reason,
    };
    await this.events.emit({
      event_name: "application.skipped",
      actor: { actor_type: "worker", actor_id: workerId },
      subject: { subject_type: "job", subject_id: jobId },
      payload,
      idempotencyKey: `application.skipped:${workerId}:${jobId}`,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    return { ok: true as const, application_id: saved.id, action: "skipped" as const };
  }

  /** Applicants for a job (ops). PII-free projection — worker_id only. */
  async applicantsForJob(jobId: string) {
    const rows = await this.repo.findApplicantsByJob(jobId);
    return {
      job_id: jobId,
      applicants: rows.map((a) => ({
        worker_id: a.workerId,
        action: a.action,
        reason: a.reason,
        source_surface: a.sourceSurface,
        rank: a.rank,
        created_at: a.createdAt,
        updated_at: a.updatedAt,
      })),
    };
  }

  /** A worker's decisions (ops), joined to coarse job fields. No employer, no pay. */
  async applicationsForWorker(workerId: string) {
    const rows = await this.repo.findApplicationsByWorker(workerId);
    return {
      worker_id: workerId,
      applications: rows.map((a) => ({
        job_id: a.jobId,
        trade_key: a.tradeKey,
        title: a.title,
        city: a.city,
        area: a.area,
        action: a.action,
        reason: a.reason,
        source_surface: a.sourceSurface,
        rank: a.rank,
        created_at: a.createdAt,
        updated_at: a.updatedAt,
      })),
    };
  }

  /** 404 (no oracle) if the job id does not resolve to a row. */
  private async assertJobExists(jobId: string): Promise<void> {
    const job = await this.repo.findJobById(jobId);
    if (!job) throw new NotFoundException(`Job ${jobId} not found`);
  }
}
