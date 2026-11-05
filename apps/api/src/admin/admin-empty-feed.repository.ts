import { Inject, Injectable } from "@nestjs/common";
import { sql, type SQL } from "drizzle-orm";
import { CURRENT_PROFILE_ORDER, type Database } from "@badabhai/db";
import type { ProfileStatus } from "@badabhai/types";
import { DATABASE } from "../database/database.module";
import type { AdminEmptyFeedMode } from "./admin-empty-feed.dto";

/** The raw list row; mapped to the wire shape by the service. */
export interface AdminEmptyFeedRow {
  [key: string]: unknown;
  worker_id: string;
  trade_id: string | null;
  city: string | null;
  profile_status: ProfileStatus | null;
  days_since_signup: number;
}

export interface AdminEmptyFeedTradeRow {
  [key: string]: unknown;
  trade_id: string | null;
  worker_count: number;
}

export interface AdminEmptyFeedCityRow {
  [key: string]: unknown;
  city: string | null;
  worker_count: number;
}

/** The bare page the repository returns; the service adds labels and totals. */
export interface AdminEmptyFeedQueryResult {
  workers: AdminEmptyFeedRow[];
  byTrade: AdminEmptyFeedTradeRow[];
  byCity: AdminEmptyFeedCityRow[];
}

/**
 * #2569 — the EMPTY-FEED read, in the ACTIVE feed mode.
 *
 * THE RULE IS NOT RE-DERIVED HERE FROM A DIFFERENT IDEA OF "MATCHING". Each arm below is the
 * eligibility half of the feed implementation the worker app actually reads:
 *
 *   - `jobs`   — `ApplicationsRepository.findOpenJobs` (the legacy arm): OPEN `jobs`, minus the
 *                worker's own `action='applied'` rows.
 *   - `union`  — that arm PLUS `ApplicationsRepository.findOpenPostingsForFeed`: open +
 *                published postings, minus the worker's applications, minus any twin whose
 *                source job is still open, and overlapping the worker's WANTED skills when he
 *                has any.
 *   - `v1`     — `MatchFeedRepository.listFeed`: a `job_reach` row, open posting, live twin
 *                source, minus any decision on the posting and any decision on a twin's source.
 *
 * The mode is chosen by `AdminEmptyFeedService` from the SAME two flags `ApplicationsService`
 * reads, so flipping a flag cannot leave this screen describing a feed nobody sees. The DB test
 * compares the list against `ApplicationsService.getFeed` for the same seeded workers.
 *
 * The three arms live beside the feed SQL rather than being imported because the feed arms are
 * row-returning Drizzle queries and this is a set-based anti-join over every worker. The
 * predicates above are the contract; `admin-empty-feed.contract.test.ts` pins them to the feed
 * source so an edit to either side is visible.
 */
