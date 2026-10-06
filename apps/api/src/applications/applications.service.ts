import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { PayloadInputOf } from "@badabhai/event-schema";
import { isFeedPostingsUnionEnabled, isMatchV1Enabled, type ServerConfig } from "@badabhai/config";
import type { JobShift } from "@badabhai/db";
import type { TradeFormKindName } from "@badabhai/types";
import { isTradeKey, matchSkillLabel, type TradeKey } from "@badabhai/taxonomy";
import type { RequestContext } from "../common/request-context";
import { SERVER_CONFIG } from "../config/config.module";
import { EventsService, type EmitParams } from "../events/events.service";
import { MatchFeedService, type MatchFeedItem } from "../match/match-feed.service";
import { MatchApplyService, type RankSnapshot } from "../match/match-apply.service";
import { WorkerSkillsRepository } from "../match/worker-skills.repository";
import {
  ApplicationsRepository,
  type FeedJob,
  type FeedPostingRow,
  type OpenJobsFilters,
} from "./applications.repository";
import type { ApplyJobDto, SkipJobDto } from "./applications.dto";
import {
  mergeNewestFirst,
  rankFeed,
  toSourcedFromJob,
  toSourcedFromPosting,
  type FeedSource,
  type RankedFeedItem,
  type SourcedFeedItem,
} from "./feed-merge";

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
  /**
   * WHAT THE PAY BAND MEANS (#1648): `in_hand` | `gross` | `ctc`, or NULL for "the poster
   * did not state it" — in which case the card shows the band with no pay-type pill. Never
   * defaulted, never inferred: the worker's first question deserves a real answer or none.
   */
  pay_type: FeedJob["payType"];
  shift: FeedJob["shift"];
  // Worker-visible card content (#1561). ADDITIVE — a client that ignores them renders
  // exactly what it rendered before. Straight pass-through of the row's own columns,
  // nulls preserved (see the interface doc above for the honest-nulls doctrine).
  description: string | null;
  benefits: string[] | null;
  requirements: string[] | null;
  needed_by: FeedJob["neededBy"];
  /**
   * WHEN THIS JOB WAS POSTED (#1649) — `jobs.created_at`, the legacy path's twin of
   * `MatchFeedItem.posted_at`. SAME KEY NAME on both shapes deliberately: a client must not
   * have to know which source the flag selected to read a date, and two keys would make
   * "N naye jobs (aaj)" mean different things on either side of `MATCH_V1_ENABLED`.
   *
   * ISO-8601 UTC. Never null here (the column is NOT NULL), but typed nullable to match
   * the V1 shape, where an unpublished-but-served posting genuinely has none.
   */
  posted_at: string | null;
  /**
   * THE JOB'S ROLE, FOR THE CARD'S ILLUSTRATION (owner ruling 2026-10-05, ADR-0024 addendum) —
   * the twin of `MatchFeedItem.role_kind`, same key on both feed shapes. One of the 21 declared
   * kinds or NULL. ADDITIVE; drawn as art, never text; never a filter/rank input; not on
   * `feed.shown`.
   */
  role_kind: TradeFormKindName | null;
  rank: number;
}

/**
 * The worker's own `GET /feed` filters, as the controller hands them over. Every one is
 * OPTIONAL; absent means "not filtered" and nothing here fills one in from his profile
 * (ADR-0036 Part 3).
 */
export interface FeedFilters {
  /**
   * RAW query value, NOT yet known to be a trade slug. The worker app has sent a chip
   * display label (`'CNC'`, `'Welder'`) here, which can never equal `jobs.trade_key`; see
   * `resolveLegacyTradeKey` below for what happens to it (#1905).
   */
  tradeKey?: string;
  city?: string;
  shift?: JobShift;
  /** The worker's pay FLOOR (₹/month). Compared to the TOP of a job's band. */
  payMin?: number;
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
  private readonly logger = new Logger(ApplicationsService.name);

  constructor(
    private readonly repo: ApplicationsRepository,
    private readonly events: EventsService,
    // ADR-0036 — the V1 source, selected by MATCH_V1_ENABLED. Both are injected
    // unconditionally (they are cheap, stateless, and @Global via MatchModule); only
    // the FLAG decides which path runs, so a mis-wired DI cannot silently half-cut-over.
    private readonly matchFeed: MatchFeedService,
    private readonly matchApply: MatchApplyService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    // #1823 — the worker's wanted skill ids, for the union posting arm's #1240 relevance
    // rule. Appended LAST so no existing argument moves. No import edge is needed:
    // MatchModule is `@Global` (the `JobsService` precedent).
    private readonly workerSkills: WorkerSkillsRepository,
  ) {}

