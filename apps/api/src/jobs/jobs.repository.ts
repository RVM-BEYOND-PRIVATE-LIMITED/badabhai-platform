import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import {
  type Database,
  type Job,
  type JobNeededBy,
  type JobShift,
  jobs,
  jobPostings,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/**
 * The EXPLICIT worker-visible column set — exactly what
 * {@link JobsRepository.findWorkerVisibleJobById} selects, nothing more.
 */
export interface WorkerVisibleJobRow {
  id: string;
  // NULL for a V1 posting: `job_postings` has no `trade_key` (it carries a free-text
  // `role_title` only). Legacy `jobs` rows always have one.
  tradeKey: Job["tradeKey"] | null;
  title: string;
  // NULL for a V1 posting whose coarse `city` bucket was never filled in
  // (`job_postings.city` is nullable). Legacy `jobs.city` is NOT NULL, so a legacy
  // row always has one. DELIBERATELY NOT back-filled from `job_postings.location_label`
  // — see the fallback query below.
  city: string | null;
  area: string | null;
  payMin: number | null;
  payMax: number | null;
  minExperienceYears: number | null;
  maxExperienceYears: number | null;
  neededBy: JobNeededBy | null;
  shift: JobShift | null;
  description: string | null;
  benefits: string[] | null;
  requirements: string[] | null;
}

/**
 * One search hit — the EXPLICIT worker-visible projection for `GET /jobs/search` (#822).
 *
 * A strict subset of what a posting holds. `org_label`, `payer_id`, `created_by`, `status` and
 * `location_label` are never selected: employer identity stays off the worker path entirely
 * (ADR-0024), and `location_label` is poster free text that may contain an address.
 */
export interface JobSearchRow {
  id: string;
  title: string;
  city: string | null;
  state: string | null;
  payMin: number | null;
  payMax: number | null;
  shift: JobShift | null;
  publishedAt: Date | null;
}

/**
 * Drizzle data access for the worker-scoped job detail read (ADR-0024 final
 * addendum, 2026-07-16). Pure data access only — the neutral 404 and the wire
 * mapping live in the service.
 */
@Injectable()
export class JobsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * ONE open job by id, EXPLICIT column projection (never `select *`): exactly
   * the ADR-0024 final-addendum SHOW set. `payer_id` (the opaque employer/agency
   * owner ref), `status`, `applicants_received`, and `created_at`/`updated_at`
   * are NEVER selected — the owner ref must never ride a worker-authed read path
   * (§2 / ADR-0024 "HIDE — employer identity, entirely"), and the rest are
   * internal bookkeeping, not worker-visible content.
   *
   * `status = 'open'` is IN THE WHERE: a CLOSED job is invisible on the worker
   * path by design and resolves to the SAME neutral 404 as an unknown id — no
   * closed-vs-unknown oracle.
   */
  async findWorkerVisibleJobById(jobId: string): Promise<WorkerVisibleJobRow | undefined> {
    const [legacy] = await this.db
      .select({
        id: jobs.id,
        tradeKey: jobs.tradeKey,
        title: jobs.title,
        city: jobs.city,
        area: jobs.area,
        payMin: jobs.payMin,
        payMax: jobs.payMax,
        minExperienceYears: jobs.minExperienceYears,
        maxExperienceYears: jobs.maxExperienceYears,
        neededBy: jobs.neededBy,
        shift: jobs.shift,
        description: jobs.description,
        benefits: jobs.benefits,
        requirements: jobs.requirements,
      })
      .from(jobs)
      .where(and(eq(jobs.id, jobId), eq(jobs.status, "open")))
      .limit(1);
    if (legacy) return legacy;

    // V1 (ADR-0036): the feed serves `job_postings`, so a tapped/applied job id is a
    // POSTING id, not a legacy `jobs.id` — the query above misses it and the detail
    // screen was left with only the light title/place it was handed. Fall back to the
    // OPEN posting and project the SAME worker-visible, PII-free SHOW set. Fields the
    // posting doesn't carry are NULL (never invented): `trade_key`, `area`, the
    // experience window, `benefits`, `requirements`, and `city` when the coarse bucket
    // is unset. `status = 'open'` keeps the SAME neutral-404 no-oracle rule.
    // `org_label` / `payer_id` are NEVER selected (employer identity, HIDE — ADR-0024/§2).
    //
    // `city` IS NOT BACK-FILLED FROM `location_label`, deliberately. `job_postings.city`
    // is the COARSE, matchable city bucket ("Pune"); `location_label` is 200 chars of
    // poster-typed free text that is explicitly EXEMPT from the PII heuristic
    // (job-postings.dto.ts) and may name the site or the employer ("Near <Employer> gate
    // 3"). Promoting it into a worker-visible field would put payer free text on the
    // worker path — the same call match-feed.service.ts already made for `area`
    // ("inventing one from `location_label` would put payer free text on a worker card").
    // A NULL city is the honest answer; the client already hides the row.
    const [posting] = await this.db
      .select({
        id: jobPostings.id,
        tradeKey: sql<Job["tradeKey"] | null>`NULL`,
        title: jobPostings.roleTitle,
        city: jobPostings.city,
        area: sql<string | null>`NULL`,
        payMin: jobPostings.payMin,
        payMax: jobPostings.payMax,
        minExperienceYears: sql<number | null>`NULL`,
        maxExperienceYears: sql<number | null>`NULL`,
        neededBy: jobPostings.neededBy,
        shift: jobPostings.shift,
        description: jobPostings.description,
        benefits: sql<string[] | null>`NULL`,
        requirements: sql<string[] | null>`NULL`,
      })
      .from(jobPostings)
      .where(and(eq(jobPostings.id, jobId), eq(jobPostings.status, "open")))
      .limit(1);
    return posting;
  }

  /**
   * #822 — the DISCOVERY surface: open postings matching a free-text term and/or a location.
   *
   * DELIBERATELY NOT `/feed`, and the distinction is the reason this exists. The feed is a
   * PERSONALIZED reach list — its candidate set is gated by `job_reach`, capped at 50, and
   * filtered by exact-`city` equality. Search is the opposite: every open posting is a
   * candidate, the worker supplies the intent, and `city` matches partially. Bolting `q` onto
   * the feed would have made one query answer two different product questions.
   *
   * ONE MORE ROW THAN ASKED FOR is fetched (`limit + 1`) so `has_more` is a FACT rather than a
   * guess. The alternative — a second `count(*)` over the same predicate — doubles the query
   * cost to answer a boolean, and a full count over an unbounded search is the expensive half.
   * The caller slices back to `limit`.
   *
   * DETERMINISTIC ORDER, NO AI (CLAUDE.md §3). Relevance is a computed SQL rank, not a model:
   * a title prefix match outranks a title substring, which outranks a skill-phrase hit. Ties
   * break on `published_at DESC, id ASC`, so the same query returns the same page every time
   * and paging cannot drop or repeat a row between requests.
   *
   * PII: the projection is explicit and never selects `org_label`, `payer_id`, `created_by` or
   * `location_label` — employer identity stays off the worker path entirely (ADR-0024), and
   * `location_label` is poster free text that could hold an address.
   */
  async searchOpenPostings(args: {
    workerId: string;
    q: string | null;
    city: string | null;
    state: string | null;
    limit: number;
    offset: number;
  }): Promise<{ rows: JobSearchRow[]; hasMore: boolean }> {
    const conditions = [eq(jobPostings.status, "open")];

    // ILIKE with the term as a PARAMETER, never interpolated — `%` and `_` inside a worker's
    // search box are then literal characters rather than wildcards they did not ask for.
    if (args.q) {
      const like = `%${args.q}%`;
      conditions.push(
        sql`(${jobPostings.roleTitle} ILIKE ${like} OR EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(${jobPostings.skillPhrases}) AS phrase
          WHERE phrase ILIKE ${like}
        ))`,
      );
    }
    // PARTIAL and case-insensitive, unlike the feed's exact equality — "pun" finds "Pune",
    // which is the whole point of a search box.
    if (args.city) conditions.push(sql`${jobPostings.city} ILIKE ${`%${args.city}%`}`);
    if (args.state) conditions.push(sql`${jobPostings.state} ILIKE ${`%${args.state}%`}`);

    // ALREADY-DECIDED POSTINGS ARE EXCLUDED, mirroring the feed's anti-join but keyed on
    // `job_posting_id` (migration 0056 — a V1 decision leaves `job_id` NULL). Both `applied`
    // and `skipped`: on a search the worker typed the query, so re-serving something they
    // already dismissed reads as the search being broken.
    conditions.push(sql`NOT EXISTS (
      SELECT 1 FROM applications a
      WHERE a.worker_id = ${args.workerId}
        AND a.job_posting_id = ${jobPostings.id}
        AND a.action IN ('applied', 'skipped')
    )`);

    // The relevance ladder, as a plain integer. Lower sorts first.
    const relevance = args.q
      ? sql<number>`CASE
          WHEN ${jobPostings.roleTitle} ILIKE ${`${args.q}%`} THEN 0
          WHEN ${jobPostings.roleTitle} ILIKE ${`%${args.q}%`} THEN 1
          ELSE 2
        END`
      : sql<number>`0`;

    const rows = await this.db
      .select({
        id: jobPostings.id,
        title: jobPostings.roleTitle,
        city: jobPostings.city,
        state: jobPostings.state,
        payMin: jobPostings.payMin,
        payMax: jobPostings.payMax,
        shift: jobPostings.shift,
        publishedAt: jobPostings.publishedAt,
      })
      .from(jobPostings)
      .where(and(...conditions))
      .orderBy(relevance, sql`${jobPostings.publishedAt} DESC NULLS LAST`, jobPostings.id)
      .limit(args.limit + 1)
      .offset(args.offset);

    return { rows: rows.slice(0, args.limit), hasMore: rows.length > args.limit };
  }
}