@Injectable()
export class AdminEmptyFeedRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async page(input: {
    mode: AdminEmptyFeedMode;
    includeTestAccounts: boolean;
    page: number;
    pageSize: number;
  }): Promise<AdminEmptyFeedQueryResult> {
    const cte = this.emptyFeedCte(input.mode, input.includeTestAccounts);
    const offset = (input.page - 1) * input.pageSize;

    const [workers, byTrade, byCity] = await Promise.all([
      this.db.execute<AdminEmptyFeedRow>(sql`
        ${cte}
        SELECT id                                                           AS worker_id,
               canonical_trade_id                                           AS trade_id,
               current_city                                                 AS city,
               profile_status,
               GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - created_at)) / 86400))::int
                                                                            AS days_since_signup
        FROM empty_feed
        ORDER BY created_at ASC, id ASC
        LIMIT ${input.pageSize} OFFSET ${offset}
      `),
      this.db.execute<AdminEmptyFeedTradeRow>(sql`
        ${cte}
        SELECT canonical_trade_id AS trade_id, count(*)::int AS worker_count
        FROM empty_feed
        GROUP BY canonical_trade_id
        ORDER BY worker_count DESC, canonical_trade_id ASC NULLS LAST
      `),
      this.db.execute<AdminEmptyFeedCityRow>(sql`
        ${cte}
        SELECT current_city AS city, count(*)::int AS worker_count
        FROM empty_feed
        GROUP BY current_city
        ORDER BY worker_count DESC, current_city ASC NULLS LAST
      `),
    ]);

    return { workers, byTrade, byCity };
  }

  /**
   * The one worker projection every query shares: the worker row plus its CURRENT profile
   * (`CURRENT_PROFILE_ORDER`, never a hand-rolled newest-row rule), filtered to active,
   * non-test (unless asked) workers with NO job in the active feed.
   */
  private emptyFeedCte(mode: AdminEmptyFeedMode, includeTestAccounts: boolean): SQL {
    const workerId = sql`w.id`;
    const feedExists = this.feedExists(mode, workerId);
    return sql`
      WITH empty_feed AS (
        SELECT w.id,
               w.created_at,
               w.current_city,
               p.profile_status,
               p.canonical_trade_id
        FROM workers w
        LEFT JOIN LATERAL (
          SELECT worker_profiles.profile_status,
                 worker_profiles.canonical_trade_id
          FROM worker_profiles
          WHERE worker_profiles.worker_id = w.id
          ORDER BY ${sql.join([...CURRENT_PROFILE_ORDER], sql`, `)}
          LIMIT 1
        ) p ON true
        WHERE w.status = 'active'
          AND (${includeTestAccounts} OR w.is_test_account = false)
          AND NOT (${feedExists})
      )
    `;
  }

  /** The eligibility half of the active feed, as one correlated EXISTS over `workerId`. */
  private feedExists(mode: AdminEmptyFeedMode, workerId: SQL): SQL {
    if (mode === "v1") return v1FeedExists(workerId);
    if (mode === "union") {
      return sql`(${legacyFeedExists(workerId)} OR ${unionPostingExists(workerId)})`;
    }
    return legacyFeedExists(workerId);
  }
}

/** `ApplicationsRepository.findOpenJobs`, no filters: open + not applied by this worker. */
function legacyFeedExists(workerId: SQL): SQL {
  return sql`EXISTS (
    SELECT 1
    FROM jobs
    WHERE jobs.status = 'open'
      AND NOT EXISTS (
        SELECT 1
        FROM applications
        WHERE applications.worker_id = ${workerId}
          AND applications.job_id = jobs.id
          AND applications.action = 'applied'
      )
  )`;
}

/** `ApplicationsRepository.findOpenPostingsForFeed`, no filters. */
function unionPostingExists(workerId: SQL): SQL {
  return sql`EXISTS (
    SELECT 1
    FROM job_postings
    WHERE job_postings.status = 'open'
      AND job_postings.published_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM applications
        WHERE applications.worker_id = ${workerId}
          AND applications.job_posting_id = job_postings.id
          AND applications.action = 'applied'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM applications
        WHERE applications.worker_id = ${workerId}
          AND applications.job_id = job_postings.source_job_id
          AND applications.action = 'applied'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM jobs
        WHERE jobs.id = job_postings.source_job_id
          AND jobs.status = 'open'
      )
      AND (
        NOT EXISTS (
          SELECT 1 FROM worker_skill
          WHERE worker_skill.worker_id = ${workerId} AND worker_skill.wants
        )
        OR job_postings.reach_skill_ids ?| ARRAY(
          SELECT worker_skill.skill_id FROM worker_skill
          WHERE worker_skill.worker_id = ${workerId} AND worker_skill.wants
        )
      )
  )`;
}

/** `MatchFeedRepository.listFeed`, no filters. */
function v1FeedExists(workerId: SQL): SQL {
  return sql`EXISTS (
    SELECT 1
    FROM job_reach
    JOIN job_postings ON job_postings.id = job_reach.job_posting_id
    LEFT JOIN jobs AS src
      ON job_postings.sync_source IS NOT NULL
     AND src.id = job_postings.source_job_id
    WHERE job_reach.worker_id = ${workerId}
      AND job_postings.status = 'open'
      AND (job_postings.sync_source IS NULL OR src.status = 'open')
      AND NOT EXISTS (
        SELECT 1
        FROM applications
        WHERE applications.worker_id = ${workerId}
          AND applications.job_posting_id = job_postings.id
      )
      AND NOT (
        job_postings.sync_source IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM applications
          WHERE applications.worker_id = ${workerId}
            AND applications.job_id = job_postings.source_job_id
        )
      )
  )`;
}
