import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  rankWorkersForJob,
  scoreWorkerForJob,
  type RankedWorker,
  type WorkerJobScore,
  type WorkerSignals,
} from "@badabhai/reach-engine";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { RequestContext } from "../common/request-context";
import { EventsService, type EmitParams } from "../events/events.service";
import type { PayerTenantScope, TenantKey } from "../payers/payer-tenant-scope";
import { ReachRepository, type JobSignalRow } from "./reach.repository";
import {
  workerProfileRowToSignals,
  workerProfileRowToBands,
  type WorkerBands,
  type WorkerProfileSignalRow,
} from "./reach.mappers";
import { JOB_SOURCE, type JobSource, jobSignalRowToJobSpec } from "./reach.job-source";
import type {
  ApplicantListResponseDto,
  ApplicantRowDto,
  FeedJobRowDto,
  WorkerFeedResponseDto,
} from "./reach.dto";

/**
 * Reach serving (ADR-0011) — the first consumer of the deterministic RANK core.
 * Renders two read-only ops views over `@badabhai/reach-engine` (imported, never
 * modified) and emits one `feed.shown` per rendered row.
 *
 * INVARIANTS HELD HERE:
 *  - NO LLM anywhere on this path. Ranking is the deterministic engine, exclusively.
 *  - SORT-NEVER-BLOCK. No relevance filtering: View-A response length == pool length;
 *    the payer-self list's length == the job's applier count (#1898); View-B response
 *    length == candidate-job count (`count in == count out`).
 *  - FACELESS. Responses + events carry opaque ids + ranking signals only.
 *  - `feed.shown` is emitted UNKEYED (D7) — no `idempotencyKey`; each render is an
 *    honest impression, matching the spine's other behavioural/impression events.
 */
@Injectable()
export class ReachService {
  constructor(
    private readonly repo: ReachRepository,
    private readonly events: EventsService,
    @Inject(JOB_SOURCE) private readonly jobs: JobSource,
  ) {}

  /**
   * View A — the OPS ranked-pool view (`GET /reach/jobs/:jobId/applicants`, internal ops
   * console only). Resolves the job, scores the FULL eligible worker pool via the core, and
   * renders faceless ranked rows. Despite the route name these are SUGGESTED workers, not
   * applicants; no payer surface serves this read (#1898) — the payer list is
   * {@link tryApplicantsForOwnedJob}.
   */
  async applicantsForJob(jobId: string, ctx: RequestContext): Promise<ApplicantListResponseDto> {
    const jobSpec = await this.jobs.getJobSpec(jobId);
    if (!jobSpec) throw new NotFoundException(`Job ${jobId} not found`);

    // Full pool, signal columns only, NO relevance WHERE (sort-never-block, D8).
    const rows = await this.repo.listSignalRows();
    const now = new Date();
    const signals: WorkerSignals[] = rows.map((r) => workerProfileRowToSignals(r, now));
    // Faceless banded chips, keyed by the same opaque workerId (count in == count out).
    const bandsByWorker = ReachService.bandsByWorker(rows);

    // The core orders + flags; the serving layer never reimplements scoring/ordering.
    const ranked: RankedWorker[] = rankWorkersForJob(jobSpec, signals);

    const applicants = ReachService.toApplicantRows(ranked, bandsByWorker);

    // One feed.shown per rendered row, UNKEYED (D7), as ONE all-or-nothing batch
    // (emitMany: build+validate all, single round-trip — matches actions.recordBatch;
    // avoids a half-written impression set on the full-pool path). `hot` is the core's
    // tag; the response-only `pushEligible` has no event field (the payload has no key).
    await this.events.emitMany(
      ranked.map((r) =>
        this.feedShownParams(
          {
            worker_id: r.workerId,
            job_id: jobSpec.jobId,
            rank: r.rank,
            score: r.score,
            hot: r.hot,
          },
          ctx,
        ),
      ),
    );

    return { jobId: jobSpec.jobId, applicants };
  }

