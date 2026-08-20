import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { PayloadInputOf } from "@badabhai/event-schema";
import { isMatchV1Enabled, type ServerConfig } from "@badabhai/config";
import { matchSkillLabel } from "@badabhai/taxonomy";
import type { RequestContext } from "../common/request-context";
import { SERVER_CONFIG } from "../config/config.module";
import { EventsService, type EmitParams } from "../events/events.service";
import { MatchFeedService, type MatchFeedItem } from "../match/match-feed.service";
import { MatchApplyService } from "../match/match-apply.service";
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
    // ADR-0036 — the V1 source, selected by MATCH_V1_ENABLED. Both are injected
    // unconditionally (they are cheap, stateless, and @Global via MatchModule); only
    // the FLAG decides which path runs, so a mis-wired DI cannot silently half-cut-over.
    private readonly matchFeed: MatchFeedService,
    private readonly matchApply: MatchApplyService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  /**
   * Return up to `limit` open jobs in deterministic order and emit ONE
   * `feed.shown` per returned job (one impression each, rank = 1-based position).
   * R-A resolved: bounded per-impression, NO dedupe — every fetch records the
   * impressions, so the emits are intentionally UNKEYED (always insert), batched
   * into a single DB round-trip via `emitMany`.
   */
  async getFeed(workerId: string, limit: number, filters: { tradeKey?: string; city?: string; shift?: string; payMin?: number }, ctx: RequestContext): Promise<{ jobs: FeedItem[] | MatchFeedItem[] }> {
    // ── ADR-0036 MOMENT ④ ─────────────────────────────────────────────────────
    // The route, the guards, the `{ jobs: [...] }` envelope and the Flutter client are
    // UNCHANGED. Only the SOURCE moves: `job_reach ⋈ job_postings` instead of the
    // legacy `jobs` scan. The V1 card is a superset of the legacy one (see
    // `MatchFeedItem`), so a client that has not been updated keeps working.
    //
    // NOTE the `trade_key` filter is deliberately NOT forwarded to the V1 path: V1 has
    // no trade dimension (the matchable unit is the `mskill_*` id, and reach ALREADY
    // restricts the feed to skills the worker holds and wants). Passing a legacy trade
    // slug through would be a second, weaker skill filter layered on top of the real
    // gate — and Part 3 is explicit that a filter must never narrow by default.
    if (isMatchV1Enabled(this.config)) {
      return this.matchFeed.getFeed(
        workerId,
        limit,
        { city: filters.city, shift: filters.shift, payMin: filters.payMin },
        ctx,
      );
    }

    const openJobs = await this.repo.findOpenJobs(workerId, limit, filters);
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
    if (isMatchV1Enabled(this.config)) return this.applyV1(workerId, jobId, dto, ctx);
    await this.assertJobExists(jobId);

    // TD38: read the existing decision BEFORE upsert to detect skip→apply flips.
    const existing = await this.repo.findDecision(workerId, jobId);

    const saved = await this.repo.upsertDecision({
      workerId,
      jobId,
      action: "applied",
      reason: null,
      sourceSurface: dto.source_surface,
      rank: dto.rank,
    });

    // Bump the job's denormalized applies counter on a genuine first apply (new
    // row) OR a skip→apply flip (existing row was not already applied). Double-tap
    // (re-applying an already-applied row) never double-counts.
    const flippedToApplied = existing != null && existing.action !== "applied";
    if (saved.inserted || flippedToApplied) {
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
    if (isMatchV1Enabled(this.config)) return this.skipV1(workerId, jobId, dto, ctx);
    await this.assertJobExists(jobId);

    // TD73: prevent applied->skipped downgrade (e.g. from >500 decisions upsert-overwrite)
    const existing = await this.repo.findDecision(workerId, jobId);
    if (existing?.action === "applied") {
      return { ok: true as const, application_id: existing.id, action: "applied" as const };
    }

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
        // #1051. ADDITIVE and display-safe. `trade_key` above is an INTERNAL key that is NULL
        // for every V1 decision, so it is not something a client can render; this is the human
        // half, from the same closed-set taxonomy the feed uses. NULL for a legacy decision
        // (no reach row) and NULL for an id the taxonomy does not know — which is the honest
        // answer, and lets the client fall back rather than print an id.
        matched_skill_label:
          a.matchedSkillId === null ? null : (matchSkillLabel(a.matchedSkillId) ?? null),
      })),
    };
  }

  /** 404 (no oracle) if the job id does not resolve to an OPEN row. */
  private async assertJobExists(jobId: string): Promise<void> {
    const job = await this.repo.findJobById(jobId);
    if (!job) throw new NotFoundException("Job not found");
  }

  // ── ADR-0036 MOMENT ⑤ — apply/skip against the SERVED entity ─────────────────

  /**
   * V1 apply. `jobId` is a `job_postings.id` here (the feed serves postings).
   *
   * THE REACH ROW IS THE GATE AND THE ORACLE IS CLOSED: `buildSnapshot` 404s with the
   * identical neutral body when the worker has no `job_reach` row — he can only apply
   * to what the gate showed him, and a missing row is indistinguishable from a missing
   * posting. That is stronger than the legacy path's existence check, deliberately.
   *
   * The snapshot is written on insert and on a skip→apply flip only. E16.
   */
  private async applyV1(
    workerId: string,
    jobPostingId: string,
    dto: ApplyJobDto,
    ctx: RequestContext,
  ) {
    // Freeze the rank inputs FIRST — it is also the 404 gate, so an ungated apply never
    // reaches the write.
    const snapshot = await this.matchApply.buildSnapshot(workerId, jobPostingId);
    const existing = await this.matchApply.findDecision(workerId, jobPostingId);

    const saved = await this.matchApply.upsertDecision({
      workerId,
      jobPostingId,
      action: "applied",
      reason: null,
      sourceSurface: dto.source_surface,
      rank: dto.rank,
      snapshot,
      previousAction: existing?.action ?? null,
    });

    // NOTE: there is no `applicants_received` counter to bump on `job_postings` — that
    // denormalized column lives on the legacy `jobs` table only. The count is derivable
    // from `applications` (and IS, by the candidate list). Adding the column here would
    // be a migration, which is out of this change's boundary.
    const payload: PayloadInputOf<"application.submitted"> = {
      worker_id: workerId,
      // The shipped v1 payload field. It carries a `job_postings.id` on this path, and
      // the ENVELOPE disambiguates which id space it is: `subject_type` is
      // "job_posting" here vs "job" on the legacy path. That is why this does NOT need
      // a v2 payload the way `feed.shown` did — no field changed meaning inside the
      // payload's own frame of reference, and the envelope already names the entity.
      job_id: jobPostingId,
      rank: dto.rank,
      source_surface: dto.source_surface,
    };
    await this.events.emit({
      event_name: "application.submitted",
      actor: { actor_type: "worker", actor_id: workerId },
      subject: { subject_type: "job_posting", subject_id: jobPostingId },
      payload,
      idempotencyKey: `application.submitted:${workerId}:${jobPostingId}`,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    return { ok: true as const, application_id: saved.applicationId, action: "applied" as const };
  }

  /**
   * V1 skip. Same reach gate as apply — a worker cannot skip a posting he was never
   * shown, and answering differently for one he was not would be an existence oracle.
   *
   * NO SNAPSHOT IS WRITTEN ON A SKIP. A skip is never ranked (the rank index is partial
   * on `action='applied'`), so freezing rank inputs for one would store numbers no
   * reader consumes — and would then have to be protected from rewrite on the flip to
   * apply, which is precisely the moment the real snapshot must be taken.
   */
  private async skipV1(
    workerId: string,
    jobPostingId: string,
    dto: SkipJobDto,
    ctx: RequestContext,
  ) {
    await this.matchApply.buildSnapshot(workerId, jobPostingId); // the 404 gate only

    // TD73 (carried forward): never downgrade an applied row to skipped.
    const existing = await this.matchApply.findDecision(workerId, jobPostingId);
    if (existing?.action === "applied") {
      return { ok: true as const, application_id: existing.id, action: "applied" as const };
    }

    const saved = await this.matchApply.upsertDecision({
      workerId,
      jobPostingId,
      action: "skipped",
      reason: dto.reason,
      sourceSurface: "feed",
      rank: null,
      snapshot: null,
      previousAction: existing?.action ?? null,
    });

    const payload: PayloadInputOf<"application.skipped"> = {
      worker_id: workerId,
      job_id: jobPostingId,
      reason: dto.reason,
    };
    await this.events.emit({
      event_name: "application.skipped",
      actor: { actor_type: "worker", actor_id: workerId },
      subject: { subject_type: "job_posting", subject_id: jobPostingId },
      payload,
      idempotencyKey: `application.skipped:${workerId}:${jobPostingId}`,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    return { ok: true as const, application_id: saved.applicationId, action: "skipped" as const };
  }
}
