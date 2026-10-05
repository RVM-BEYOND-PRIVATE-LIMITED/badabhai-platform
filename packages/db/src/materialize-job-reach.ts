/**
 * D5 — Matching V1 reach materialization (migration 0055). The doc's step ③.
 *
 * For every OPEN `job_postings` row, writes the set of workers the posting can reach into
 * `job_reach`. Run once after the D2/D3/D4 backfills; thereafter the API materializes on
 * publish/edit/unpause/ops-widen and this script is the repair/rebuild tool.
 *
 * THE CONTRACT (#1904, owner ruling "Option A"):
 *
 *   D5 MATERIALIZES THE STORED REACH SET. IT NEVER DECIDES IT.
 *
 *   `$reach` is the posting's STORED `job_postings.reach_skill_ids`, read as-is. This script
 *   never re-derives it from `match_skill_ids` ∪ `skill_related` and never writes the
 *   column. The stored set is the system of record, resolved by the API
 *   (`MatchSkillsService.resolveForPublish` is "the single place a posting's
 *   `reach_skill_ids` is decided"; ADR-0036 freezes a company's approved reach set). It
 *   already carries everything a re-derivation would lose:
 *     * honoured UNTICKS (migration 0121) — the related skills the poster chose to drop;
 *     * active OPS WIDENS (migration 0090) — Policy 27: ops may widen, never narrow, and
 *       only through the evented, expiring widen path;
 *     * EXPIRED-BUT-UNSWEPT widens — left in place so the `reach-widen-expiry` sweep
 *       retracts them with `reach_widen_expired`, rather than this script narrowing
 *       silently ahead of it;
 *     * the related-skill map AS OF PUBLISH — a later `skill_related` change does not
 *       propagate to a published posting (Policy 23).
 *
 *   A posting whose stored set cannot be trusted is SKIPPED and printed on a worklist
 *   (D3 style), never recomputed:
 *     * `match_skill_ids` is empty — there is nothing to anchor tier 1 on;
 *     * `reach_skill_ids` is empty;
 *     * `reach_skill_ids` does not contain every one of the posting's own
 *       `match_skill_ids` (the stored set must be a superset of the posted set).
 *   A skipped posting's existing `job_reach` rows are left untouched — repairing its
 *   stored set is an API/ops action (republish or edit), not a rebuild side effect.
 *
 * THE STATEMENT (per posting — one INSERT..SELECT, no app-side loop over workers). It is the
 * same statement `WorkerSkillsRepository.materializeReachForPosting` runs in the API:
 *
 *   INSERT INTO job_reach (job_posting_id, worker_id, match_tier, matched_skill_id)
 *   SELECT $job, ws.worker_id,
 *          MIN(CASE WHEN ws.skill_id = ANY($posted) THEN 1 ELSE 2 END),
 *          (ARRAY_AGG(ws.skill_id ORDER BY (ws.skill_id = ANY($posted)) DESC,
 *                                          ws.months_bucketed DESC))[1]
 *   FROM worker_skill ws
 *   WHERE ws.skill_id = ANY($reach) AND ws.wants
 *   GROUP BY ws.worker_id
 *   ON CONFLICT (job_posting_id, worker_id) DO UPDATE SET ...
 *
 * WHY IT IS SHAPED THIS WAY:
 *   * `MIN(CASE ...)` implements E6 BEST-TIER-WINS: a worker who qualifies both directly
 *     and via a related skill is TIER 1. MIN over the group is the whole rule.
 *   * `ARRAY_AGG(... ORDER BY (direct) DESC, months DESC)[1]` picks the skill that
 *     ACHIEVED the tier — a direct skill first, then the one with the most experience.
 *     It is the same ordering the tier decision uses, so tier and matched skill can
 *     never disagree.
 *   * `WHERE ws.skill_id = ANY($reach) AND ws.wants` is EXACTLY the shape of
 *     `worker_skill_reach_idx` (skill_id, partial on wants, INCLUDE worker_id +
 *     months_bucketed) — an index-only scan.
 *   * `ON CONFLICT DO UPDATE` makes a re-run idempotent AND self-correcting: a worker
 *     whose tier changed is updated in place, not duplicated.
 *
 * STALE ROWS are deleted per posting: a worker who no longer qualifies against the STORED
 * set (skill removed, `wants` turned off) is removed in the same transaction as the insert,
 * so the reach set never over-claims. This is worker-side churn, not a narrowing of the
 * posting's reach set — the set itself is never touched — and it is scoped to the posting.
 *
 * CONCURRENCY: on `--apply` the posting row is re-read `FOR UPDATE` inside the posting's
 * transaction, so a concurrent API publish/edit or expiry sweep that rewrites
 * `reach_skill_ids` is serialized with the rebuild instead of being overwritten by a set
 * read before it committed.
 *
 * DRY-RUN IS THE DEFAULT; `--apply` writes. `--job-posting-id=<uuid>` rebuilds one posting,
 * and only if it is live (`open` or `paused`).
 *
 * PRIVACY: worker ids + skill ids + integers. No PII is read, written, or logged.
 * INVARIANT #4: pure set membership from a deterministic rule; no LLM involved.
 *
 *   pnpm db:materialize:reach                 # dry run (per-posting reach counts)
 *   pnpm db:materialize:reach --apply         # write
 *   pnpm db:materialize:reach --apply --job-posting-id=<uuid>
 */