  /**
   * PAYER-SELF applicant list for an owned legacy `jobs` row
   * (`GET /payer/reach/jobs/:jobId/applicants`, ADR-0019 R22; #1898): `undefined` when `jobId`
   * is not a `jobs` row the tenant owns (unknown and another tenant's job alike), the ranked
   * APPLIERS otherwise (possibly empty — a job nobody applied to is an empty list, not a 404).
   * The payer applicant list (`PayerApplicantsService.listForOwned`, #1823) uses it to tell an
   * agency job from a company posting in ONE ownership read, with no exception as control
   * flow, and owns the neutral 404. A DB error propagates; it is never folded into `undefined`,
   * so it can never become a 404.
   *
   * #1898 (owner ruling): an agency's applicants are the workers who APPLIED to that job —
   * `applications.job_id = jobId AND action = 'applied'` — never the ranked worker pool
   * (CLAUDE.md §2: never show irrelevant candidates). The appliers are ordered by the SAME
   * deterministic RANK core as the ops view (no LLM, no new scoring); the core orders, it never
   * filters (count in == count out over the appliers). The whole-pool ranking stays ONLY on the
   * ops view {@link applicantsForJob}.
   *
   *  (1) OWNERSHIP: the job is resolved via the tenant-scoped, no-oracle ownership read
   *      (`findOwnedJobSignalRowById` on `scope.tenantKey`, ADR-0053). `payer_id` is consumed
   *      only in the ownership WHERE and NEVER enters the JobSpec/response/event.
   *  (2) ACTOR: each `feed.shown` carries `{actor_type:"payer", actor_id: scope.actorPayerId}`
   *      (the verified session login — never the body), vs the ops path's `system` actor.
   *
   * `scope` is the caller's ONE resolution of the session payer (ADR-0053 §5.2 rule 1).
   * (The 404-throwing wrapper `applicantsForOwnedJob` had no production caller and was removed
   * in PR #2167.)
   */
  async tryApplicantsForOwnedJob(
    jobId: string,
    scope: PayerTenantScope,
    ctx: RequestContext,
  ): Promise<ApplicantListResponseDto | undefined> {
    const ownedRow = await this.repo.findOwnedJobSignalRowById(jobId, scope.tenantKey);
    if (!ownedRow) return undefined;

    // #1898: ONLY the workers who applied to this job — read by the job id the ownership read
    // returned, never the route value. Signal columns only, as the pool read.
    const rows = await this.repo.listApplicantSignalRowsForJob(ownedRow.jobId);
    const applicants = ReachService.rankAppliers(ownedRow, rows, new Date());

    // One feed.shown per row, UNKEYED (D7), with the PAYER as the actor (actor_id is the
    // verified session login — never the route/body, never the tenant). payer_id stays opaque
    // in the event. emitMany([]) is a no-op, so a job with no appliers writes nothing.
    await this.emitPayerFeedShown(
      applicants.map((row) => ({ jobId: ownedRow.jobId, row })),
      scope.actorPayerId,
      ctx,
    );

    return { jobId: ownedRow.jobId, applicants };
  }

  /**
   * The payer's cross-posting inbox (`GET /payer/reach/applicants`): the ranked applier rows of
   * several legacy `jobs` rows the TENANT owns (ADR-0053), keyed by job id — each list exactly what
   * {@link tryApplicantsForOwnedJob} renders for that job (same membership, same
   * {@link rankAppliers}), in TWO reads whatever the number of jobs.
   *
   * EMITS NOTHING. The inbox shows only some of these rows on a page, so it decides which
   * impressions happened and records them through {@link emitPayerFeedShown}. A job id the
   * tenant does not own (or that does not exist) is absent from the map — the batched ownership
   * read's no-oracle answer — and its appliers are never read.
   */
  async appliersForOwnedJobs(
    jobIds: readonly string[],
    tenant: TenantKey,
  ): Promise<Map<string, ApplicantRowDto[]>> {
    if (jobIds.length === 0) return new Map();
    const owned = await this.repo.findOwnedJobSignalRowsByIds(jobIds, tenant);
    if (owned.length === 0) return new Map();

    const appliers = await this.repo.listApplicantSignalRowsForJobs(owned.map((j) => j.jobId));
    const rowsByJob = new Map<string, WorkerProfileSignalRow[]>();
    for (const { jobId, row } of appliers) {
      const list = rowsByJob.get(jobId);
      if (list) list.push(row);
      else rowsByJob.set(jobId, [row]);
    }

    const now = new Date();
    return new Map(
      owned.map((job) => [
        job.jobId,
        ReachService.rankAppliers(job, rowsByJob.get(job.jobId) ?? [], now),
      ]),
    );
  }

