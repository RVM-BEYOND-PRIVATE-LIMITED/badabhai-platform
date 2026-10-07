import { Inject, Injectable } from "@nestjs/common";
import { sql as dsql, type SQL } from "drizzle-orm";
import type { Database } from "@badabhai/db";
import type { ApplicantStage } from "@badabhai/types";
import { DATABASE } from "../database/database.module";
import type { InboxCursor } from "./payer-applicant-inbox.cursor";
import type { InboxPostingKind } from "./payer-applicant-inbox.dto";

/** One application on the inbox page — WHO applied WHERE, not yet the faceless row. */
export interface InboxPageRow {
  applicationId: string;
  workerId: string;
  /** `applications.created_at` as microsecond UTC text — the keyset value a cursor carries. */
  appliedKey: string;
  postingKind: InboxPostingKind;
  postingId: string;
  /** The payer's own title for the posting (`jobs.title` / `job_postings.role_title`). */
  postingTitle: string;
  /**
   * The applicant's stored board stage, `new` when none — RAW text (the CHECK keeps it inside
   * `APPLICANT_STAGES`; narrowing is the service's). Present only when the query asked for
   * `stages`; absent otherwise.
   */
  stage?: string;
}

export interface InboxPageQuery {
  /** Only this posting's applicants (either table); absent = every owned posting. */
  postingId?: string;
  /** Strictly after this position in the inbox order; absent = from the top. */
  after?: InboxCursor;
  limit: number;
  /**
   * The saved pipeline board (owner ruling 2026-10-07) — pass it ONLY while
   * `PAYER_APPLICANT_STAGES_ENABLED` is on. Present: each row carries its `stage`, and `only`
   * keeps the rows in that stage. Absent: the statement never names `payer_applicant_stages`
   * (migration 0134 need not exist) and is the pre-stage statement exactly.
   */
  stages?: { only?: ApplicantStage };
}

/**
 * THE INBOX PAGE (`GET /payer/reach/applicants`) — one statement, both sources, newest first.
 *
 * ```sql
 * (agency arm)  jobs j ⋈ applications a ON a.job_id = j.id                 WHERE j.payer_id = :payer
 * UNION ALL
 * (company arm) job_postings jp ⋈ applications a ON a.job_posting_id = jp.id WHERE jp.payer_id = :payer
 * ORDER BY created_at DESC, application_id DESC   LIMIT :limit
 * ```
 *
 * OWNERSHIP is the two WHEREs on the SESSION payer, the same two predicates
 * `PayerApplicantsService.listForOwned` resolves an id with (`jobs.payer_id`,
 * `job_postings.payer_id`). Another payer's rows cannot match, and a `postingId` the payer does
 * not own matches nothing in either arm. `payer_id` is never projected.
 *
 * MEMBERSHIP IS EACH PER-POSTING LIST'S, so every row here has a row on its posting's list:
 *  - both arms: `action = 'applied'` (a skip is never an applicant) and the ADR-0031 (b)
 *    freeze (`workers.deletion_scheduled_at IS NULL`);
 *  - agency arm: a `worker_profiles` row must exist — the per-job list ranks appliers off their
 *    profile row (`applicantSignalRowsStatement` reads FROM `worker_profiles`), so an applier
 *    without one is not on it;
 *  - company arm: an application whose `job_id` is a `jobs` row this payer owns belongs to the
 *    agency arm (jobs-first, `listForOwned`'s resolution order). The write path never sets both
 *    references, but the CHECK allows it, and without this an application could be listed twice
 *    and the keyset would no longer be a total order.
 *
 * ORDER + KEYSET: `(created_at, id)` DESC, compared as a row value in EACH arm so the predicate
 * is pushed below the union. `id` is unique and each application is in one arm, so the order is
 * total and a page boundary can neither skip nor repeat a row.
 *
 * INDEXES (no migration): each arm starts from the payer's own postings
 * (`jobs_payer_id_status_idx` / `job_postings_payer_id_idx`) and reaches applications through
 * `applications_job_id_idx` / `applications_rank_idx` (partial on `action = 'applied'`), then
 * top-N sorts the payer's applied applications. Cost grows with ONE payer's application count,
 * never the table's. No index serves `ORDER BY created_at` across a payer's postings without a
 * `payer_id` on `applications` — the change to make if one payer's applications reach ~10^5.
 *
 * STAGES (owner ruling 2026-10-07; only when `query.stages` is passed, i.e. the flag is on): each
 * arm LEFT JOINs `payer_applicant_stages` on its full primary key — its own posting kind literal,
 * its posting id, the applicant — and projects `COALESCE(s.stage, 'new')` (no row = `new`). The
 * optional filter is a predicate on that same value in EACH arm, below the union and the LIMIT,
 * so a filtered page is still the first N rows of the same total order and the keyset holds
 * unchanged. One PK probe per candidate application; no new index is needed (the plan is driven
 * from the payer's own postings, as above). Without `query.stages` none of this is emitted.
 */