import { asc, eq, sql as dsql } from "drizzle-orm";

import { createDbClient, type Database } from "./client";
import { jobPostings } from "./schema";
import {
  argValue,
  asStringArray,
  parseCommonCli,
  printCounts,
  printFooter,
  printHeader,
} from "./match-v1-cli";

const NAME = "materialize:reach";

/** Statuses a posting may hold for D5 to touch its `job_reach` rows. */
export const LIVE_POSTING_STATUSES = ["open", "paused"] as const;

/** Why a posting's stored reach set was not materialized. */
export type ReachSkipReason =
  | "not_live"
  | "no_match_skill_ids"
  | "empty_reach_skill_ids"
  | "reach_missing_match_skill_ids";

/** The skill sets D5 reads from one posting row. */
export interface StoredSkillSets {
  matchSkillIds: readonly string[];
  reachSkillIds: readonly string[];
}

export type PostingReachOutcome =
  | {
      kind: "skipped";
      jobPostingId: string;
      reason: ReachSkipReason;
      /** For `reach_missing_match_skill_ids`: the posted ids the stored set lacks. */
      missingMatchSkillIds: string[];
    }
  | {
      kind: "materialized";
      jobPostingId: string;
      /** Distinct workers the stored set reaches (rows the upsert covers). */
      reachableWorkers: number;
      /** Rows that did not exist before (dry run: would be inserted). */
      rowsInserted: number;
      /** Existing rows refreshed in place (dry run: would be upserted). */
      rowsUpdated: number;
      /** Rows for workers who no longer qualify (dry run: would be deleted). */
      rowsDeleted: number;
    };

export interface MaterializeOptions {
  apply: boolean;
}

/**
 * Pure gate: may this posting's stored reach set be materialized as-is? `null` = yes.
 * Never repairs the set — a failing posting is skipped and worklisted (#1904 Q2).
 */
export function storedReachProblem(
  sets: StoredSkillSets,
): { reason: ReachSkipReason; missingMatchSkillIds: string[] } | null {
  if (sets.matchSkillIds.length === 0) {
    return { reason: "no_match_skill_ids", missingMatchSkillIds: [] };
  }
  if (sets.reachSkillIds.length === 0) {
    return { reason: "empty_reach_skill_ids", missingMatchSkillIds: [] };
  }
  const reach = new Set(sets.reachSkillIds);
  const missing = sets.matchSkillIds.filter((id) => !reach.has(id));
  if (missing.length > 0) {
    return { reason: "reach_missing_match_skill_ids", missingMatchSkillIds: missing };
  }
  return null;
}

