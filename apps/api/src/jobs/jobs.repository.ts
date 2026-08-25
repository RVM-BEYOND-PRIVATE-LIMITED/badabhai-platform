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
/**
 * Builds the `to_tsquery('simple', …)` argument for a worker's search box (migration 0089).
 *
 * The term is lowercased, split on whitespace, and every token is stripped to
 * `[a-z0-9]` — so what reaches `to_tsquery` can only ever be `token [& token …][:*]`.
 * That makes three classes of input safe by construction:
 *
 * 1. tsquery SYNTAX typed by a worker (`cnc & welder | !fitter`) is stripped to plain
 *    tokens — operators never survive into the query string, so `to_tsquery` cannot be
 *    handed a syntax error or a negation the worker did not mean.
 * 2. SQL injection is structurally impossible — the result travels as one bound
 *    parameter, exactly like the ILIKE parameter it replaces.
 * 3. Wildcards stay literal — `%` and `_` are not in the allowed set, so "100%_operator"
 *    searches FOR that string rather than becoming a pattern.
 *
 * Underscore is deliberately stripped (treated as a separator) because Postgres's
 * default parser does not treat it as a word character; keeping it would desynchronize
 * the query tokens from how the vector was tokenized. Devanagari and other non-Roman
 * script strips to nothing — the caller falls back to literal ILIKE containment for
 * such terms instead of dead-ending the search box.
 *
 * AND-joins the tokens (every term must appear), prefix-marking only the LAST one:
 * `"mig welder" → mig & welder:*`. Prefixing every token would turn "welder helper"
 * into a typeahead for "welder…", which is not what a search box promises.
 *
 * Returns null when no usable token survives — the caller's cue to use the ILIKE
 * fallback rather than hand `to_tsquery` an empty string (a guaranteed syntax error).
 */
function searchTsQuery(q: string): string | null {
  const tokens = q
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]/g, ""))
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return null;
  const last = tokens.length - 1;
  return `${tokens.slice(0, last).map((token) => `${token} & `).join("")}${tokens[last]}:*`;
}

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
   * and paging cannot drop or repeat a row between requests. With no `q` there is nothing to
   * rank by, so the relevance key is ABSENT from the sort rather than constant — see below.
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

    // ── Membership: the `search_vec` GIN probe (migration 0089) ──
    //
    // The term is tokenized in TypeScript and passed as ONE bound parameter to
    // `to_tsquery` — never interpolated into statement text, so it cannot become an
    // injection surface, and Postgres tsquery operators (`&`, `|`, `!`, `:*`) typed by
    // a worker are inert: they were stripped by the sanitizer before they reached this
    // string. The last token gets the prefix suffix (`"mig welder" → "mig & welder:*"`),
    // which is what keeps Hinglish suffix inflection ("plumbers", pluralized trade
    // names) matching without any stemmer.
    //
    // The vector carries role_title at weight A and skill_phrases at weight B (migration
    // 0089), so one probe answers both halves of the old ILIKE OR EXISTS predicate over
    // the GIN index instead of a sequential scan per row.
    //
    // SEMANTIC DELTA vs ILIKE, stated honestly: FTS matches whole TOKENS with optional
    // prefix. A query term landing MID-WORD ("elde" inside "welder") no longer matches;
    // every prefix/whole-word case behaves identically, which is how workers actually
    // type. Symbol-only queries (no usable tokens after sanitizing) fall back to the
    // literal-containment ILIKE branch below rather than dead-ending the search box.
    if (args.q) {
      const tsquery = searchTsQuery(args.q);
      if (tsquery) {
        conditions.push(sql`${jobPostings.searchVec} @@ to_tsquery('simple', ${tsquery})`);
      } else {
        const like = `%${args.q}%`;
        conditions.push(
          sql`(${jobPostings.roleTitle} ILIKE ${like} OR EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(${jobPostings.skillPhrases}) AS phrase
            WHERE phrase ILIKE ${like}
          ))`,
        );
      }
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

    // The relevance ladder, as a plain integer. Lower sorts first. It exists ONLY when the
    // worker typed a term — with no `q` every open posting is equally relevant, so the key is
    // dropped from the sort instead of being pinned to a constant.
    //
    // #974: a relevance key must never degrade to a BARE INTEGER. Postgres reads a lone integer
    // constant in `ORDER BY` as an OUTPUT-COLUMN ORDINAL, not as a value to sort by, so the
    // previous `sql`0`` on this path rendered `ORDER BY 0, ...` and every title-less search —
    // the whole location-only case, "jobs in Jaipur" — died on `ORDER BY position 0 is not in
    // select list`: a 500 on a shipped screen. Only this branch broke, because the `q` branch
    // emits a `CASE … END` EXPRESSION, which Postgres sorts by rather than resolves as a
    // position. Dropping the key removes the class of bug; `(0)` would only have hidden it.
    const relevance = args.q
      ? sql<number>`CASE
          WHEN ${jobPostings.roleTitle} ILIKE ${`${args.q}%`} THEN 0
          WHEN ${jobPostings.roleTitle} ILIKE ${`%${args.q}%`} THEN 1
          ELSE 2
        END`
      : null;

    // `id` LAST is what makes the order TOTAL: without it two postings published in the same
    // transaction tie, and page 2 can repeat or drop a row page 1 already showed.
    const orderBy = [
      ...(relevance ? [relevance] : []),
      sql`${jobPostings.publishedAt} DESC NULLS LAST`,
      jobPostings.id,
    ];

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
      .orderBy(...orderBy)
      .limit(args.limit + 1)
      .offset(args.offset);

    return { rows: rows.slice(0, args.limit), hasMore: rows.length > args.limit };
  }
}
