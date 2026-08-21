/**
 * DE-COLLIDE — apply the committed duplicate-election decisions to production.
 *
 * ===========================================================================
 * WHAT IT DOES, AND THE ONE THING IT WILL NOT DO
 * ===========================================================================
 * For every row named in `data/taxonomy/decollided-aliases.json` it sets exactly one column:
 *
 *     UPDATE skill_alias SET embedding = NULL WHERE id = $1
 *
 * The row survives. Its id survives (ids are never reused — SG-5). Its text survives. Its
 * `embedding_model` and `embedded_at` survive too, and that is deliberate: they are the true
 * historical record that this row WAS embedded, with which model and when, and we paid for it.
 * Only retrievability changes, because `embedding IS NOT NULL` is what Path B filters on.
 *
 * It NEVER deletes a row (CLAUDE.md §10) and never touches `skill`.
 *
 * ===========================================================================
 * WHY A SEPARATE RUNNER
 * ===========================================================================
 * Duplicate election is a taxonomy decision with a reviewer, not a side effect of embedding.
 * Folding it into `db:embed:skills` would mean the runner that ADDS vectors can also silently
 * remove them, and the two need different authorisation conversations.
 *
 * REVERSIBLE: delete the entry from the JSON file and re-run `db:embed:skills`. The row is
 * still there, still `embedding IS NULL`, and no longer excluded — so it is re-embedded.
 *
 * ===========================================================================
 * SAFETY
 * ===========================================================================
 * `enforceOpsGuard` classifies the target and owns the refusal; a production write needs
 * `--i-am-authorised-to-write-to-production` AND `OPS_ALLOW_PRODUCTION=decollide:aliases`.
 * DRY RUN IS THE DEFAULT — `--run` is required to write, so a bare invocation cannot mutate.
 *
 * Every mutation is preceded by a VERIFICATION of the row as it actually exists: the runner
 * refuses if the id is missing, if its `skill_id`/`text` do not match the file, or if the
 * winner named in the file does not itself still hold that text. A stale exclusion file
 * pointed at the wrong rows must stop the run, not quietly null four arbitrary vectors.
 *
 *   pnpm db:decollide:aliases                                    # dry run (default)
 *   pnpm db:decollide:aliases --run --i-am-authorised-to-write-to-production
 */
import { sql as dsql } from "drizzle-orm";
import { config } from "dotenv";

import { ALIAS_EXCLUSIONS_PATH, loadAliasExclusions, type AliasExclusion } from "./alias-exclusions";
import { createDbClient } from "./client";
import { enforceOpsGuard } from "./ops-guard";

config({ path: "../../.env" });
config();

const SCRIPT = "decollide:aliases";

/**
 * `IN (…)` from a JS array.
 *
 * Not `= ANY($1)`: interpolating an array into a drizzle `sql` tag renders a TUPLE
 * `($1, $2, …)`, and `ANY(tuple)` is a syntax error rather than a wrong answer — which is the
 * good failure, but only once. This renders the list the way Postgres expects it.
 */
const inList = (xs: readonly string[]) =>
  dsql`(${dsql.join(xs.map((x) => dsql`${x}`), dsql`, `)})`;

interface LiveAliasRow {
  readonly id: string;
  readonly skill_id: string;
  readonly text: string;
  readonly domain_id: string | null;
  readonly embedded: boolean;
}

/**
 * Check ONE exclusion against the database as it is right now.
 *
 * Returns the reasons it must not be applied. Empty = safe. Pure over its inputs so the whole
 * refusal matrix is testable without a database — which matters, because this is the function
 * that stands between a stale JSON file and four NULLed vectors in production.
 */
export function verifyExclusion(
  x: AliasExclusion,
  live: LiveAliasRow | undefined,
  winnerHoldsText: boolean,
): string[] {
  const problems: string[] = [];
  if (live === undefined) {
    problems.push(`alias_id ${x.alias_id} does not exist`);
    return problems;
  }
  if (live.skill_id !== x.skill_id) {
    problems.push(`skill_id mismatch: file says ${x.skill_id}, row says ${live.skill_id}`);
  }
  if (live.text !== x.text) {
    problems.push(`text mismatch: file says ${JSON.stringify(x.text)}, row says ${JSON.stringify(live.text)}`);
  }
  if (x.domain_id !== null && live.domain_id !== x.domain_id) {
    problems.push(`domain_id mismatch: file says ${x.domain_id}, row says ${live.domain_id ?? "NULL"}`);
  }
  // The point of election is that the text SURVIVES on the winner. If the winner does not
  // actually carry it, applying this would delete the concept from retrieval altogether —
  // the opposite of the intent, and invisible afterwards.
  if (x.winner_skill_id !== null && !winnerHoldsText) {
    problems.push(
      `winner ${x.winner_skill_id} does not hold an embedded alias ${JSON.stringify(x.text)} — ` +
        `applying this would remove the text from retrieval entirely`,
    );
  }
  return problems;
}