function isLiveStatus(status: string): boolean {
  return (LIVE_POSTING_STATUSES as readonly string[]).includes(status);
}

type Executor = Pick<Database, "execute">;

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : [];
}

/** Read one posting's status + stored skill sets; `FOR UPDATE` when about to write. */
async function readPosting(
  exec: Executor,
  jobPostingId: string,
  lock: boolean,
): Promise<{ status: string; sets: StoredSkillSets } | null> {
  const rows = rowsOf<{ status: string; match_skill_ids: unknown; reach_skill_ids: unknown }>(
    await exec.execute(dsql`
      SELECT status, match_skill_ids, reach_skill_ids
      FROM job_postings
      WHERE id = ${jobPostingId}::uuid
      ${lock ? dsql`FOR UPDATE` : dsql``}
    `),
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    status: row.status,
    sets: {
      matchSkillIds: asStringArray(row.match_skill_ids),
      reachSkillIds: asStringArray(row.reach_skill_ids),
    },
  };
}

function skipped(
  jobPostingId: string,
  reason: ReachSkipReason,
  missingMatchSkillIds: string[] = [],
): PostingReachOutcome {
  return { kind: "skipped", jobPostingId, reason, missingMatchSkillIds };
}

/**
 * Materialize ONE posting's `job_reach` rows from its STORED `reach_skill_ids`.
 *
 * Dry run: reads only, and reports what `--apply` would insert / refresh / delete.
 * Apply: one transaction — lock the posting row, re-check it, upsert, delete stale.
 * Never writes `job_postings`.
 */
export async function materializePostingReach(
  db: Database,
  jobPostingId: string,
  opts: MaterializeOptions,
): Promise<PostingReachOutcome> {
  if (!opts.apply) {
    const posting = await readPosting(db, jobPostingId, false);
    if (posting === null || !isLiveStatus(posting.status)) return skipped(jobPostingId, "not_live");
    const problem = storedReachProblem(posting.sets);
    if (problem !== null) {
      return skipped(jobPostingId, problem.reason, problem.missingMatchSkillIds);
    }
    return countPlanned(db, jobPostingId, posting.sets.reachSkillIds);
  }

  return db.transaction(async (tx) => {
    const posting = await readPosting(tx, jobPostingId, true);
    if (posting === null || !isLiveStatus(posting.status)) return skipped(jobPostingId, "not_live");
    const problem = storedReachProblem(posting.sets);
    if (problem !== null) {
      return skipped(jobPostingId, problem.reason, problem.missingMatchSkillIds);
    }

    // ⚠️ ARRAYS MUST GO THROUGH `dsql.param()`. Drizzle's `sql` template expands a bare
    // JS array into a comma-separated list of placeholders — `($2, $3)` — which is a
    // RECORD, so `${posted}::text[]` fails at runtime with
    //   42846: cannot cast type record to text[]
    // `dsql.param(x)` binds the array as ONE parameter, which postgres.js serializes as a
    // real Postgres array. (Verified against a live Postgres 18 — the bare form errors,
    // the param form works.) Do not "simplify" these back to `${posted}`.
    const posted = dsql.param([...posting.sets.matchSkillIds]);
    const reach = dsql.param([...posting.sets.reachSkillIds]);

    // ── THE ③ STATEMENT ────────────────────────────────────────────────────
    // `xmax = 0` is true only for a freshly inserted tuple, so one statement reports
    // inserted vs refreshed without a second probe.
    const upserted = rowsOf<{ inserted: boolean }>(
      await tx.execute(dsql`
        INSERT INTO job_reach (job_posting_id, worker_id, match_tier, matched_skill_id)
        SELECT ${jobPostingId}::uuid,
               ws.worker_id,
               MIN(CASE WHEN ws.skill_id = ANY(${posted}::text[]) THEN 1 ELSE 2 END),
               (ARRAY_AGG(ws.skill_id ORDER BY (ws.skill_id = ANY(${posted}::text[])) DESC,
                                               ws.months_bucketed DESC))[1]
        FROM worker_skill ws
        WHERE ws.skill_id = ANY(${reach}::text[]) AND ws.wants
        GROUP BY ws.worker_id
        ON CONFLICT (job_posting_id, worker_id) DO UPDATE
          SET match_tier       = EXCLUDED.match_tier,
              matched_skill_id = EXCLUDED.matched_skill_id,
              computed_at      = now()
        RETURNING (xmax = 0) AS inserted
      `),
    );
    const rowsInserted = upserted.filter((r) => r.inserted).length;

    // Stale: reached before, not reachable through the STORED set now. Scoped to this posting.
    const removed = rowsOf<unknown>(
      await tx.execute(dsql`
        DELETE FROM job_reach jr
        WHERE jr.job_posting_id = ${jobPostingId}::uuid
          AND NOT EXISTS (
            SELECT 1 FROM worker_skill ws
            WHERE ws.worker_id = jr.worker_id
              AND ws.skill_id = ANY(${reach}::text[])
              AND ws.wants
          )
        RETURNING 1
      `),
    );

    return {
      kind: "materialized",
      jobPostingId,
      reachableWorkers: upserted.length,
      rowsInserted,
      rowsUpdated: upserted.length - rowsInserted,
      rowsDeleted: removed.length,
    };
  });
}