export function inboxPageStatement(payerId: string, query: InboxPageQuery): SQL {
  const posting = (column: SQL) =>
    query.postingId === undefined ? dsql`` : dsql`AND ${column} = ${query.postingId}::uuid`;
  const keyset =
    query.after === undefined
      ? dsql``
      : dsql`AND (a.created_at, a.id) < (${query.after.appliedKey}::timestamptz, ${query.after.applicationId}::uuid)`;
  const stages = query.stages;
  // Each arm's posting kind is a LITERAL, so the probe is an equality on the whole primary key.
  const stageJoin = (kind: "agency_job" | "company_posting", postingColumn: SQL) =>
    stages === undefined
      ? dsql``
      : dsql`LEFT JOIN payer_applicant_stages s
          ON s.posting_kind = ${dsql.raw(`'${kind}'`)} AND s.posting_id = ${postingColumn} AND s.worker_id = a.worker_id`;
  const stageColumn = stages === undefined ? dsql`` : dsql`, COALESCE(s.stage, 'new') AS stage`;
  const stageFilter =
    stages?.only === undefined ? dsql`` : dsql`AND COALESCE(s.stage, 'new') = ${stages.only}`;
  const outerStage = stages === undefined ? dsql`` : dsql`, p.stage`;

  return dsql`
    SELECT p.application_id, p.worker_id, p.applied_key, p.posting_kind, p.posting_id,
           p.posting_title${outerStage}
    FROM (
      SELECT a.id                AS application_id,
             a.worker_id         AS worker_id,
             a.created_at        AS created_at,
             to_char(a.created_at AT TIME ZONE 'UTC',
                     'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS applied_key,
             'agency_job'::text  AS posting_kind,
             j.id                AS posting_id,
             j.title             AS posting_title${stageColumn}
      FROM jobs j
      INNER JOIN applications a ON a.job_id = j.id
      INNER JOIN workers w ON w.id = a.worker_id
      ${stageJoin("agency_job", dsql`j.id`)}
      WHERE j.payer_id = ${payerId}::uuid
        AND a.action = 'applied'
        AND w.deletion_scheduled_at IS NULL
        AND EXISTS (SELECT 1 FROM worker_profiles wp WHERE wp.worker_id = a.worker_id)
        ${posting(dsql`j.id`)}
        ${keyset}
        ${stageFilter}
      UNION ALL
      SELECT a.id                AS application_id,
             a.worker_id         AS worker_id,
             a.created_at        AS created_at,
             to_char(a.created_at AT TIME ZONE 'UTC',
                     'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS applied_key,
             'company_posting'::text AS posting_kind,
             jp.id               AS posting_id,
             jp.role_title       AS posting_title${stageColumn}
      FROM job_postings jp
      INNER JOIN applications a ON a.job_posting_id = jp.id
      INNER JOIN workers w ON w.id = a.worker_id
      ${stageJoin("company_posting", dsql`jp.id`)}
      WHERE jp.payer_id = ${payerId}::uuid
        AND a.action = 'applied'
        AND w.deletion_scheduled_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM jobs oj WHERE oj.id = a.job_id AND oj.payer_id = ${payerId}::uuid
        )
        ${posting(dsql`jp.id`)}
        ${keyset}
        ${stageFilter}
    ) p
    ORDER BY p.created_at DESC, p.application_id DESC
    LIMIT ${query.limit}
  `;
}

type InboxPageSqlRow = {
  application_id: string;
  worker_id: string;
  applied_key: string;
  posting_kind: string;
  posting_id: string;
  posting_title: string;
  /** Only projected when the query asked for `stages`. */
  stage?: string;
};

/**
 * DB access for the payer's cross-posting applicant inbox. ONE read: the page of applications
 * (see {@link inboxPageStatement}). The faceless rows themselves come from the per-posting
 * builders (`ReachService`, `MatchCandidatesService`); this repository decides only WHICH
 * applications are on the page, never what a row shows.
 */
@Injectable()
export class PayerApplicantInboxRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async listPage(payerId: string, query: InboxPageQuery): Promise<InboxPageRow[]> {
    const rows = await this.db.execute<InboxPageSqlRow>(inboxPageStatement(payerId, query));
    return (rows as unknown as InboxPageSqlRow[]).map((r) => ({
      applicationId: r.application_id,
      workerId: r.worker_id,
      appliedKey: r.applied_key,
      postingKind: toPostingKind(r.posting_kind),
      postingId: r.posting_id,
      postingTitle: r.posting_title,
      ...(r.stage === undefined ? {} : { stage: r.stage }),
    }));
  }
}

/** The SQL emits two literals; anything else is a defect in the statement, never data. */
function toPostingKind(raw: string): InboxPostingKind {
  if (raw === "agency_job" || raw === "company_posting") return raw;
  throw new Error(`inbox page: unexpected posting kind ${JSON.stringify(raw)}`);
}