async function main(): Promise<void> {
  const run = process.argv.includes("--run");
  const { connectionString: url } = enforceOpsGuard({
    script: SCRIPT,
    connectionString: process.env.DATABASE_URL,
    mutating: run,
  });

  const exclusions = loadAliasExclusions();
  console.log(`[${SCRIPT}] ${run ? "RUN (writes)" : "DRY RUN (default — pass --run to write)"}`);
  console.log(`  source                   = ${ALIAS_EXCLUSIONS_PATH}`);
  console.log(`  exclusions declared      = ${exclusions.length}`);
  if (exclusions.length === 0) {
    console.log(`  nothing to do.`);
    return;
  }

  const { db, sql } = createDbClient(url, { max: 1 });
  try {
    const ids = exclusions.map((x) => x.alias_id);
    const live = (await db.execute(
      dsql`SELECT sa.id::text AS id, sa.skill_id, sa.text, sa.domain_id,
                  (sa.embedding IS NOT NULL) AS embedded
           FROM skill_alias sa WHERE sa.id::text IN ${inList(ids)}`,
    )) as unknown as LiveAliasRow[];
    const byId = new Map(live.map((r) => [r.id, r]));

    // Does each winner still hold the contested text, WITH a vector? Asked of the database in
    // one statement rather than assumed from the file.
    const winners = exclusions.filter((x) => x.winner_skill_id !== null);
    const held = new Set<string>();
    if (winners.length > 0) {
      const rows = (await db.execute(
        dsql`SELECT sa.skill_id, sa.text FROM skill_alias sa
             WHERE sa.embedding IS NOT NULL
               AND sa.skill_id IN ${inList(winners.map((x) => x.winner_skill_id as string))}
               AND lower(sa.text) IN ${inList(winners.map((x) => x.text.toLowerCase()))}`,
      )) as unknown as { skill_id: string; text: string }[];
      for (const r of rows) held.add(`${r.skill_id}\u001f${r.text.toLowerCase()}`);
    }

    console.log("");
    const problems: string[] = [];
    const toNull: AliasExclusion[] = [];
    for (const x of exclusions) {
      const row = byId.get(x.alias_id);
      const winnerHolds =
        x.winner_skill_id === null || held.has(`${x.winner_skill_id}\u001f${x.text.toLowerCase()}`);
      const p = verifyExclusion(x, row, winnerHolds);
      const state = row === undefined ? "MISSING" : row.embedded ? "embedded" : "already NULL";
      console.log(`  ${x.alias_id}  ${x.skill_id.padEnd(24)} ${JSON.stringify(x.text)}`);
      console.log(`      before = ${state}   winner = ${x.winner_skill_id ?? "(none — text retired)"}`);
      if (p.length > 0) {
        for (const m of p) console.log(`      REFUSE: ${m}`);
        problems.push(...p);
      } else if (row?.embedded === true) {
        toNull.push(x);
      }
    }

    if (problems.length > 0) {
      console.error(`\n[${SCRIPT}] REFUSING — ${problems.length} verification failure(s). Nothing written.`);
      process.exitCode = 1;
      return;
    }

    console.log(`\n  rows to NULL             = ${toNull.length}`);
    console.log(`  rows already NULL        = ${exclusions.length - toNull.length}`);

    if (!run) {
      console.log(`\n  DRY RUN — nothing written. Re-run with --run to apply.`);
      return;
    }
    if (toNull.length === 0) {
      console.log(`\n  nothing to write — production already matches the file.`);
      return;
    }

    // One statement, so the four rows move together or not at all.
    const updated = (await db.execute(
      dsql`UPDATE skill_alias SET embedding = NULL
           WHERE id::text IN ${inList(toNull.map((x) => x.alias_id))} AND embedding IS NOT NULL
           RETURNING id::text AS id`,
    )) as unknown as { id: string }[];
    console.log(`\n  UPDATED                  = ${updated.length} row(s)`);

    const after = (await db.execute(
      dsql`SELECT sa.id::text AS id, (sa.embedding IS NOT NULL) AS embedded
           FROM skill_alias sa WHERE sa.id::text IN ${inList(ids)}`,
    )) as unknown as { id: string; embedded: boolean }[];
    const stillEmbedded = after.filter((r) => r.embedded);
    for (const r of after) console.log(`      after  ${r.id}  embedded=${r.embedded}`);
    if (stillEmbedded.length > 0) {
      console.error(`\n[${SCRIPT}] POST-CHECK FAILED — ${stillEmbedded.length} row(s) still embedded.`);
      process.exitCode = 1;
      return;
    }
    console.log(`\n[${SCRIPT}] done — all ${exclusions.length} excluded alias(es) are out of retrieval.`);
  } finally {
    await sql.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
