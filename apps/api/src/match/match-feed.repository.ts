import { Inject, Injectable } from "@nestjs/common";
import { sql as dsql } from "drizzle-orm";
import type { Database } from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/** One candidate feed card, straight off the `job_reach ⋈ job_postings` join. */
export interface MatchFeedRow {
  jobPostingId: string;
  /** Opaque company key: `payer_id`, falling back to `created_by` for ops postings. */
  payerKey: string;
  matchTier: 1 | 2;
  matchedSkillId: string;
  boosted: boolean;
  publishedAt: Date | null;
  roleTitle: string;
  city: string | null;
  payMin: number | null;
  payMax: number | null;
  shift: string | null;
  neededBy: string | null;
}

/**
 * NOT PROJECTED, DELIBERATELY: `org_label` and `verification_status`.
 *
 * ADR-0036 leaves exactly one open product/privacy question — "V1's
 * max-2-consecutive-cards-per-company rule implies company identity is visible on the
 * worker card. Whether `org_label` renders there needs a security review sign-off before
 * the feed ships." The max-2 rule needs a company KEY, not a company NAME, so this query
 * selects `payer_id`/`created_by` (opaque) and does not read `org_label` at all. Adding
 * it to the projection is the change that needs the sign-off; leaving it out means the
 * question cannot be answered accidentally by a future mapper edit.
 */

/** The worker's own filters. EVERY ONE IS OPTIONAL and every default is off. */
export interface MatchFeedFilters {
  city?: string;
  shift?: string;
  /** Minimum monthly pay the worker will consider. OFF unless he sets it. */
  payMin?: number;
}

/** One applicant row for the payer's candidate list, in rank order. */
export interface CandidateRow {
  applicationId: string;
  workerId: string;
  matchTier: number | null;
  skillMonths: number | null;
  industryMonths: number | null;
  lastWorkedAt: string | null;
  createdAt: Date;
  /** The rule version that produced the snapshot (Policy 24). */
  engineVersion: string | null;
  /**
   * The skill he was reached through — a LIVE lookup from `job_reach`, for the E18
   * badge only. DELIBERATELY NOT part of the frozen snapshot and NEVER a rank input:
   * it can drift if the worker's skills are re-derived, whereas the ORDER cannot,
   * because the order reads only the snapshot columns. A badge that says "related
   * skill" one day and names a different related skill the next is cosmetic; a list
   * that reorders is E16/Policy 7 breakage.
   */
  matchedSkillId: string | null;
}

/**
 * MOMENTS ④ AND ⑥ — the two READ paths of Matching V1.
 *
 * "Everything is computed on WRITE. Every read is an indexed sort." Both queries here
 * are exactly that: the feed is a covering-index join over `job_reach_worker_idx`
 * (`(worker_id) INCLUDE (job_posting_id, match_tier, matched_skill_id)`) plus
 * `job_postings_feed_idx`; the candidate list is a single indexed sort over
 * `applications_rank_idx`. Neither scores anything.
 *
 * THE RANK TUPLE APPEARS IN EXACTLY TWO PLACES IN THE CODEBASE: `rankKeyCompare` in
 * `@badabhai/match-engine`, and the ORDER BY in {@link listCandidates} below. That is a
 * duplication we cannot avoid (a database cannot call a TypeScript comparator and
 * paginating in application code would defeat the index), so the two are PINNED TO EACH
 * OTHER by an integration test that runs both over the same rows and asserts identical
 * order. If you change one, that test will tell you about the other.
 */
