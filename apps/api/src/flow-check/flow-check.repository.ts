import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { reachesBadaBhaiWorkers, reachesRvmStudents, type Database } from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/** The clock the counts are read against. Every bound is a parameter, never `now()` in SQL. */
export interface FlowCountWindow {
  /** The run's time: the end of the per-day window. */
  readonly now: Date;
  /** The start of the per-day window (`now` minus the window). */
  readonly since: Date;
  /** A pending RVM review older than this (its `updated_at`) is overdue. */
  readonly reviewCutoff: Date;
  /** A live job published before this with no reach row is zero-reach. */
  readonly reachCutoff: Date;
  /** Applications made in [untouchedFrom, untouchedTo) crossed the untouched threshold today. */
  readonly untouchedFrom: Date;
  readonly untouchedTo: Date;
}

/** What BadaBhai's own tables say about the flow. Counts only. */
export interface FlowCounts {
  readonly jobsPosted: number;
  readonly applicationsReceived: number;
  readonly campusApplications: number;
  readonly rvmReviewOverdue: number;
  readonly liveZeroReach: number;
  readonly campusUnlinked: number;
  readonly applicationsUntouched: number;
}

/** At most this many ids per check go into the breach log line (the counts are always whole). */
export const FLOW_CHECK_LOG_IDS = 20;

/** A few ids behind each breaching BadaBhai count, for the log line. Opaque uuids only. */
export interface FlowSampleIds {
  readonly rvmReviewOverdue: readonly string[];
  readonly liveZeroReach: readonly string[];
  readonly campusUnlinked: readonly string[];
}

const iso = (d: Date) => d.toISOString();

/**
 * #2890 — THE DAILY FLOW CHECK'S ONE READ of BadaBhai's tables.
 *
 * ONE SNAPSHOT: every count runs in one `repeatable read`, `read only` transaction, so an
 * application landing mid-read cannot be counted in one figure and missed in another. Read-only by
 * construction: nothing here writes a row.
 *
 * WHAT EACH COUNT MEANS (the window is the last day, ending at the run):
 *  - jobs posted: postings whose `published_at` falls in the window (when a job became visible).
 *  - applications received: `applied` decisions on a job posting made in the window, from the
 *    worker app and Campus alike; Campus applications: the `institute_applications` rows made in it.
 *  - RVM review overdue (#2769): OPEN, not hidden postings with an RVM part whose placement-team
 *    review row is still `pending` and has been since before the cutoff. A company edit that
 *    re-pends an approval bumps `updated_at`, so the wait restarts there, as the reviewer sees it.
 *  - live zero-reach: OPEN, not hidden postings a BadaBhai worker may see (the shared fragment,
 *    Campus hold included), published before the grace cutoff, with no `job_reach` row.
 *  - Campus unlinked (#2782, BadaBhai's half): a LIVE Campus application (not withdrawn) whose
 *    BadaBhai `applications` row is gone. Campus still shows it; the company no longer does.
 *  - untouched: `applied` decisions on a company's own posting that crossed the untouched threshold
 *    in the last day with no stage move on the board and no contact open. BadaBhai records no
 *    "seen" mark, so an action is the closest honest proxy for a company view.
 */
