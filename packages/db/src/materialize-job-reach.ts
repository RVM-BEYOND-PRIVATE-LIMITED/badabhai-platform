/**
 * D5 — Matching V1 reach materialization (migration 0055). The doc's step ③.
 *
 * For every OPEN `job_postings` row, computes the set of workers the posting can reach
 * and writes it into `job_reach`. Run once after the D2/D3/D4 backfills; thereafter the
 * API materializes on publish/edit and this script is the repair/rebuild tool.
 *
 * THE STATEMENT (per posting — one INSERT..SELECT, no app-side loop over workers):
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
 * STALE ROWS are deleted per posting: a worker who no longer qualifies (skill removed,
 * `wants` turned off, posting's skills edited) is removed in the same transaction as the
 * insert, so the reach set never over-claims. The delete is scoped to the posting.
 *
 * REACH_SKILL_IDS ARE RECOMPUTED FIRST. `$reach` is derived from the posting's
 * `match_skill_ids` ∪ `skill_related`, and if the stored `reach_skill_ids` differs it is
 * rewritten. That keeps the GIN reconciliation index true even if a posting was created
 * by a path that forgot to expand — and it makes this script the single authority on
 * what the reach set means.
 *
 * DRY-RUN IS THE DEFAULT; `--apply` writes. `--job-posting-id=<uuid>` rebuilds one.
 *
 * PRIVACY: worker ids + skill ids + integers. No PII is read, written, or logged.
 * INVARIANT #4: pure set membership from a deterministic rule; no LLM involved.
 *
 *   pnpm db:materialize:reach                 # dry run (per-posting reach counts)
 *   pnpm db:materialize:reach --apply         # write
 *   pnpm db:materialize:reach --apply --job-posting-id=<uuid>
 */
import { eq, sql as dsql } from "drizzle-orm";

import { createDbClient } from "./client";
import { jobPostings } from "./schema";
import { expandReachSkillIds } from "./match-v1-derive";
import {
  argValue,
  asStringArray,
  parseCommonCli,
  printCounts,
  printFooter,
  printHeader,
} from "./match-v1-cli";

const NAME = "materialize:reach";

