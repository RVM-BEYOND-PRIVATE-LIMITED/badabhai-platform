import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, isNotNull, sql, type SQL } from "drizzle-orm";
import {
  type Database,
  type Application,
  type Job,
  type JobShift,
  type JobPosting,
  type ApplicationAction,
  type SkipReason,
  type SourceSurface,
  applications,
  jobs,
  jobPostings,
  jobReach,
} from "@badabhai/db";
import type { TradeKey } from "@badabhai/taxonomy";
import { DATABASE } from "../database/database.module";
import { OPS_LIST_CAP } from "../common/pagination";
import { feedPayFloorPredicate, feedShiftPredicate } from "./feed-filter.predicates";
import {
  postedKeyText,
  postedKeysetAfter,
  type PostedKeysetPosition,
} from "./feed-keyset.predicates";

/**
 * The legacy `/feed` filters {@link ApplicationsRepository.findOpenJobs} applies. Every one is
 * OPTIONAL and absent means "not filtered".
 *
 * `tradeKey` is typed {@link TradeKey}, not `string`: the service resolves the raw query value
 * against `TRADE_KEYS` and drops an unknown one BEFORE it gets here (#1905), so this layer
 * never compares `jobs.trade_key` to a chip label that cannot match.
 */
export interface OpenJobsFilters {
  tradeKey?: TradeKey;
  city?: string;
  shift?: JobShift;
  /** The worker's pay FLOOR (₹/month). Compared to the band's TOP — see feed-filter.predicates. */
  payMin?: number;
}

/** Coarse, PII-free job fields surfaced in the feed + ops reads. */
export interface FeedJob {
  id: string;
  tradeKey: Job["tradeKey"];
  title: string;
  city: string;
  area: string | null;
  // The experience window the job targets (years). NULLABLE both ends — a blank is
  // "unbounded on that side", never a zero. PII-FREE: year counts (schema.ts §
  // demand-side ranking signals), never an employer or a worker identity.
  minExperienceYears: number | null;
  maxExperienceYears: number | null;
  // Additive worker-visible fields (ADR-0024 final addendum, 2026-07-16): the pay
  // band AS STORED (band columns, never an exact salary) + the coarse shift enum.
  // NULLABLE, PII-FREE by the schema's own classification (pay bands / timing
  // enums — never an employer identity). Same §8 argument as the experience window.
  payMin: number | null;
  payMax: number | null;
  /** #1648 — what the band MEANS. NULL = not stated. Never defaulted, never inferred. */
  payType: Job["payType"];
  shift: Job["shift"];
  // Worker-visible card content (#1561): description + benefits/requirements +
  // needed_by, verbatim off the `jobs` row (the seed carries them; the fail-closed
  // PII guard in seed-jobs.ts is what keeps them employer-free). NULLABLE, passed
  // through honestly like every other field on this interface.
  description: string | null;
  benefits: string[] | null;
  requirements: string[] | null;
  neededBy: Job["neededBy"];
  /**
   * The job's display role (migration 0131), RAW off the column — the mapper gates it to the
   * closed set or null (`toWorkerRoleKind`). Shown as card art (owner ruling 2026-10-05);
   * never a filter or order input.
   */
  roleKind: string | null;
  /** #1649 — when the job was posted. NOT NULL on the column; also the feed's sort key. */
  createdAt: Date;
}

/**
 * The worker-visible card columns of ONE open, published company posting (#1823, the
 * interim union arm of the legacy feed). EXACTLY what {@link
 * ApplicationsRepository.findOpenPostingsForFeed} projects, so the type and the projection
 * cannot drift (the lesson `UpsertedApplication` below records).
 *
 * WHAT IS ABSENT IS THE CONTRACT (ADR-0024 HIDDEN). No `org_label`, `payer_id`,
 * `created_by`, `location_label` (poster free text that may name the site or employer),
 * `verification_status`, `boosted_until`, `state`, `vacancy_band`, skill arrays or
 * `source_job_id`: none of them is a card field, and every one is a leak or a claim the
 * worker card must not make. `city`/`area` are the coarse buckets, never back-filled.
 *
 * `role_kind` IS projected since the owner ruling of 2026-10-05 (ADR-0024 addendum): a closed,
 * PII-free enum the worker card draws as art. Projection only — still never a predicate.
 */