/** Dry-run counts — the same predicates the apply statements use, so it measures the real path. */
async function countPlanned(
  db: Database,
  jobPostingId: string,
  reachSkillIds: readonly string[],
): Promise<PostingReachOutcome> {
  const reach = dsql.param([...reachSkillIds]);
  const rows = rowsOf<{ reachable: number; new_rows: number; stale: number }>(
    await db.execute(dsql`
      WITH reachable AS (
        SELECT DISTINCT ws.worker_id
        FROM worker_skill ws
        WHERE ws.skill_id = ANY(${reach}::text[]) AND ws.wants
      )
      SELECT
        (SELECT count(*) FROM reachable)::int AS reachable,
        (SELECT count(*) FROM reachable r
          WHERE NOT EXISTS (
            SELECT 1 FROM job_reach jr
            WHERE jr.job_posting_id = ${jobPostingId}::uuid AND jr.worker_id = r.worker_id
          ))::int AS new_rows,
        (SELECT count(*) FROM job_reach jr
          WHERE jr.job_posting_id = ${jobPostingId}::uuid
            AND NOT EXISTS (SELECT 1 FROM reachable r WHERE r.worker_id = jr.worker_id))::int AS stale
    `),
  );
  const { reachable = 0, new_rows = 0, stale = 0 } = rows[0] ?? {};
  return {
    kind: "materialized",
    jobPostingId,
    reachableWorkers: reachable,
    rowsInserted: new_rows,
    rowsUpdated: reachable - new_rows,
    rowsDeleted: stale,
  };
}

/** Run-level totals plus the two operator worklists. Ids + integers only. */
export interface MaterializeRunSummary {
  postingsProcessed: number;
  postingsMaterialized: number;
  rowsInserted: number;
  rowsUpdated: number;
  rowsDeleted: number;
  /** Postings skipped by the stored-set gate — fix through the API, then re-run. */
  skipped: Extract<PostingReachOutcome, { kind: "skipped" }>[];
  /** Materialized postings that reach nobody. */
  zeroReachIds: string[];
}

/**
 * The posting ids a run covers. Default: every `open` posting. With `onlyPostingId`: that
 * posting, only when it is live (`open`/`paused`) — never a draft, closed or expired one.
 */
export async function selectPostingIds(
  db: Database,
  onlyPostingId: string | undefined,
): Promise<string[]> {
  const rows = await db
    .select({ id: jobPostings.id, status: jobPostings.status })
    .from(jobPostings)
    .where(
      onlyPostingId !== undefined
        ? eq(jobPostings.id, onlyPostingId)
        : eq(jobPostings.status, "open"),
    )
    .orderBy(asc(jobPostings.id));
  return rows.filter((r) => isLiveStatus(r.status)).map((r) => r.id);
}

