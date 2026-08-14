import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { JobNeededBy, JobShift, TradeKey } from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { JobsRepository } from "./jobs.repository";
import type { JobSearchQueryDto } from "./jobs.dto";

/**
 * One row of `GET /jobs/search` (#822). A superset of the feed item — plus `state` and
 * `published_at` — and a strict subset of what a posting holds: no employer identity, no
 * `location_label`, no status, no applicant counts.
 */
export interface JobSearchItem {
  job_id: string;
  title: string;
  city: string | null;
  state: string | null;
  area: string | null;
  pay_min: number | null;
  pay_max: number | null;
  shift: JobShift | null;
  min_experience_years: number | null;
  max_experience_years: number | null;
  matched_skill_label: string | null;
  published_at: string | null;
}

/** The paged envelope. `has_more` is a fact (limit+1 fetch), never an estimate. */
export interface JobSearchResponse {
  jobs: JobSearchItem[];
  page: number;
  limit: number;
  has_more: boolean;
}

/**
 * Wire shape of the worker-visible job detail — EXACTLY the ADR-0024
 * final-addendum (2026-07-16) SHOW set: title, city/area, the pay band AS STORED
 * (band columns, never an exact salary), the experience window, needed_by, and
 * the four worker-visible content columns (description / shift / benefits /
 * requirements — write-guarded fail-closed, so no PII/employer name can be in
 * them). Nulls are passed through HONESTLY — a null field is absent data the
 * client simply hides; it is never fabricated (same doctrine as the FeedItem
 * experience window). NEVER carries `payer_id`, `status`, or applicant counts —
 * employer identity stays off the worker path ENTIRELY (the ruling is stricter
 * than Option 3: not even a masked descriptor).
 */
export interface WorkerVisibleJob {
  job_id: string;
  // NULL for a V1 posting (no `trade_key` on `job_postings`); always set for legacy jobs.
  trade_key: TradeKey | null;
  title: string;
  // NULL for a V1 posting with no coarse city bucket set. NEVER back-filled from the
  // poster's free-text `location_label` (see the repository fallback) — an absent city
  // is honest absent data the client hides, exactly like the nulls below.
  city: string | null;
  area: string | null;
  pay_min: number | null;
  pay_max: number | null;
  min_experience_years: number | null;
  max_experience_years: number | null;
  needed_by: JobNeededBy | null;
  shift: JobShift | null;
  description: string | null;
  benefits: string[] | null;
  requirements: string[] | null;
}

/**
 * Worker-scoped job detail read (ADR-0024 final addendum, 2026-07-16 — the
 * ruling of record for TD53). Business logic only: repo → neutral 404 → explicit
 * wire projection. DISTINCT from the ops `GET /job-postings/:id`, which exposes
 * the employer org label and remains FORBIDDEN on the worker path.
 */