export interface FeedPostingRow {
  id: string;
  roleTitle: string;
  city: string | null;
  area: string | null;
  minExperienceYears: number | null;
  maxExperienceYears: number | null;
  payMin: number | null;
  payMax: number | null;
  payType: JobPosting["payType"];
  shift: JobPosting["shift"];
  description: string | null;
  benefits: string[] | null;
  requirements: string[] | null;
  neededBy: JobPosting["neededBy"];
  /** Display role (migration 0131), RAW — gated to the closed set or null by the mapper. */
  roleKind: string | null;
  /** The sort key and the card's `posted_at`. The query requires it non-null. */
  publishedAt: Date | null;
}

/**
 * A {@link FeedJob} plus its keyset position (#1961): `created_at` as microsecond UTC text, the
 * value a `next_cursor` carries. Never on the card — `posted_at` stays the ISO millisecond form.
 */
export interface FeedJobRow extends FeedJob {
  postedKey: string;
}

/** A {@link FeedPostingRow} plus its keyset position: `published_at` as microsecond UTC text. */
export interface FeedPostingKeyedRow extends FeedPostingRow {
  postedKey: string;
}

/** An application row joined with its (coarse, PII-free) job fields. */
export interface ApplicationWithJob {
  // Migration 0056: `applications.job_id` lost its NOT NULL because a V1 application
  // points at `job_posting_id` instead (job_id NULL). `findApplicationsByWorker` now
  // LEFT JOINs BOTH `jobs` (legacy) and `job_postings` (V1) and coalesces, so this is
  // the EFFECTIVE id — `job_id` for a legacy decision, else `job_posting_id`. Always
  // non-null for a real row (one FK is always set); typed nullable to match the column.
  jobId: string | null;
  // NULL for a V1 decision: `job_postings` has no `trade_key` (only `role_title`).
  tradeKey: Job["tradeKey"] | null;
  title: string;
  // NULL for a V1 decision whose posting has no coarse city bucket (`job_postings.city`
  // is nullable). A legacy decision always has one (`jobs.city` is NOT NULL). NEVER
  // back-filled from `job_postings.location_label` — see the query below.
  city: string | null;
  area: string | null;
  action: ApplicationAction;
  reason: SkipReason | null;
  sourceSurface: SourceSurface;
  rank: number | null;
  createdAt: Date;
  updatedAt: Date;
  // The match skill that earned this worker his reach row for a V1 posting, or NULL for a
  // legacy decision (which has no reach row at all). The ID, not a label: turning it into a
  // human string is a taxonomy lookup and belongs in the service, not the repository.
  matchedSkillId: string | null;
}

/** The fields an apply/skip upsert writes (worker/job identify the row). */
export interface UpsertApplicationInput {
  workerId: string;
  jobId: string;
  action: ApplicationAction;
  reason: SkipReason | null;
  sourceSurface: SourceSurface;
  rank: number | null;
}

/**
 * EXACTLY what {@link ApplicationsRepository.upsertDecision} projects — no more.
 *
 * It used to be declared `Application & { inserted: boolean }`, i.e. "the whole row",
 * while the `.returning({...})` listed a hand-written subset. That is a promise the
 * projection does not keep, and migration 0056 collected on it: six new columns landed
 * and the declared type stopped matching. The lesson is not "remember to widen the
 * projection" — it is that the RETURN TYPE must be the projection, so the two cannot
 * drift. A caller that needs a new column now has to add it in both places, and the
 * compiler says so at the call site instead of at the repository.
 */
export interface UpsertedApplication {
  id: string;
  jobId: string | null;
  workerId: string;
  action: ApplicationAction;
  reason: SkipReason | null;
  sourceSurface: SourceSurface;
  rank: number | null;
  createdAt: Date;
  updatedAt: Date;
  /** `(xmax = 0)` — TRUE only when this call created a NEW row. */
  inserted: boolean;
}