@Injectable()
export class MatchFeedRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * MOMENT ④ — the worker's feed.
   *
   *   job_reach ⋈ job_postings WHERE worker_id = :me AND status = 'open'
   *     AND NOT EXISTS (applied/skipped on job_posting_id)
   *     AND <his filters>
   *   ORDER BY (boosted_until > now()) DESC, published_at DESC, id ASC
   *
   * NO SCORE, NO RANKING — the order is boost, then recency, then a stable id tiebreak.
   * The `id ASC` tail makes it a TOTAL order: a feed that reorders between page loads is
   * a bug (E11/Policy 7), and without it two postings published in the same transaction
   * would swap on every fetch.
   *
   * SKIPPED JOBS ARE EXCLUDED. The legacy `/feed` deliberately re-serves skipped jobs
   * forever (documented in `applications.repository.ts`), but the V1 spec's moment ④
   * says `NOT EXISTS (applied / passed)`, and "passed" is a skip. Where the spec and the
   * existing behaviour disagree, the spec wins — and it only applies behind the flag, so
   * the legacy surface is untouched.
   *
   * FILTERS ARE WIDE OR OFF (Part 3). Each one is applied only when the CALLER supplied
   * it; a `null` field on the posting NEVER excludes it (a job with no pay band matches
   * every pay filter). "Every default is wide or off. Defaults that narrow are a volume
   * leak."
   */
  async listFeed(
    workerId: string,
    limit: number,
    filters: MatchFeedFilters,
  ): Promise<MatchFeedRow[]> {
    const rows = await this.db.execute<{
      job_posting_id: string;
      payer_key: string;
      match_tier: number;
      matched_skill_id: string;
      boosted: boolean;
      published_at: Date | null;
      role_title: string;
      city: string | null;
      pay_min: number | null;
      pay_max: number | null;
      shift: string | null;
      needed_by: string | null;
    }>(dsql`
      SELECT jp.id                                        AS job_posting_id,
             COALESCE(jp.payer_id, jp.created_by)::text   AS payer_key,
             jr.match_tier                                AS match_tier,
             jr.matched_skill_id                          AS matched_skill_id,
             (jp.boosted_until IS NOT NULL AND jp.boosted_until > now()) AS boosted,
             jp.published_at                              AS published_at,
             jp.role_title                                AS role_title,
             COALESCE(jp.city, jp.location_label)         AS city,
             jp.pay_min                                   AS pay_min,
             jp.pay_max                                   AS pay_max,
             jp.shift                                     AS shift,
             jp.needed_by                                 AS needed_by
      FROM job_reach jr
      JOIN job_postings jp ON jp.id = jr.job_posting_id
      WHERE jr.worker_id = ${workerId}::uuid
        AND jp.status = 'open'
        AND NOT EXISTS (
          SELECT 1 FROM applications a
          WHERE a.worker_id = ${workerId}::uuid
            AND a.job_posting_id = jp.id
        )
        -- Worker filters. Each is INERT unless he supplied it, and a NULL column on the
        -- posting never excludes it: a job with no city/shift/pay band matches every
        -- filter rather than vanishing from a feed it belongs in (Part 3).
        AND (${filters.city ?? null}::text IS NULL OR jp.city IS NULL
             OR lower(jp.city) = lower(${filters.city ?? null}::text))
        AND (${filters.shift ?? null}::text IS NULL OR jp.shift IS NULL
             OR jp.shift = ${filters.shift ?? null}::text)
        -- Pay: compare against the TOP of the band. A worker asking for >= 20000 should
        -- still see an 18000-25000 job — it can pay him what he asked.
        AND (${filters.payMin ?? null}::int IS NULL OR jp.pay_max IS NULL
             OR jp.pay_max >= ${filters.payMin ?? null}::int)
      ORDER BY (jp.boosted_until IS NOT NULL AND jp.boosted_until > now()) DESC,
               jp.published_at DESC NULLS LAST,
               jp.id ASC
      LIMIT ${limit}
    `);

    const list = rows as unknown as {
      job_posting_id: string;
      payer_key: string;
      match_tier: number;
      matched_skill_id: string;
      boosted: boolean;
      published_at: Date | string | null;
      role_title: string;
      city: string | null;
      pay_min: number | null;
      pay_max: number | null;
      shift: string | null;
      needed_by: string | null;
    }[];

    return list.map((r) => ({
      jobPostingId: r.job_posting_id,
      payerKey: r.payer_key,
      matchTier: r.match_tier === 1 ? 1 : 2,
      matchedSkillId: r.matched_skill_id,
      boosted: Boolean(r.boosted),
      publishedAt: r.published_at === null ? null : new Date(r.published_at),
      roleTitle: r.role_title,
      city: r.city,
      payMin: r.pay_min,
      payMax: r.pay_max,
      shift: r.shift,
      neededBy: r.needed_by,
    }));
  }

  /**
   * MOMENT ⑥ — the company's candidate list. A pure indexed sort over the SNAPSHOT
   * columns, in the exact rank order ADR-0036 §2 specifies.
   *
   * ```sql
   * ORDER BY CASE WHEN match_tier > 1 AND skill_months >= :floor THEN 1 ELSE match_tier END ASC,
   *          skill_months DESC, industry_months DESC,
   *          last_worked_at DESC NULLS LAST, created_at DESC, id ASC
   * ```
   *
   * The `CASE` is the owner's tier-with-floor ruling (2026-07-31, Part 9 #1 option b):
   * a related-skill worker enters tier-1 ordering once his months on that skill clear
   * `match_config.tier_floor_months`. It is a THRESHOLD, not a weight — there is nothing
   * here a config change could re-weight, which is the property the spec chose the
   * lexicographic key for.
   *
   * The RAW `match_tier` is returned alongside, so the UI can badge a related-skill
   * candidate (E18) even when the floor promoted him into tier-1 ordering. The company
   * opted into that breadth and should see plainly what it is looking at before
   * spending ₹40.
   *
   * `NULLS LAST` on `last_worked_at` mirrors `rankKeyCompare`: "we do not know when he
   * last worked" never beats a date. `COALESCE(x, -1)` on the two month columns mirrors
   * the comparator's `finiteMonths` treatment of a missing value as 0 — except that a
   * NULL is genuinely unknown rather than zero, so it sorts BELOW a real 0 rather than
   * tying with it. The parity test covers rows with NULL snapshots explicitly.
   *
   * ONLY `action='applied'` ROWS. A skip is never ranked, and the partial index
   * `applications_rank_idx` is defined on exactly that predicate.
   */
  async listCandidates(
    jobPostingId: string,
    tierFloorMonths: number,
    limit: number,
  ): Promise<CandidateRow[]> {
    const rows = await this.db.execute<{
      id: string;
      worker_id: string;
      match_tier: number | null;
      skill_months: number | null;
      industry_months: number | null;
      last_worked_at: string | null;
      created_at: Date;
      engine_version: string | null;
      matched_skill_id: string | null;
    }>(dsql`
      SELECT a.id, a.worker_id, a.match_tier, a.skill_months, a.industry_months,
             a.last_worked_at, a.created_at, a.engine_version,
             jr.matched_skill_id
      FROM applications a
      -- DISPLAY ONLY (the E18 badge). LEFT so a candidate whose reach row was pruned
      -- (skills re-derived, posting edited) still appears on the list he applied to —
      -- "Ranking never removes anyone" (Policy 6). It contributes NOTHING to the
      -- ORDER BY below, which reads only the frozen snapshot columns.
      LEFT JOIN job_reach jr
        ON jr.job_posting_id = a.job_posting_id AND jr.worker_id = a.worker_id
      WHERE a.job_posting_id = ${jobPostingId}::uuid
        AND a.action = 'applied'
      ORDER BY CASE
                 WHEN a.match_tier > 1 AND COALESCE(a.skill_months, 0) >= ${tierFloorMonths}::int
                   THEN 1
                 ELSE COALESCE(a.match_tier, 2)
               END ASC,
               COALESCE(a.skill_months, -1) DESC,
               COALESCE(a.industry_months, -1) DESC,
               a.last_worked_at DESC NULLS LAST,
               a.created_at DESC,
               a.id ASC
      LIMIT ${limit}
    `);

    const list = rows as unknown as {
      id: string;
      worker_id: string;
      match_tier: number | null;
      skill_months: number | null;
      industry_months: number | null;
      last_worked_at: string | Date | null;
      created_at: Date | string;
      engine_version: string | null;
      matched_skill_id: string | null;
    }[];

    return list.map((r) => ({
      applicationId: r.id,
      workerId: r.worker_id,
      matchTier: r.match_tier,
      skillMonths: r.skill_months,
      industryMonths: r.industry_months,
      lastWorkedAt:
        r.last_worked_at === null
          ? null
          : r.last_worked_at instanceof Date
            ? r.last_worked_at.toISOString().slice(0, 10)
            : String(r.last_worked_at).slice(0, 10),
      createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
      engineVersion: r.engine_version,
      matchedSkillId: r.matched_skill_id,
    }));
  }
}