  /**
   * One `feed.shown` per payer-visible applier row, UNKEYED (D7), as ONE all-or-nothing batch,
   * with the verified SESSION login as the actor (`actor_id`, an opaque uuid — never the
   * payload, and never the tenant key: ADR-0053 §7 keeps the person on the envelope). The payload is the row's own `rank`/`score`/`hot` plus the worker and job ids:
   * the unchanged v1 `FeedShownPayload`. Used by the per-job list and by the inbox, so the two
   * surfaces write the identical impression for the identical row.
   */
  async emitPayerFeedShown(
    shown: ReadonlyArray<{ jobId: string; row: ApplicantRowDto }>,
    actorPayerId: string,
    ctx: RequestContext,
  ): Promise<void> {
    await this.events.emitMany(
      shown.map(({ jobId, row }) =>
        this.feedShownParams(
          {
            worker_id: row.workerId,
            job_id: jobId,
            rank: row.rank,
            score: row.score,
            hot: row.hot,
          },
          ctx,
          { actor_type: "payer", actor_id: actorPayerId },
        ),
      ),
    );
  }

  /**
   * The payer-visible applier list for ONE legacy job — pure. The RANK core orders the appliers
   * (never filters them: count in == count out), then the faceless rows are grafted with their
   * bands. Shared by the per-job list and the inbox so a row means the same thing on both:
   * `rank` and `hot` are positions/fractions WITHIN this job's appliers, which is why the inbox
   * ranks a job's whole applier set even when one of its rows is on the page.
   */
  static rankAppliers(
    job: JobSignalRow,
    rows: WorkerProfileSignalRow[],
    now: Date,
  ): ApplicantRowDto[] {
    const signals: WorkerSignals[] = rows.map((r) => workerProfileRowToSignals(r, now));
    const ranked: RankedWorker[] = rankWorkersForJob(jobSignalRowToJobSpec(job), signals);
    return ReachService.toApplicantRows(ranked, ReachService.bandsByWorker(rows));
  }

  /**
   * View B — worker job feed (`GET /reach/workers/:workerId/feed`). Reuses the core's
   * per-pair `scoreWorkerForJob` (NOT a reimplementation) to derive jobs-for-a-worker,
   * then orders best-first deterministically. D4: `hot` is not surfaced per-job and
   * `pushEligible` is omitted entirely; `feed.shown` carries `hot=false` (honest).
   */
  async feedForWorker(workerId: string, ctx: RequestContext): Promise<WorkerFeedResponseDto> {
    const row = await this.repo.findSignalRowByWorkerId(workerId);
    if (!row) throw new NotFoundException(`No profile for worker ${workerId}`);

    const workerSignals = workerProfileRowToSignals(row, new Date());
    const jobs = await this.jobs.listOpenJobSpecs();

    // One core call per candidate job (count in == count out).
    const scores: WorkerJobScore[] = jobs.map((job) => scoreWorkerForJob(job, workerSignals));

    const ordered = orderJobScores(scores);

    const feed: FeedJobRowDto[] = ordered.map((s, i) => ({
      jobId: s.jobId,
      rank: i + 1,
      score: s.score,
      components: s.components,
    }));

    // One feed.shown per rendered row, UNKEYED (D7), as ONE all-or-nothing batch
    // (emitMany). View B is honestly hot=false.
    await this.events.emitMany(
      feed.map((r) =>
        this.feedShownParams(
          { worker_id: workerId, job_id: r.jobId, rank: r.rank, score: r.score, hot: false },
          ctx,
        ),
      ),
    );

    return { workerId, feed };
  }