/**
 * Drizzle data access for the alpha swipe-to-apply surface (ADR-0009). Pure data
 * access only — no business logic, no event emission (those live in the service).
 */
@Injectable()
export class ApplicationsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Open jobs in a DETERMINISTIC order (created_at DESC, id ASC tiebreak — newest first
   * since #1649) so the feed page + its 1-based `rank` are stable across calls and
   * environments.
   *
   * TD73: excludes jobs the worker has already applied to via a NOT EXISTS anti-join
   * on applications (worker_id, job_id, action='applied'). The unique index
   * `applications_worker_job_uq` on (worker_id, job_id) covers this anti-join.
   * Skip exclusion requires an explicit product call (the client currently re-serves
   * skipped jobs forever — see the issue).
   */
  async findOpenJobs(
    workerId: string,
    limit: number,
    filters: OpenJobsFilters = {},
    after?: PostedKeysetPosition,
  ): Promise<FeedJobRow[]> {
    const conditions: (SQL | undefined)[] = [
      eq(jobs.status, "open"),
      sql`NOT EXISTS (
        SELECT 1 FROM ${applications}
        WHERE ${applications.workerId} = ${workerId}
          AND ${applications.jobId} = ${jobs.id}
          AND ${applications.action} = 'applied'
      )`,
    ];
    if (filters.tradeKey) conditions.push(eq(jobs.tradeKey, filters.tradeKey));
    if (filters.city) conditions.push(eq(jobs.city, filters.city));
    // #1905 — shift + pay floor were accepted by the DTO and then silently DROPPED here. Same
    // NULL-tolerant rule as the V1 arm, from the one place the postings arm (#1823) will
    // share; each is `undefined` (skipped by `and`) unless the worker sent that filter.
    conditions.push(
      feedShiftPredicate(jobs.shift, filters.shift),
      feedPayFloorPredicate(jobs.payMax, filters.payMin),
      // #1961 — the next page: strictly after the last served (created_at, id). Absent on the
      // first page, so its WHERE is unchanged.
      postedKeysetAfter(jobs.createdAt, jobs.id, after),
    );

    return this.db
      .select({
        id: jobs.id,
        tradeKey: jobs.tradeKey,
        title: jobs.title,
        city: jobs.city,
        area: jobs.area,
        minExperienceYears: jobs.minExperienceYears,
        maxExperienceYears: jobs.maxExperienceYears,
        payMin: jobs.payMin,
        payMax: jobs.payMax,
        payType: jobs.payType,
        shift: jobs.shift,
        description: jobs.description,
        benefits: jobs.benefits,
        requirements: jobs.requirements,
        neededBy: jobs.neededBy,
        // Card art only (owner ruling 2026-10-05) — selected, never filtered or ordered on.
        roleKind: jobs.roleKind,
        // #1649 — the posting date the feed never carried. Projected so the card can
        // badge a fresh job and the Jobs-tab header can count today's honestly.
        createdAt: jobs.createdAt,
        // #1961 — the keyset position at full precision, for `next_cursor`. Not a card field.
        postedKey: postedKeyText(jobs.createdAt),
      })
      .from(jobs)
      // TD73: exclude applied jobs server-side.
      .where(and(...conditions))
      // LOCATION SEAM: when the location feature lands, an OPTIONAL city/coords
      // filter goes HERE, default-off so the feed stays liberal until a worker
      // opts into a location. Do NOT implement it now — the alpha feed returns
      // every open job with no location filter (see the worker-app Filters sheet).
      //
      // NEWEST FIRST (#1649, owner ruling 2026-09-22). This was `asc(createdAt)` —
      // OLDEST first — under a Jobs-tab header that said "Aaj N naye jobs": the deck
      // literally led with the stalest job on the platform while claiming the opposite.
      // The V1 feed has always ordered boost -> `published_at DESC` -> id, so this also
      // stops the worker's deck reordering when `MATCH_V1_ENABLED` flips.
      //
      // `id ASC` stays the tiebreak and is what keeps the order TOTAL: two jobs created in
      // the same transaction must not swap between page loads (E11/Policy 7). It is ASC on
      // both sides on purpose — the tiebreak is for stability, not recency, and flipping it
      // would buy nothing and churn the pagination contract.
      .orderBy(desc(jobs.createdAt), asc(jobs.id))
      .limit(limit);
  }

  /** A single OPEN job by id, or undefined (used to 404 unknown/closed jobs — no oracle). */
  async findJobById(id: string): Promise<Job | undefined> {
    const rows = await this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, id), eq(jobs.status, "open")))
      .limit(1);
    return rows[0];
  }

  /**
   * #1823 — the interim union's posting arm of `GET /feed`: open, published company
   * postings for ONE worker, newest first. Every predicate is separate and index-served;
   * the numbering is ADR-0049's.
   *
   *   (1) `status = 'open'` — positively excludes draft, paused, suspended and closed. The
   *       ADR-0037 suspension cascade is a status move, so no `payers` join is needed.
   *   (2) `published_at IS NOT NULL` — a NULL means the publish never completed; such a row
   *       has no honest `posted_at`, and V1 never serves it either.
   *   (3a) no APPLIED decision on this posting (`applications_worker_posting_uq`), and
   *   (3b) none on its D4 source job (`applications_applied_idx`). Applied-only, exactly
   *       like `findOpenJobs` (TD73): a skipped posting is re-served in the same deck.
   *   (4) THE TWIN GUARD — while a D4 source job is still open, the jobs arm serves that
   *       vacancy, so its converted posting stays hidden. Kept SEPARATE from (3b): folding
   *       them into one clause showed the twin when its source closed, or when the worker
   *       had applied to the source.
   *   (5) the #1240 relevance rule, verbatim from `JobsRepository.searchOpenPostings`:
   *       when the worker wants skills, the posting's `reach_skill_ids` must overlap them;
   *       when he wants none, every posting passes. Match inputs only — never `role_kind`
   *       (ADR-0036 addendum).
   *   (6) city: V1's wide-or-off rule — a posting with no city bucket matches every city
   *       filter, case-insensitively. Only when the worker supplied a city.
   *
   *   (7) shift and pay floor (#1905): the SAME NULL-tolerant predicates the jobs arm uses
   *       (feed-filter.predicates), so a filter narrows both halves of the deck or neither.
   *       Each only when the worker supplied it.
   *
   * NOT HERE, ON PURPOSE: `trade_key` (V1 has no trade dimension, and `role_kind` is barred
   * as a visibility input — it is PROJECTED for the card's art, never a WHERE).
   *
   * The projection is explicit — see {@link FeedPostingRow} for what must never be in it.
   */
  async findOpenPostingsForFeed(
    workerId: string,
    limit: number,
    filters: {
      city?: string;
      shift?: JobShift;
      payMin?: number;
      wantedSkillIds: readonly string[];
    },
    after?: PostedKeysetPosition,
  ): Promise<FeedPostingKeyedRow[]> {
    const conditions: (SQL | undefined)[] = [
      eq(jobPostings.status, "open"), // (1)
      isNotNull(jobPostings.publishedAt), // (2)
      sql`NOT EXISTS (
        SELECT 1 FROM ${applications}
        WHERE ${applications.workerId} = ${workerId}
          AND ${applications.jobPostingId} = ${jobPostings.id}
          AND ${applications.action} = 'applied'
      )`, // (3a)
      // NULL `source_job_id` (every non-D4 posting) never equals anything, so (3b) passes.
      sql`NOT EXISTS (
        SELECT 1 FROM ${applications}
        WHERE ${applications.workerId} = ${workerId}
          AND ${applications.jobId} = ${jobPostings.sourceJobId}
          AND ${applications.action} = 'applied'
      )`, // (3b)
      sql`NOT EXISTS (
        SELECT 1 FROM ${jobs}
        WHERE ${jobs.id} = ${jobPostings.sourceJobId}
          AND ${jobs.status} = 'open'
      )`, // (4)
    ];
    if (filters.wantedSkillIds.length > 0) {
      // (5) ⚠️ ONE bound text[] via `sql.param` — a bare JS array expands to a RECORD and fails
      // at runtime with 42846 (see JobsRepository.searchOpenPostings, which pins the same).
      conditions.push(
        sql`${jobPostings.reachSkillIds} ?| ${sql.param([...filters.wantedSkillIds])}::text[]`,
      );
    }
    if (filters.city) {
      // (6) `::text` so `lower()` resolves without guessing at the parameter's type.
      conditions.push(sql`(
        ${jobPostings.city} IS NULL OR lower(${jobPostings.city}) = lower(${filters.city}::text)
      )`);
    }
    conditions.push(
      feedShiftPredicate(jobPostings.shift, filters.shift), // (7)
      feedPayFloorPredicate(jobPostings.payMax, filters.payMin), // (7)
      // (8) #1961 — the next page: strictly after this ARM's last served (published_at, id),
      // the same keyset predicate as the jobs arm. Absent on the first page.
      postedKeysetAfter(jobPostings.publishedAt, jobPostings.id, after),
    );

    // ORDER BY rides `job_postings_feed_idx (status, published_at DESC)`, and it is the same
    // total order as the jobs arm (`posted_at DESC, id ASC`) — which is what lets the service
    // merge the two arms by comparing heads only.
    return this.db
      .select({
        id: jobPostings.id,
        roleTitle: jobPostings.roleTitle,
        city: jobPostings.city,
        area: jobPostings.area,
        minExperienceYears: jobPostings.minExperienceYears,
        maxExperienceYears: jobPostings.maxExperienceYears,
        payMin: jobPostings.payMin,
        payMax: jobPostings.payMax,
        payType: jobPostings.payType,
        shift: jobPostings.shift,
        description: jobPostings.description,
        benefits: jobPostings.benefits,
        requirements: jobPostings.requirements,
        neededBy: jobPostings.neededBy,
        // Card art only (owner ruling 2026-10-05) — selected, never a predicate (see (5)).
        roleKind: jobPostings.roleKind,
        publishedAt: jobPostings.publishedAt,
        // #1961 — the keyset position at full precision. `published_at` is NOT NULL here by
        // (2), so this is never null. Not a card field.
        postedKey: postedKeyText(jobPostings.publishedAt),
      })
      .from(jobPostings)
      .where(and(...conditions))
      .orderBy(desc(jobPostings.publishedAt), asc(jobPostings.id))
      .limit(limit);
  }

  /**
   * #1823 — an OPEN posting's id, or undefined: the posting branch of the apply/skip
   * resolution, consulted only after the open-`jobs` read misses. Id-only on purpose — the
   * caller needs existence, and a wider projection is a leak waiting for a log line.
   * Unknown, draft, paused, suspended and closed all read as undefined (no oracle).
   */
  async findOpenPostingRef(id: string): Promise<{ id: string } | undefined> {
    const rows = await this.db
      .select({ id: jobPostings.id })
      .from(jobPostings)
      .where(and(eq(jobPostings.id, id), eq(jobPostings.status, "open")))
      .limit(1);
    return rows[0];
  }

  /**
   * Upsert the worker's decision for a job, keyed on the unique (worker_id,
   * job_id). On conflict it OVERWRITES action/reason/source_surface/rank and bumps
   * updated_at — last-write-wins (ADR-0009 §2). A double-tap or a flip
   * (apply↔skip) therefore lands on a SINGLE row reflecting the latest intent; no
   * duplicate row is ever created. The audit history of every tap still lives in
   * the events spine.
   *
   * Returns the row plus `inserted`: TRUE only when this call created a NEW row,
   * FALSE when it hit ON CONFLICT DO UPDATE. We read this off the Postgres `xmax`
   * system column — `(xmax = 0)` is TRUE for a fresh INSERT and FALSE for a row
   * touched by the conflict UPDATE — so the caller can count genuine first applies
   * without a separate read (race-safe, single round-trip). PII-free: a boolean.
   */
  async upsertDecision(input: UpsertApplicationInput): Promise<UpsertedApplication> {
    const rows = await this.db
      .insert(applications)
      .values({
        workerId: input.workerId,
        jobId: input.jobId,
        action: input.action,
        reason: input.reason,
        sourceSurface: input.sourceSurface,
        rank: input.rank,
      })
      .onConflictDoUpdate({
        target: [applications.workerId, applications.jobId],
        set: {
          action: input.action,
          reason: input.reason,
          sourceSurface: input.sourceSurface,
          rank: input.rank,
          updatedAt: sql`now()`,
        },
      })
      .returning({
        id: applications.id,
        jobId: applications.jobId,
        workerId: applications.workerId,
        action: applications.action,
        reason: applications.reason,
        sourceSurface: applications.sourceSurface,
        rank: applications.rank,
        createdAt: applications.createdAt,
        updatedAt: applications.updatedAt,
        // `(xmax = 0)` ⇒ this RETURNING row came from the INSERT, not the UPDATE.
        inserted: sql<boolean>`(xmax = 0)`,
      });
    const row = rows[0];
    if (!row) throw new Error("Failed to upsert application");
    return row;
  }

  /**
   * Atomically bump a job's denormalized applies counter by exactly 1 (ADR-0009
   * swipe-to-apply rollup). Single in-SQL UPDATE — no read-modify-write in app
   * code, so it is race-safe under concurrent applies with no transaction or
   * advisory lock needed (modeled on `unlocks.incrementReveal`). The caller gates
   * this to genuine first-time applies; the CHECK (applicants_received >= 0) holds
   * trivially since we only ever add. PII-free: an integer count.
   */
  async incrementApplicantsReceived(jobId: string): Promise<number> {
    const rows = await this.db
      .update(jobs)
      .set({
        applicantsReceived: sql`${jobs.applicantsReceived} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(jobs.id, jobId))
      .returning({ applicantsReceived: jobs.applicantsReceived });
    const count = rows[0]?.applicantsReceived;
    if (count === undefined) throw new Error("Failed to increment applicants_received");
    return count;
  }

  /**
   * Applicants for a job (ops read). PII-FREE projection — worker_id only, NEVER
   * a name/phone. Oldest decision first.
   *
   * The LEGACY id space only (`applications.job_id`, served by `applications_job_id_idx`);
   * {@link findApplicantsByPosting} is the posting twin, and the service picks one.
   */
  async findApplicantsByJob(jobId: string): Promise<Application[]> {
    return this.db
      .select()
      .from(applications)
      .where(eq(applications.jobId, jobId))
      .orderBy(asc(applications.createdAt))
      .limit(OPS_LIST_CAP); // bound an otherwise-unbounded ops read
  }

  /**
   * #1823 — applicants for a company posting (ops read): decisions that carry
   * `job_posting_id` (V1, or the interim union feed), with `job_id` NULL. Same PII-free
   * projection, order and cap as {@link findApplicantsByJob}.
   *
   * A SEPARATE single-column equality, never `job_id = $1 OR job_posting_id = $1`: the OR
   * cannot be served by `applications_job_id_idx` alone, so it would have moved every legacy
   * ops read off its index too. KNOWN GAP: no index leads with `job_posting_id` across both
   * actions (`applications_rank_idx` is partial on `applied`; the other two lead with
   * `worker_id`), so this read scans the partial `applications_worker_posting_uq` at best.
   * Fine at today's posting-decision volume; an additive `applications(job_posting_id)`
   * index is the fix if it ever is not.
   */
  async findApplicantsByPosting(jobPostingId: string): Promise<Application[]> {
    return this.db
      .select()
      .from(applications)
      .where(eq(applications.jobPostingId, jobPostingId))
      .orderBy(asc(applications.createdAt))
      .limit(OPS_LIST_CAP);
  }

  /**
   * #1823 — does `id` name a `jobs` row in ANY status? The id-space probe behind the ops
   * applicants read: a closed job still has applicants worth reading, so unlike
   * {@link findJobById} this has no status predicate. Id-only, served by the primary key.
   */
  async legacyJobExists(id: string): Promise<boolean> {
    const rows = await this.db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, id)).limit(1);
    return rows.length > 0;
  }

  /**
   * A worker's decisions (ops read), joined to the coarse, PII-free job fields
   * (trade/title/city/area — never employer or pay). Oldest first.
   */
  async findApplicationsByWorker(workerId: string): Promise<ApplicationWithJob[]> {
    // A decision carries `job_id` (legacy alpha) or `job_posting_id` (V1); the DB CHECK
    // `applications_job_ref_chk` requires AT LEAST ONE to be set (it is an OR, not an
    // XOR — a row could in principle carry both, in which case the legacy side wins the
    // coalesce below). The old INNER JOIN on `jobs` silently dropped every V1 decision
    // (job_id NULL), so the worker's "Applied jobs" tab looked empty even after applying
    // from the V1 feed. LEFT JOIN both and coalesce the coarse, PII-free fields so a
    // decision from either surface shows. Both joins are on a PRIMARY KEY, so neither
    // can fan a decision out into duplicate rows.
    //
    // `title` is sound as non-null: both source columns are NOT NULL and both FKs are
    // ON DELETE CASCADE, so a surviving decision always has one side of the join.
    // `city` is NOT: `job_postings.city` is nullable, and it is deliberately NOT
    // back-filled from `job_postings.location_label` — that column is poster-typed free
    // text, exempt from the PII heuristic, and may name the site or employer. Putting it
    // on a worker-visible surface is the exact leak match-feed.service.ts refuses for
    // `area`. NULL is the honest answer.
    return this.db
      .select({
        jobId: sql<string | null>`coalesce(${applications.jobId}, ${applications.jobPostingId})`,
        tradeKey: jobs.tradeKey,
        title: sql<string>`coalesce(${jobs.title}, ${jobPostings.roleTitle})`,
        city: sql<string | null>`coalesce(${jobs.city}, ${jobPostings.city})`,
        area: jobs.area,
        action: applications.action,
        reason: applications.reason,
        sourceSurface: applications.sourceSurface,
        rank: applications.rank,
        createdAt: applications.createdAt,
        updatedAt: applications.updatedAt,
        // #1051. `trade_key` is NULL for every V1 decision, so without this the subtitle a
        // worker reads on the Applied tab has nothing to say about the WORK — only the place.
        // The reach row is where a V1 decision's skill lives, and it is the same id the feed
        // already surfaces, so the two surfaces now agree instead of one of them going blank.
        //
        // NOT the label: `matchSkillLabel` is a closed-set taxonomy lookup and belongs in the
        // service. Keeping the repository to columns is also what stops this join from
        // becoming the place someone later reaches for pay or employer.
        matchedSkillId: jobReach.matchedSkillId,
      })
      .from(applications)
      .leftJoin(jobs, eq(applications.jobId, jobs.id))
      .leftJoin(jobPostings, eq(applications.jobPostingId, jobPostings.id))
      // ON THE PRIMARY KEY, which is the property the paragraph above depends on:
      // `job_reach`'s PK is exactly (job_posting_id, worker_id), so this cannot fan a
      // decision out into duplicate rows any more than the other two joins can. LEFT, because
      // a legacy decision has no reach row and must still appear.
      .leftJoin(
        jobReach,
        and(
          eq(jobReach.jobPostingId, applications.jobPostingId),
          eq(jobReach.workerId, applications.workerId),
        ),
      )
      .where(eq(applications.workerId, workerId))
      .orderBy(asc(applications.createdAt))
      .limit(OPS_LIST_CAP); // bound an otherwise-unbounded ops read
  }

  /**
   * A single worker's decision for a single job, or undefined. Not required by the
   * routes (the upsert is self-contained) but handy for assertions/tests; kept
   * minimal so it does not invite business logic into the repository.
   */
  async findDecision(workerId: string, jobId: string): Promise<Application | undefined> {
    const rows = await this.db
      .select()
      .from(applications)
      .where(and(eq(applications.workerId, workerId), eq(applications.jobId, jobId)))
      .limit(1);
    return rows[0];
  }
}
