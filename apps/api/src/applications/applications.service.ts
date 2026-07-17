import { Injectable, NotFoundException } from "@nestjs/common";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { RequestContext } from "../common/request-context";
import { EventsService, type EmitParams } from "../events/events.service";
import { ApplicationsRepository, type FeedJob } from "./applications.repository";
import type { ApplyJobDto, SkipJobDto } from "./applications.dto";

/**
 * A feed item the worker sees — PII-free (no employer, and the pay is the BAND
 * as stored, never an exact salary). The experience window is year counts and
 * the pay band is integer ₹ bounds — both classed PII-FREE by the schema
 * (never an employer, never a worker identity).
 *
 * `min_experience_years`/`max_experience_years` are passed through HONESTLY,
 * nulls included: null min = "no floor", null max = "open-ended". A client
 * filtering on experience reads the window as [min ?? 0, max ?? infinity], so a
 * job with NO experience data spans [0, infinity] and matches EVERY band — it is
 * never silently dropped. That is deliberate, and consistent with this alpha
 * feed's liberal philosophy (cf. the LOCATION SEAM in the repository): a blank
 * field must never cost a job its impressions. Do NOT coerce these nulls to 0.
 *
 * `pay_min`/`pay_max`/`shift` (ADR-0024 final addendum, 2026-07-16) follow the
 * SAME doctrine: additive, nullable, passed through un-coerced — a job with no
 * band/shift shows none (the client hides the row), it is never fabricated and
 * never dropped. Response-only fields: `feed.shown` is UNCHANGED (its payload
 * stays exactly {worker_id, job_id, rank, score, hot} — no version bump).
 */
export interface FeedItem {
  job_id: string;
  trade_key: string;
  title: string;
  city: string;
  area: string | null;
  min_experience_years: number | null;
  max_experience_years: number | null;
  pay_min: number | null;
  pay_max: number | null;
  shift: FeedJob["shift"];
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
      // Straight pass-through, nulls preserved (see FeedItem) — the window is the
      // job's own data, not a ranking signal; nothing here scores or drops a job.
      min_experience_years: job.minExperienceYears,
      max_experience_years: job.maxExperienceYears,
      // ADR-0024 final addendum: pay band + shift join the PII-free set under the
      // same honest-nulls pass-through. Response-only — feed.shown is UNCHANGED.
      pay_min: job.payMin,
      pay_max: job.payMax,
      shift: job.shift,
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

    // Bump the job's denormalized applies counter ONLY on a genuine first apply
    // (a brand-new row, action='applied'). This is idempotent: a double-tap hits
    // ON CONFLICT DO UPDATE (`inserted === false`) and never double-counts. NO new
    // event — `application.submitted` (emitted below) remains the audit record; the
    // counter is just a denormalized rollup.
    //
    // ACCEPTED alpha limitation: a skip→apply FLIP on an existing row is an UPDATE
    // (`inserted === false`), so it will NOT increment the counter — the row already
    // existed from the skip. Likewise an apply→skip flip never DECREMENTS (the
    // counter is a monotonic count of received applies). This is a deliberate alpha
    // simplification, not a bug.
    if (saved.inserted) {
      await this.repo.incrementApplicantsReceived(jobId);
    }

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