  /**
   * Build the params for a single `feed.shown` impression — UNKEYED (D7): no
   * `idempotencyKey`, so it always inserts (each render is a legitimate impression;
   * LEARN windows downstream). PII-free by construction: opaque ids + ranking signals
   * only. Rows are emitted together via `emitMany` so a render is one all-or-nothing batch.
   */
  private feedShownParams(
    payload: PayloadInputOf<"feed.shown">,
    ctx: RequestContext,
    // The ops views (default) have no authenticated actor → `system`. The payer-self
    // view passes its VERIFIED session payer; payer_id rides actor_id (an opaque uuid),
    // never the payload (which has no payer field), so the event stays PII-free.
    actor: EmitParams<"feed.shown">["actor"] = { actor_type: "system" },
  ): EmitParams<"feed.shown"> {
    return {
      event_name: "feed.shown",
      actor,
      // The impression is about the worker (worker_id is the subject across both views).
      subject: { subject_type: "worker", subject_id: payload.worker_id },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
      // NO idempotencyKey — feed.shown is UNKEYED (D7).
    };
  }

  /**
   * Map the projected signal rows → faceless bands, keyed by opaque workerId. Pure +
   * faceless (delegates to {@link workerProfileRowToBands}); built once per view and
   * looked up by the ranked rows (every ranked worker is in the pool — count in == out).
   */
  private static bandsByWorker(rows: WorkerProfileSignalRow[]): Map<string, WorkerBands> {
    return new Map(rows.map((r) => [r.workerId, workerProfileRowToBands(r)]));
  }

  /**
   * Ranked core rows → faceless {@link ApplicantRowDto} rows, grafting the per-worker
   * bands. The engine's `score`/`rank`/`hot`/`pushEligible`/`components` are passed
   * through UNCHANGED (the serving layer never re-scores); bands default to `null` when
   * a worker has no projected signal row (never drops the row — sort-never-block).
   */
  private static toApplicantRows(
    ranked: RankedWorker[],
    bandsByWorker: Map<string, WorkerBands>,
  ): ApplicantRowDto[] {
    return ranked.map((r) => {
      const bands = bandsByWorker.get(r.workerId);
      return {
        workerId: r.workerId,
        rank: r.rank,
        score: r.score,
        hot: r.hot,
        pushEligible: r.pushEligible,
        components: r.components,
        experienceBand: bands?.experienceBand ?? null,
        tradeLabel: bands?.tradeLabel ?? null,
        cityLabel: bands?.cityLabel ?? null,
      };
    });
  }
}

/**
 * Order job scores best-first with the same deterministic discipline the core uses
 * (ADR-0011 §3 step 4): `score` desc, then a stable secondary key, then `jobId` asc for a
 * total, reproducible order. This is thin orchestration in the service; it owns ordering +
 * `rank`, never scoring. A non-finite score sorts lowest (mirrors the core's `finiteScore`).
 *
 * The secondary key is `role` raw contribution desc (more on-trade first) — INTENTIONALLY
 * different from the core's `rankWorkersForJob` tie-break (`activityRaw`). In View B the
 * WORKER is fixed, so the activity signal is constant across every job row and would be a
 * no-op tie-break; `roleRaw` is the meaningful jobs-for-a-worker key. Do not "fix" this to
 * match the core — the contexts differ (workers-for-a-job vs jobs-for-a-worker).
 */
function orderJobScores(scores: WorkerJobScore[]): WorkerJobScore[] {
  return [...scores].sort(
    (a, b) =>
      finiteScore(b) - finiteScore(a) ||
      roleRaw(b) - roleRaw(a) ||
      (a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0),
  );
}

function finiteScore(s: WorkerJobScore): number {
  return Number.isFinite(s.score) ? s.score : -1;
}

function roleRaw(s: WorkerJobScore): number {
  return s.components.find((c) => c.signal === "role")?.raw ?? 0;
}