@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    private readonly repo: JobsRepository,
    // #822 only — the detail read above still emits nothing (ADR-0024 §"Event ruling"). Search
    // is a new worker ACTION, not a re-read of already-served content, so it gets its own event.
    private readonly events: EventsService,
  ) {}

  /**
   * Fetch the worker-visible projection of ONE open job.
   *
   * NEUTRAL 404 (the XB-A/F-3 precedent, cf. `AgencyService.getOwnJob`): the
   * message never echoes the id, and an unknown id and a CLOSED job are
   * byte-identical — the repository's `status='open'` WHERE folds both into
   * `undefined`, so there is no closed-vs-unknown oracle.
   *
   * NOT `job_reach`-GATED, deliberately — and asymmetric with apply, on purpose.
   * `ApplicationsService.applyV1` uses the worker's `job_reach` row as BOTH the gate
   * and the 404 oracle ("he can only apply to what the gate showed him"). This READ
   * does not: any consented worker who holds a posting id may read its detail. The
   * asymmetry is accepted because the projection is worker-INDEPENDENT and PII-free
   * by construction (no employer identity, no pay exactness, no applicant counts), ids
   * are unguessable v4 UUIDs so there is no enumeration path, and gating the read on
   * reach would break the legitimate case this fallback exists for — reopening a job
   * from the Applied tab after the reach row has been consumed. Apply stays gated; a
   * read that reveals nothing reach-specific does not need to be.
   *
   * NO EVENT EMISSION — load-bearing, per the ADR-0024 final addendum §"Event
   * ruling": this is a pure read of already-served content. The impression was
   * already evented by `feed.shown` when `/feed` served the card, and the
   * material state change that may follow (apply) emits `application.submitted`.
   * Reusing `feed.shown` for detail renders was considered and REJECTED — its
   * payload requires a positive 1-based feed position (`rank`), which a detail
   * render does not have; emitting a fake rank would corrupt the impression
   * spine, and mutating the shipped payload schema is barred by §2.8. If
   * detail-view analytics are wanted later, that is a NEW versioned event, not a
   * repurposed one.
   */
  async getWorkerVisibleJob(jobId: string): Promise<WorkerVisibleJob> {
    const row = await this.repo.findWorkerVisibleJobById(jobId);
    if (!row) throw new NotFoundException("Job not found");
    return {
      job_id: row.id,
      trade_key: row.tradeKey,
      title: row.title,
      city: row.city,
      area: row.area,
      pay_min: row.payMin,
      pay_max: row.payMax,
      min_experience_years: row.minExperienceYears,
      max_experience_years: row.maxExperienceYears,
      needed_by: row.neededBy,
      shift: row.shift,
      description: row.description,
      benefits: row.benefits,
      requirements: row.requirements,
    };
  }

  /**
   * #822 — the worker-facing job SEARCH: free text + location, paged, deterministic.
   *
   * DETERMINISTIC BY CONSTRUCTION, NEVER AI-RANKED (CLAUDE.md §3). The order is a SQL
   * expression — title-prefix, then title-substring, then skill-phrase, tie-broken on
   * `published_at DESC, id ASC`. No model sees this path, and none may: ranking who an
   * employer sees is a business decision, and §3 puts those outside the LLM's reach.
   *
   * THE EVENT CARRIES NO QUERY TEXT. `q` is unbounded worker free text and the events table
   * is exactly where §2 forbids raw PII, so the payload records the SHAPE of the search
   * (which filters ran, how long the term was, how many rows came back) and never the term.
   * Hashing was rejected: a short search term's hash is dictionary-reversible, i.e. PII in a
   * costume. See `JobSearchPerformedPayload`.
   *
   * THE EMIT NEVER FAILS THE SEARCH. Results are already computed and correct by the time it
   * runs; 500-ing a good page because an analytics row would not write trades a working
   * feature for a telemetry one. Logged and swallowed, the same posture `ProfilesService`
   * takes for its résumé and referral enqueues.
   */
  async searchJobs(
    workerId: string,
    query: JobSearchQueryDto,
    ctx: RequestContext,
  ): Promise<JobSearchResponse> {
    const offset = (query.page - 1) * query.limit;
    const { rows, hasMore } = await this.repo.searchOpenPostings({
      workerId,
      q: query.q ?? null,
      city: query.city ?? null,
      state: query.state ?? null,
      limit: query.limit,
      offset,
    });

    try {
      await this.events.emit({
        event_name: "job.search_performed",
        actor: { actor_type: "worker", actor_id: workerId },
        subject: { subject_type: "worker", subject_id: workerId },
        payload: {
          worker_id: workerId,
          has_query: query.q !== undefined,
          query_length: query.q?.length ?? 0,
          city_filtered: query.city !== undefined,
          state_filtered: query.state !== undefined,
          result_count: rows.length,
          page: query.page,
          limit: query.limit,
        },
        // A search is NOT idempotent — two identical searches are two real events — so the key
        // is the REQUEST, not the query. Same request replayed (a client retry on a dropped
        // response) collapses; a genuine second search does not.
        idempotencyKey: `job.search_performed:${ctx.requestId}`,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
    } catch (err) {
      this.logger.warn(
        `job.search_performed could not be emitted (results unaffected): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {
      jobs: rows.map((row) => ({
        job_id: row.id,
        title: row.title,
        city: row.city,
        state: row.state,
        // NOT CARRIED BY `job_postings`, and honestly null rather than invented. `area` and the
        // experience window live on the legacy `jobs` table only; the same nulls the detail
        // read already returns for a V1 posting.
        area: null,
        pay_min: row.payMin,
        pay_max: row.payMax,
        shift: row.shift,
        min_experience_years: null,
        max_experience_years: null,
        // Reserved by the contract for the skill label that matched. Null until the search
        // reports WHICH phrase hit — surfacing the worker's own query back as a "matched
        // skill" would be a fabrication, not a match.
        matched_skill_label: null,
        published_at: row.publishedAt?.toISOString() ?? null,
      })),
      page: query.page,
      limit: query.limit,
      has_more: hasMore,
    };
  }
}