/** Materialize every selected posting, one transaction each. */
export async function runMaterializeJobReach(
  db: Database,
  opts: MaterializeOptions & { onlyPostingId?: string },
): Promise<MaterializeRunSummary> {
  const ids = await selectPostingIds(db, opts.onlyPostingId);
  const summary: MaterializeRunSummary = {
    postingsProcessed: ids.length,
    postingsMaterialized: 0,
    rowsInserted: 0,
    rowsUpdated: 0,
    rowsDeleted: 0,
    skipped: [],
    zeroReachIds: [],
  };
  for (const id of ids) {
    const outcome = await materializePostingReach(db, id, { apply: opts.apply });
    if (outcome.kind === "skipped") {
      summary.skipped.push(outcome);
      continue;
    }
    summary.postingsMaterialized += 1;
    summary.rowsInserted += outcome.rowsInserted;
    summary.rowsUpdated += outcome.rowsUpdated;
    summary.rowsDeleted += outcome.rowsDeleted;
    if (outcome.reachableWorkers === 0) summary.zeroReachIds.push(id);
  }
  return summary;
}

const WORKLIST_LIMIT = 50;

function printWorklist(title: string, lines: readonly string[]): void {
  if (lines.length === 0) return;
  console.log(`[${NAME}] ${title}`);
  for (const line of lines.slice(0, WORKLIST_LIMIT)) console.log(`  ${line}`);
  if (lines.length > WORKLIST_LIMIT) console.log(`  … and ${lines.length - WORKLIST_LIMIT} more`);
}

async function main(): Promise<void> {
  const opts = parseCommonCli(NAME);
  printHeader(NAME, opts);

  const onlyPostingId = argValue("job-posting-id");
  if (onlyPostingId !== undefined && !/^[0-9a-f-]{36}$/i.test(onlyPostingId)) {
    throw new Error(`[${NAME}] --job-posting-id must be a uuid`);
  }

  const { db, sql } = createDbClient(opts.databaseUrl, { max: 1 });
  try {
    const summary = await runMaterializeJobReach(db, { apply: opts.apply, onlyPostingId });
    if (onlyPostingId !== undefined && summary.postingsProcessed === 0) {
      throw new Error(
        `[${NAME}] --job-posting-id=${onlyPostingId} is not a live (open/paused) posting — nothing to do`,
      );
    }

    printCounts(NAME, {
      "postings processed": summary.postingsProcessed,
      "postings materialized": summary.postingsMaterialized,
      "postings SKIPPED (stored set)": summary.skipped.length,
      "job_reach rows inserted": summary.rowsInserted,
      "job_reach rows refreshed": summary.rowsUpdated,
      "job_reach rows deleted (stale)": summary.rowsDeleted,
      "postings reaching ZERO workers": summary.zeroReachIds.length,
    });

    printWorklist(
      "SKIPPED postings — stored reach set not materializable; fix via the API (republish/edit), then re-run:",
      summary.skipped.map(
        (s) =>
          `${s.jobPostingId}  ${s.reason}` +
          (s.missingMatchSkillIds.length > 0
            ? `  missing=${s.missingMatchSkillIds.join(",")}`
            : ""),
      ),
    );
    printWorklist(
      "ZERO-REACH postings (they will show to nobody — verify this is intended):",
      summary.zeroReachIds,
    );

    printFooter(NAME, opts, summary.rowsInserted + summary.rowsUpdated + summary.rowsDeleted);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (require.main === module) {
  main().catch((err) => {
    // nosemgrep: javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring -- `NAME` is a module-level string constant declared in this file, never input. This is the CLI's terminal error line; no user- or worker-supplied value reaches the template.
    console.error(`[${NAME}] failed:`, err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
