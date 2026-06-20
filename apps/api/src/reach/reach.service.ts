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
import { ReachRepository } from "./reach.repository";
import { workerProfileRowToSignals } from "./reach.mappers";
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
 *    View-B response length == candidate-job count (`count in == count out`).
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
   * View A — payer applicant list (`GET /reach/jobs/:jobId/applicants`). Resolves the
   * job, scores the FULL worker pool via the core, and renders faceless ranked rows.
   */
  async applicantsForJob(jobId: string, ctx: RequestContext): Promise<ApplicantListResponseDto> {
    const jobSpec = await this.jobs.getJobSpec(jobId);
    if (!jobSpec) throw new NotFoundException(`Job ${jobId} not found`);

    // Full pool, signal columns only, NO relevance WHERE (sort-never-block, D8).
    const rows = await this.repo.listSignalRows();
    const now = new Date();
    const signals: WorkerSignals[] = rows.map((r) => workerProfileRowToSignals(r, now));

    // The core orders + flags; the serving layer never reimplements scoring/ordering.
    const ranked: RankedWorker[] = rankWorkersForJob(jobSpec, signals);

    const applicants: ApplicantRowDto[] = ranked.map((r) => ({
      workerId: r.workerId,
      rank: r.rank,
      score: r.score,
      hot: r.hot,
      pushEligible: r.pushEligible,
      components: r.components,
    }));

    // One feed.shown per rendered row, UNKEYED (D7), as ONE all-or-nothing batch
    // (emitMany: build+validate all, single round-trip — matches actions.recordBatch;
    // avoids a half-written impression set on the full-pool path). `hot` is the core's
    // tag; the response-only `pushEligible` has no event field (the payload has no key).
    await this.events.emitMany(
      ranked.map((r) =>
        this.feedShownParams(
          { worker_id: r.workerId, job_id: jobSpec.jobId, rank: r.rank, score: r.score, hot: r.hot },
          ctx,
        ),
      ),
    );

    return { jobId: jobSpec.jobId, applicants };
  }

  /**
   * PAYER-SELF View A (`GET /payer/reach/jobs/:jobId/applicants`, ADR-0019 R22 / PR2).
   * IDENTICAL faceless ranking to {@link applicantsForJob} — the deltas are exactly two:
   *  (1) OWNERSHIP: the job is resolved via the payer-scoped, no-oracle ownership read
   *      (`findOwnedJobSignalRowById`) — a not-found job and another payer's job both
   *      resolve to the SAME neutral 404, so a payer cannot enumerate jobs they do not
   *      own (XB-A horizontal authz + F-3 no-oracle). `payer_id` is consumed only in the
   *      ownership WHERE and NEVER enters the JobSpec/response/event.
   *  (2) ACTOR: each `feed.shown` carries `{actor_type:"payer", actor_id: payerId}` (bound
   *      to the verified session — never the body), vs the ops path's `system` actor.
   * The RANK core, the faceless worker projection, and the response shape are UNCHANGED
   * (no new scoring, no LLM, sort-never-block, count-in==count-out).
   */
  async applicantsForOwnedJob(
    jobId: string,
    payerId: string,
    ctx: RequestContext,
  ): Promise<ApplicantListResponseDto> {
    const ownedRow = await this.repo.findOwnedJobSignalRowById(jobId, payerId);
    // Not-found AND not-owned both land here with the IDENTICAL body (no-oracle, F-3).
    if (!ownedRow) throw new NotFoundException("Job not found");
    const jobSpec = jobSignalRowToJobSpec(ownedRow);

    // Full pool, signal columns only, NO relevance WHERE (sort-never-block, D8).
    const rows = await this.repo.listSignalRows();
    const now = new Date();
    const signals: WorkerSignals[] = rows.map((r) => workerProfileRowToSignals(r, now));

    const ranked: RankedWorker[] = rankWorkersForJob(jobSpec, signals);

    const applicants: ApplicantRowDto[] = ranked.map((r) => ({
      workerId: r.workerId,
      rank: r.rank,
      score: r.score,
      hot: r.hot,
      pushEligible: r.pushEligible,
      components: r.components,
    }));

    // One feed.shown per row, UNKEYED (D7), with the PAYER as the actor (actor_id is the
    // verified session payer — never the route/body). payer_id stays opaque in the event.
    await this.events.emitMany(
      ranked.map((r) =>
        this.feedShownParams(
          { worker_id: r.workerId, job_id: jobSpec.jobId, rank: r.rank, score: r.score, hot: r.hot },
          ctx,
          { actor_type: "payer", actor_id: payerId },
        ),
      ),
    );

    return { jobId: jobSpec.jobId, applicants };
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