  /**
   * Return up to `limit` open jobs in deterministic order and emit ONE
   * `feed.shown` per returned job (one impression each, rank = 1-based position).
   * R-A resolved: bounded per-impression, NO dedupe — every fetch records the
   * impressions, so the emits are intentionally UNKEYED (always insert), batched
   * into a single DB round-trip via `emitMany`.
   */
  async getFeed(
    workerId: string,
    limit: number,
    filters: FeedFilters,
    ctx: RequestContext,
  ): Promise<{ jobs: FeedItem[] | MatchFeedItem[] }> {
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

    // ── #1823 / ADR-0049 — THE INTERIM UNION (dark behind FEED_POSTINGS_UNION_ENABLED) ──
    // Off: the agency/seed `jobs` scan alone, exactly as before. On (and only while V1 is
    // off): company `job_postings` merged into the same deck, newest-first. Either way the
    // card is the same 17 keys, rank is the 1-based position in the deck as served (newest
    // first — see the repository), and every card gets one `feed.shown` v1.
    //
    // #1905: every filter the worker sent reaches the query. The trade key is resolved
    // against the taxonomy first, so a chip label cannot zero the jobs arm.
    const jobFilters: OpenJobsFilters = {
      tradeKey: this.resolveLegacyTradeKey(filters.tradeKey, ctx),
      city: filters.city,
      shift: filters.shift,
      payMin: filters.payMin,
    };
    const sourced = isFeedPostingsUnionEnabled(this.config)
      ? await this.readUnionFeed(workerId, limit, jobFilters)
      : (await this.repo.findOpenJobs(workerId, limit, jobFilters)).map(toSourcedFromJob);
    const ranked = rankFeed(sourced);

    if (ranked.length > 0) {
      await this.events.emitMany(ranked.map((card) => this.feedShown(workerId, card, ctx)));
    }

    return { jobs: ranked.map((card) => card.item) };
  }

  /**
   * Both arms of the union, merged. The jobs arm is the legacy read with every filter; the
   * posting arm takes the worker's wanted skills, city, shift and pay floor — never
   * `trade_key` (V1 precedent, O7). Shift and pay are the SAME predicates on both arms
   * (feed-filter.predicates, #1905), so neither half of the deck is narrowed alone.
   *
   * FAIL CLOSED: any rejection — either read, or the skill lookup — fails the whole `/feed`
   * before a single `feed.shown` is written. A half deck served as if whole would record
   * impressions of a feed the worker was never actually shown.
   */
  private async readUnionFeed(
    workerId: string,
    limit: number,
    filters: OpenJobsFilters,
  ): Promise<SourcedFeedItem[]> {
    const readPostings = (wantedSkillIds: string[]) =>
      this.repo.findOpenPostingsForFeed(workerId, limit, {
        city: filters.city,
        shift: filters.shift,
        payMin: filters.payMin,
        wantedSkillIds,
      });
    const [jobRows, postingRows] = await Promise.all([
      this.repo.findOpenJobs(workerId, limit, filters),
      this.workerSkills.listWantedSkillIds(workerId).then(readPostings),
    ]);
    return mergeNewestFirst(jobRows.map(toSourcedFromJob), this.toPostingArm(postingRows), limit);
  }

  /** Map the posting rows; a row with no `published_at` is dropped and logged, never coerced. */
  private toPostingArm(rows: readonly FeedPostingRow[]): SourcedFeedItem[] {
    const arm: SourcedFeedItem[] = [];
    for (const row of rows) {
      const sourced = toSourcedFromPosting(row);
      if (sourced) arm.push(sourced);
      else this.logger.warn(`feed: dropped posting ${row.id} — no published_at to order it by`);
    }
    return arm;
  }

