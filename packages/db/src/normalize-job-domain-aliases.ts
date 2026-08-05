/**
 * Job-domain alias normalizer (migration 0067) — the RETRIEVAL SURFACE builder.
 *
 *   pnpm db:normalize:aliases            # dry run, writes nothing
 *   pnpm db:normalize:aliases --apply
 *   pnpm db:normalize:aliases --apply --renormalize   # after editing particles.json
 *
 * Fills the two columns every free retrieval layer depends on:
 *
 *   `text_norm`      `normalizeOccupationText(text)` — the L0 exact key and the L2 trigram
 *                    surface. Computed HERE, in TypeScript, by the SAME function the query
 *                    path calls. That shared call is the whole design: a second normalizer
 *                    written in SQL would drift, and drift is silent — L0 simply stops
 *                    matching and every profiling turn falls through to a paid embedding.
 *
 *   `is_searchable`  may retrieval SEE this row. Three independent reasons it may not,
 *                    resolved in one set-based pass (see `recomputeSearchable`).
 *
 * RESUMABLE / IDEMPOTENT. Only `text_norm IS NULL` rows are fetched, so a completed corpus
 * re-run is a no-op. `--renormalize` is the deliberate escape hatch for a particles.json
 * edit: it NULLs `text_norm` first so every row is recomputed.
 *
 * NEVER TOUCHES `text`. `deterministicJobDomainAliasId` hashes the RAW text, and the seeder
 * inserts `ON CONFLICT (id) DO NOTHING` — so rewriting `text` would re-mint the id, leave
 * the old row in place with its paid embedding, and insert a duplicate. Normalization is
 * strictly additive to a new column.
 *
 * PRIVACY: the reference catalogue only. Every line printed is ids + counts.
 */
import { config } from "dotenv";
import { isNull, sql as dsql } from "drizzle-orm";
import { normalizeOccupationText } from "@badabhai/profiling-lexicon";

import { createDbClient } from "./client";
import {
  argFlag,
  parseCommonCli,
  printCounts,
  printFooter,
  printHeader,
} from "./match-v1-cli";
import { jobDomainAliases } from "./schema/occupation";

config({ path: "../../.env" });

const SCRIPT = "normalize:aliases";

/**
 * Recompute `is_searchable` for EVERY row in one statement.
 *
 * Deliberately set-based rather than batched: it is a whole-table property (the dedupe
 * winner of a group cannot be decided from a 500-row window that might split the group),
 * it touches ~8.7k rows on a reference table, and it must be atomic — a half-applied pass
 * could leave two winners in one group and break the unique index.
 *
 * The three reasons a row is NOT searchable, in the order they appear below:
 *
 *  1. THE DOMAIN IS NOT SELECTABLE. Bucket rows ("Craft and Related Trades Workers")
 *     organize the tree; nobody holds them as a job.
 *
 *  2. THE DOMAIN IS A SHADOWED ISCO UNIT — the F4 fix. All 436 ISCO unit groups are seeded
 *     `selectable` alongside 3,449 NCO occupations, and 370 of them have selectable NCO
 *     children. Leaving both in play makes the shortlist mix two granularities: "Welders
 *     and Flame Cutters" competes with 44 specific NCO welding occupations. The 66
 *     UNSHADOWED units stay reachable, because for those the unit group IS the leaf.
 *     `selectable` itself is untouched — it backs a CHECK constraint and existing
 *     `worker_profiles.job_domain_id` values.
 *
 *  3. THE ROW IS A DUPLICATE OF ANOTHER ALIAS IN ITS DOMAIN. 70 pairs differ only in
 *     punctuation ("Signaller (railway)" vs "Signaller, railway") and normalize to one
 *     `text_norm`. Exactly one survives as searchable; the loser KEEPS its row, its stable
 *     id and its paid embedding, and simply stops being retrievable. Nothing is deleted
 *     (CLAUDE.md §10) and `text_norm` is left filled on the loser too, so the runner's
 *     `IS NULL` resumability predicate still terminates.
 *
 * The winner is chosen deterministically: a row that already carries an embedding wins
 * (never strand paid work), then the shortest raw text (the least parenthetical form),
 * then the lowest id. `PARTITION BY` treats NULL `lang` values as equal, which is the same
 * grouping the unique index's `NULLS NOT DISTINCT` uses — the two must agree or the pass
 * would elect a winner the index still rejects.
 */
const RECOMPUTE_SEARCHABLE = dsql`
  WITH ranked AS (
    SELECT a."id",
           (
             d."selectable"
             AND d."status" = 'active'
             AND NOT (
               d."source" = 'isco08'
               AND EXISTS (
                 SELECT 1 FROM "job_domain" c
                  WHERE c."parent_job_domain_id" = d."job_domain_id"
                    AND c."selectable" AND c."status" = 'active'
               )
             )
           ) AS eligible,
           row_number() OVER (
             PARTITION BY a."job_domain_id", a."text_norm", a."lang"
             ORDER BY (a."embedding" IS NOT NULL) DESC, length(a."text") ASC, a."id" ASC
           ) AS rn
      FROM "job_domain_alias" a
      JOIN "job_domain" d ON d."job_domain_id" = a."job_domain_id"
     WHERE a."text_norm" IS NOT NULL
  )
  UPDATE "job_domain_alias" t
     SET "is_searchable" = (r.eligible AND r.rn = 1)
    FROM ranked r
   WHERE t."id" = r."id"
     AND t."is_searchable" IS DISTINCT FROM (r.eligible AND r.rn = 1)
`;