@Injectable()
export class FlowCheckRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async readCounts(w: FlowCountWindow): Promise<FlowCounts> {
    return this.db.transaction(
      async (tx) => {
        const [row] = (await tx.execute(sql`
          SELECT
            (SELECT count(*) FROM job_postings jp
              WHERE jp.published_at >= ${iso(w.since)}::timestamptz
                AND jp.published_at < ${iso(w.now)}::timestamptz)::bigint AS jobs_posted,
            (SELECT count(*) FROM applications a
              WHERE a.action = 'applied' AND a.job_posting_id IS NOT NULL
                AND a.created_at >= ${iso(w.since)}::timestamptz
                AND a.created_at < ${iso(w.now)}::timestamptz)::bigint AS applications_received,
            (SELECT count(*) FROM institute_applications ia
              WHERE ia.created_at >= ${iso(w.since)}::timestamptz
                AND ia.created_at < ${iso(w.now)}::timestamptz)::bigint AS campus_applications,
            (${overdueReviews(w)})::bigint AS rvm_review_overdue,
            (${zeroReach(w)})::bigint AS live_zero_reach,
            (SELECT count(*) FROM institute_applications ia
              WHERE ia.withdrawn_at IS NULL AND ia.application_id IS NULL)::bigint AS campus_unlinked,
            (SELECT count(*) FROM applications a
              JOIN job_postings jp ON jp.id = a.job_posting_id
              WHERE a.action = 'applied' AND jp.payer_id IS NOT NULL
                AND a.created_at >= ${iso(w.untouchedFrom)}::timestamptz
                AND a.created_at < ${iso(w.untouchedTo)}::timestamptz
                AND NOT EXISTS (
                  SELECT 1 FROM payer_applicant_stages s
                  WHERE s.posting_kind = 'company_posting'
                    AND s.posting_id = a.job_posting_id AND s.worker_id = a.worker_id)
                AND NOT EXISTS (
                  SELECT 1 FROM unlocks u
                  WHERE u.worker_id = a.worker_id AND u.job_posting_id = a.job_posting_id)
            )::bigint AS applications_untouched
        `)) as unknown as Array<Record<string, number | string>>;
        const n = (k: string) => Number(row?.[k] ?? 0);
        return {
          jobsPosted: n("jobs_posted"),
          applicationsReceived: n("applications_received"),
          campusApplications: n("campus_applications"),
          rvmReviewOverdue: n("rvm_review_overdue"),
          liveZeroReach: n("live_zero_reach"),
          campusUnlinked: n("campus_unlinked"),
          applicationsUntouched: n("applications_untouched"),
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  /**
   * A few ids behind the three BadaBhai counts an operator fixes by hand (posting ids, and the
   * Campus application's own row id), oldest first. Read only when that count breached, for the log
   * line; never stored on the spine.
   */
  async sampleIds(w: FlowCountWindow): Promise<FlowSampleIds> {
    const ids = async (query: ReturnType<typeof sql>) =>
      ((await this.db.execute(query)) as unknown as Array<{ id: string }>).map((r) => r.id);
    const [rvmReviewOverdue, liveZeroReach, campusUnlinked] = await Promise.all([
      ids(sql`SELECT jp.id::text AS id FROM job_postings jp
        JOIN job_posting_institute_reviews r ON r.job_posting_id = jp.id
        WHERE ${overduePredicate(w)}
        ORDER BY r.updated_at, jp.id LIMIT ${FLOW_CHECK_LOG_IDS}`),
      ids(sql`SELECT jp.id::text AS id FROM job_postings jp
        WHERE ${zeroReachPredicate(w)}
        ORDER BY jp.published_at, jp.id LIMIT ${FLOW_CHECK_LOG_IDS}`),
      ids(sql`SELECT ia.id::text AS id FROM institute_applications ia
        WHERE ia.withdrawn_at IS NULL AND ia.application_id IS NULL
        ORDER BY ia.created_at, ia.id LIMIT ${FLOW_CHECK_LOG_IDS}`),
    ]);
    return { rvmReviewOverdue, liveZeroReach, campusUnlinked };
  }
}

/** Open, visible postings with an RVM part whose review has been pending since before the cutoff. */
function overduePredicate(w: FlowCountWindow) {
  return sql`jp.status = 'open' AND jp.hidden_at IS NULL
    AND ${reachesRvmStudents(sql.raw("jp.audience"))}
    AND r.state = 'pending' AND r.updated_at < ${iso(w.reviewCutoff)}::timestamptz`;
}

function overdueReviews(w: FlowCountWindow) {
  return sql`SELECT count(*) FROM job_postings jp
    JOIN job_posting_institute_reviews r ON r.job_posting_id = jp.id
    WHERE ${overduePredicate(w)}`;
}

/** Open, visible postings a BadaBhai worker may see, past the grace, with no reach row. */
function zeroReachPredicate(w: FlowCountWindow) {
  return sql`jp.status = 'open' AND jp.hidden_at IS NULL AND ${reachesBadaBhaiWorkers("jp")}
    AND jp.published_at < ${iso(w.reachCutoff)}::timestamptz
    AND NOT EXISTS (SELECT 1 FROM job_reach jr WHERE jr.job_posting_id = jp.id)`;
}

function zeroReach(w: FlowCountWindow) {
  return sql`SELECT count(*) FROM job_postings jp WHERE ${zeroReachPredicate(w)}`;
}