async function main(): Promise<void> {
  const opts = parseCommonCli(NAME);
  printHeader(NAME, opts);

  const onlyPostingId = argValue("job-posting-id");
  if (onlyPostingId !== undefined && !/^[0-9a-f-]{36}$/i.test(onlyPostingId)) {
    throw new Error(`[${NAME}] --job-posting-id must be a uuid`);
  }

  const { db, sql } = createDbClient(opts.databaseUrl, { max: 1 });
  const now = new Date();
  try {
    const postings = await db
      .select({
        id: jobPostings.id,
        matchSkillIds: jobPostings.matchSkillIds,
        reachSkillIds: jobPostings.reachSkillIds,
      })
      .from(jobPostings)
      .where(onlyPostingId ? eq(jobPostings.id, onlyPostingId) : eq(jobPostings.status, "open"));

    let zeroSkillPostings = 0;
    let reachArraysRewritten = 0;
    let rowsWritten = 0;
    let rowsDeleted = 0;
    let zeroReachPostings = 0;
    const zeroReachIds: string[] = [];

    for (const p of postings) {
      const posted = asStringArray(p.matchSkillIds);
      if (posted.length === 0) {
        // No posted skills → reaches nobody. Still clear any stale rows so a posting that
        // LOST its skills stops serving to workers it no longer matches.
        zeroSkillPostings += 1;
        if (opts.apply) {
          const gone = await sql`DELETE FROM job_reach WHERE job_posting_id = ${p.id} RETURNING 1`;
          rowsDeleted += gone.length;
        }
        zeroReachPostings += 1;
        zeroReachIds.push(p.id);
        continue;
      }

      const reach = await expandReachSkillIds(db, posted);
      const storedReach = asStringArray(p.reachSkillIds);
      const reachDiffers =
        storedReach.length !== reach.length || storedReach.some((id, i) => id !== reach[i]);

      // ⚠️ ARRAYS MUST GO THROUGH `dsql.param()`. Drizzle's `sql` template expands a bare
      // JS array into a comma-separated list of placeholders — `($2, $3)` — which is a
      // RECORD, so `${posted}::text[]` fails at runtime with
      //   42846: cannot cast type record to text[]
      // `dsql.param(x)` binds the array as ONE parameter, which postgres.js serializes as a
      // real Postgres array. (Verified against a live Postgres 18 — the bare form errors,
      // the param form works.) Do not "simplify" these back to `${posted}`.
      const postedParam = dsql.param(posted);
      const reachParam = dsql.param(reach);

      if (!opts.apply) {
        // Count only — the same WHERE the real statement uses, so the dry run measures
        // the real index path.
        const counted = await sql<{ n: number }[]>`
          SELECT count(DISTINCT ws.worker_id)::int AS n
          FROM worker_skill ws
          WHERE ws.skill_id = ANY(${reach}::text[]) AND ws.wants
        `;
        const n = counted[0]?.n ?? 0;
        rowsWritten += n;
        if (reachDiffers) reachArraysRewritten += 1;
        if (n === 0) {
          zeroReachPostings += 1;
          zeroReachIds.push(p.id);
        }
        continue;
      }

      await db.transaction(async (tx) => {
        if (reachDiffers) {
          await tx
            .update(jobPostings)
            .set({ reachSkillIds: reach, updatedAt: now })
            .where(eq(jobPostings.id, p.id));
          reachArraysRewritten += 1;
        }

        // ── THE ③ STATEMENT ────────────────────────────────────────────────
        const inserted = await tx.execute(dsql`
          INSERT INTO job_reach (job_posting_id, worker_id, match_tier, matched_skill_id)
          SELECT ${p.id}::uuid,
                 ws.worker_id,
                 MIN(CASE WHEN ws.skill_id = ANY(${postedParam}::text[]) THEN 1 ELSE 2 END),
                 (ARRAY_AGG(ws.skill_id ORDER BY (ws.skill_id = ANY(${postedParam}::text[])) DESC,
                                                 ws.months_bucketed DESC))[1]
          FROM worker_skill ws
          WHERE ws.skill_id = ANY(${reachParam}::text[]) AND ws.wants
          GROUP BY ws.worker_id
          ON CONFLICT (job_posting_id, worker_id) DO UPDATE
            SET match_tier       = EXCLUDED.match_tier,
                matched_skill_id = EXCLUDED.matched_skill_id,
                computed_at      = now()
          RETURNING 1
        `);
        const n = Array.isArray(inserted) ? inserted.length : 0;
        rowsWritten += n;

        // Stale: reached before, not reachable now. Scoped to this posting.
        const removed = await tx.execute(dsql`
          DELETE FROM job_reach jr
          WHERE jr.job_posting_id = ${p.id}::uuid
            AND NOT EXISTS (
              SELECT 1 FROM worker_skill ws
              WHERE ws.worker_id = jr.worker_id
                AND ws.skill_id = ANY(${reachParam}::text[])
                AND ws.wants
            )
          RETURNING 1
        `);
        rowsDeleted += Array.isArray(removed) ? removed.length : 0;

        if (n === 0) {
          zeroReachPostings += 1;
          zeroReachIds.push(p.id);
        }
      });
    }

    printCounts(NAME, {
      "postings processed": postings.length,
      "postings with 0 match skills": zeroSkillPostings,
      "reach_skill_ids rewritten": reachArraysRewritten,
      "job_reach rows written": rowsWritten,
      "job_reach rows deleted (stale)": rowsDeleted,
      "postings reaching ZERO workers": zeroReachPostings,
    });

    if (zeroReachIds.length > 0) {
      console.log(
        `[${NAME}] ZERO-REACH postings (they will show to nobody — verify this is intended):`,
      );
      for (const id of zeroReachIds.slice(0, 50)) console.log(`  ${id}`);
      if (zeroReachIds.length > 50) console.log(`  … and ${zeroReachIds.length - 50} more`);
    }

    printFooter(NAME, opts, rowsWritten + rowsDeleted);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(`[${NAME}] failed:`, err instanceof Error ? err.message : err);
  process.exit(1);
});