/** A row that has not been normalized yet can never be searchable. */
const CLEAR_UNNORMALIZED = dsql`
  UPDATE "job_domain_alias"
     SET "is_searchable" = false
   WHERE "text_norm" IS NULL AND "is_searchable"
`;

async function main(): Promise<void> {
  const opts = parseCommonCli(SCRIPT);
  const renormalize = argFlag("renormalize");
  printHeader(SCRIPT, opts);
  if (renormalize) {
    console.log(
      `[${SCRIPT}] --renormalize — every text_norm will be recomputed ` +
        "(use after editing @badabhai/profiling-lexicon data/particles.json).",
    );
  }

  const { db, sql } = createDbClient(opts.databaseUrl, { max: 1 });

  let normalized = 0;
  let unchanged = 0;
  let emptied = 0;
  let batches = 0;

  try {
    if (renormalize && opts.apply) {
      await db.execute(dsql`UPDATE "job_domain_alias" SET "text_norm" = NULL`);
    }

    for (;;) {
      const rows = await db
        .select({ id: jobDomainAliases.id, text: jobDomainAliases.text })
        .from(jobDomainAliases)
        .where(isNull(jobDomainAliases.textNorm))
        .orderBy(jobDomainAliases.id)
        .limit(opts.batchSize);

      if (rows.length === 0) break;
      batches += 1;

      const pairs = rows.map((r) => ({ id: r.id, norm: normalizeOccupationText(r.text) }));
      // An empty text_norm is not writable: it would make every empty row collide under
      // the unique index's NULLS NOT DISTINCT. The normalizer's own empty-guard means this
      // can only happen for an alias with NO kept characters at all, which is a corpus
      // defect worth surfacing rather than silently normalizing away.
      const writable = pairs.filter((p) => p.norm.length > 0);
      emptied += pairs.length - writable.length;

      if (!opts.apply) {
        normalized += writable.length;
        // A dry run cannot advance the `IS NULL` window, so stop after costing one batch
        // rather than looping forever over the same rows.
        console.log(
          `[${SCRIPT}] dry run — first ${rows.length} row(s) inspected; ` +
            "re-run with --apply to write and continue.",
        );
        break;
      }

      if (writable.length > 0) {
        // One multi-row UPDATE ... FROM (VALUES ...) per batch, not N statements.
        const values = dsql.join(
          writable.map((p) => dsql`(${p.id}::uuid, ${p.norm}::text)`),
          dsql`, `,
        );
        const result = await db.execute(dsql`
          UPDATE "job_domain_alias" t
             SET "text_norm" = v.norm
            FROM (VALUES ${values}) AS v(id, norm)
           WHERE t."id" = v.id
        `);
        const written = (result as unknown as { count?: number }).count ?? writable.length;
        normalized += written;
        unchanged += writable.length - written;
      }

      // PROGRESS-OR-ABORT. If a batch wrote nothing AND excluded nothing, the next fetch
      // returns the same rows — stop rather than spin. Mirrors embed-job-domain-aliases.
      if (writable.length === 0 && rows.length > 0) {
        throw new Error(
          `[${SCRIPT}] batch made no progress — ${rows.length} row(s) normalized to empty ` +
            "text. Inspect their `text` in the corpus; aborting rather than looping.",
        );
      }
    }

    let searchableChanged = 0;
    if (opts.apply) {
      await db.execute(CLEAR_UNNORMALIZED);
      const res = await db.execute(RECOMPUTE_SEARCHABLE);
      searchableChanged = (res as unknown as { count?: number }).count ?? 0;
    }

    const stats = (await db.execute(dsql`
      SELECT count(*)::int                                                   AS total,
             count(*) FILTER (WHERE "text_norm" IS NULL)::int                AS still_null,
             count(*) FILTER (WHERE "is_searchable")::int                    AS searchable
        FROM "job_domain_alias"
    `)) as unknown as Array<{ total: number; still_null: number; searchable: number }>;
    const row = stats[0] ?? { total: 0, still_null: 0, searchable: 0 };

    printCounts(SCRIPT, {
      batches,
      text_norm_written: normalized,
      text_norm_unchanged: unchanged,
      normalized_to_empty_skipped: emptied,
      is_searchable_flipped: searchableChanged,
      aliases_total: row.total,
      aliases_still_null: row.still_null,
      aliases_searchable: row.searchable,
    });

    if (emptied > 0) {
      console.log(
        `[${SCRIPT}] WARN ${emptied} alias(es) normalize to empty text and were left NULL — ` +
          "they are unreachable by retrieval. Inspect their source rows in the corpus.",
      );
    }

    printFooter(SCRIPT, opts, normalized + searchableChanged);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(`[${SCRIPT}] failed:`, err);
  process.exit(1);
});