  /**
   * ONE `feed.shown` v1 for one served card, payload unchanged: exactly
   * {worker_id, job_id, rank, score, hot}. The ENVELOPE names the id space — subject `job`
   * for a `jobs.id`, `job_posting` for a `job_postings.id` — the same discriminator V1 ships
   * for `application.*` (ADR-0049 S2). Never `feed.shown_v2`: that requires a reach row.
   */
  private feedShown(
    workerId: string,
    { source, item }: RankedFeedItem,
    ctx: RequestContext,
  ): EmitParams<"feed.shown"> {
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
      subject: { subject_type: source, subject_id: item.job_id },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    };
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
    const target = await this.resolveDecisionTarget(jobId);
    return target === "job"
      ? this.applyJob(workerId, jobId, dto, ctx)
      : this.applyPosting(workerId, jobId, dto, ctx);
  }

  /**
   * Record a SKIP. Upserts the (worker, job) decision (last-write-wins) and emits
   * `application.skipped` with a coarse enum reason. Idempotent like apply; the
   * emit is keyed `application.skipped:{worker_id}:{job_id}`. 404 if the job is
   * unknown.
   */
  async skip(workerId: string, jobId: string, dto: SkipJobDto, ctx: RequestContext) {
    if (isMatchV1Enabled(this.config)) return this.skipV1(workerId, jobId, dto, ctx);
    const target = await this.resolveDecisionTarget(jobId);
    return target === "job"
      ? this.skipJob(workerId, jobId, dto, ctx)
      : this.recordPostingSkip(workerId, jobId, dto, ctx);
  }

  /**
   * WHICH TABLE A FLAG-OFF DECISION LANDS IN (#1823). The route stays a bare uuid: a type tag
   * would break `ParseUUIDPipe` and every shipped client, which posts the feed's `job_id`
   * straight back.
   *
   *   1. an OPEN `jobs` row → `job` (today's path, and the `GET /jobs/:jobId` precedence, so
   *      feed, detail and apply resolve an id the same way; on a v4 collision `job` wins);
   *   2. only with the union armed, an OPEN `job_postings` row → `job_posting`;
   *   3. otherwise the identical neutral 404 — unknown, closed, paused, suspended and draft
   *      all look alike, with no write and no event (no existence oracle).
   *
   * The gate is "open posting", not "has a reach row": search and detail already show any
   * open posting, and a stricter apply gate would keep their dead end.
   */
  private async resolveDecisionTarget(jobId: string): Promise<FeedSource> {
    if (await this.repo.findJobById(jobId)) return "job";
    if (isFeedPostingsUnionEnabled(this.config) && (await this.repo.findOpenPostingRef(jobId))) {
      return "job_posting";
    }
    throw new NotFoundException("Job not found");
  }

  /** The legacy apply on an agency/seed `jobs` row — today's body, unchanged. */
  private async applyJob(workerId: string, jobId: string, dto: ApplyJobDto, ctx: RequestContext) {
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

  /** The legacy skip on an agency/seed `jobs` row — today's body, unchanged. */
  private async skipJob(workerId: string, jobId: string, dto: SkipJobDto, ctx: RequestContext) {
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

  /**
   * Applicants for a job (ops). PII-free projection — worker_id only.
   *
   * #1823: `jobId` is either id space. A decision on an agency/seed job carries `job_id`; one
   * on a company posting (V1, or the interim union feed) carries `job_posting_id` with
   * `job_id` NULL, so reading `job_id` alone made every posting's applicants invisible.
   * The id space is resolved FIRST so each read stays a single-column equality on its own
   * index: a `jobs` id in any status reads `job_id`, anything else reads `job_posting_id`.
   * That equals `job_id = $1 OR job_posting_id = $1` — `applications.job_id` is a FK to
   * `jobs`, so an id with no `jobs` row has no `job_id` rows — except on a cross-table v4
   * collision, where the job wins (the `GET /jobs/:jobId` precedence).
   * Ungated by any flag: it reads rows that exist, and disarming a feed must never hide who
   * already applied.
   */
  async applicantsForJob(jobId: string) {
    const rows = (await this.repo.legacyJobExists(jobId))
      ? await this.repo.findApplicantsByJob(jobId)
      : await this.repo.findApplicantsByPosting(jobId);
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

  /**
   * The legacy arm's TRADE filter, or `undefined` for "no trade filter" (#1905).
   *
   * Only a slug in `TRADE_KEYS` filters. Anything else is IGNORED (the request is served as if
   * no trade filter had been sent), not 400'd. That is the owner ruling. Every `jobs` row
   * carries one of those 15 slugs (the agency DTO and the seed both enforce it), so an unknown
   * value matches no row at all, and filtering on it returns an EMPTY deck. That is what a
   * one-chip refetch did while the app sent its chip LABEL (`'CNC'`) instead of the slug.
   * Ignoring it restores the full arm; a valid slug filters exactly as before.
   *
   * Single-valued by contract: `trade_key` is `z.string()` in the DTO, so a repeated query
   * param is a 400 at the boundary and never reaches here as a list.
   *
   * The drop is LOGGED so the app-side bug stays observable rather than silently healed. The
   * value itself is NOT logged: it is unconstrained client input with no length cap, so it
   * could carry anything. Its length and the request id are enough to find and correlate it.
   * An empty value (`?trade_key=`) is "no filter", exactly as before, not a dropped value.
   */
  private resolveLegacyTradeKey(raw: string | undefined, ctx: RequestContext): TradeKey | undefined {
    if (raw === undefined || raw === "") return undefined;
    if (isTradeKey(raw)) return raw;
    this.logger.warn(
      `feed trade_key ignored: not a known trade slug (length=${raw.length}) request_id=${ctx.requestId}`,
    );
    return undefined;
  }

  // ── ADR-0036 MOMENT ⑤ — apply/skip against the SERVED entity ─────────────────

  /**
   * V1 apply. `jobId` is a `job_postings.id` here (the feed serves postings).
   *
   * THE REACH ROW IS THE GATE AND THE ORACLE IS CLOSED: `buildSnapshot` 404s with the
   * identical neutral body when the worker has no `job_reach` row on an OPEN posting —
   * he can only apply to what the gate showed him, and a missing row is indistinguishable
   * from a missing or no-longer-open posting. That is stronger than the legacy path's
   * open-job check (`findJobById`), deliberately.
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
    return this.recordPostingApply(workerId, jobPostingId, dto, snapshot, ctx);
  }

  /**
   * V1 skip. Same reach gate as apply — a worker cannot skip a posting he was never
   * shown, and answering differently for one he was not would be an existence oracle.
   */
  private async skipV1(
    workerId: string,
    jobPostingId: string,
    dto: SkipJobDto,
    ctx: RequestContext,
  ) {
    await this.matchApply.buildSnapshot(workerId, jobPostingId); // the 404 gate only
    return this.recordPostingSkip(workerId, jobPostingId, dto, ctx);
  }

  /**
   * #1823 — an apply on a company posting from the interim union (MATCH_V1 off). The gate
   * already ran: `resolveDecisionTarget` found the posting OPEN. The rank inputs are frozen
   * whenever a reach row exists and the row carries none otherwise (ADR-0049 S3) — the union
   * serves by the #1240 skill rule, so a reach row is not a precondition here.
   */
  private async applyPosting(
    workerId: string,
    jobPostingId: string,
    dto: ApplyJobDto,
    ctx: RequestContext,
  ) {
    const snapshot = await this.matchApply.trySnapshot(workerId, jobPostingId);
    return this.recordPostingApply(workerId, jobPostingId, dto, snapshot, ctx);
  }

  /**
   * THE ONE POSTING APPLY WRITER, shared by V1 and the interim union so a posting decision
   * has one shape whichever flag served it: `applications.job_posting_id` set and `job_id`
   * NULL, the E16 snapshot freeze in SQL, subject `job_posting`, and the same idempotency key
   * — so a union apply and a later V1 apply on the same posting are one logical event.
   * The caller has already passed its gate and chosen the snapshot.
   */
  private async recordPostingApply(
    workerId: string,
    jobPostingId: string,
    dto: ApplyJobDto,
    snapshot: RankSnapshot | null,
    ctx: RequestContext,
  ) {
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
   * THE ONE POSTING SKIP WRITER, shared by V1 and the interim union (see
   * {@link recordPostingApply}). The caller has already passed its gate.
   *
   * NO SNAPSHOT IS WRITTEN ON A SKIP. A skip is never ranked (the rank index is partial
   * on `action='applied'`), so freezing rank inputs for one would store numbers no
   * reader consumes — and would then have to be protected from rewrite on the flip to
   * apply, which is precisely the moment the real snapshot must be taken.
   */
  private async recordPostingSkip(
    workerId: string,
    jobPostingId: string,
    dto: SkipJobDto,
    ctx: RequestContext,
  ) {
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
