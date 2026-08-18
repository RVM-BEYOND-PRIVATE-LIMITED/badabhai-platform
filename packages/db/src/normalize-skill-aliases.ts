/**
 * `skill_alias` normalizer — fills `text_norm`, and NOTHING else.
 *
 *   pnpm db:normalize:skill-aliases                          # dry-run report, writes nothing
 *   pnpm db:normalize:skill-aliases --apply
 *   pnpm db:normalize:skill-aliases --apply --rollback       # full rehearsal, always rolled back
 *   pnpm db:normalize:skill-aliases --assert-predicate-safe  # exit 1 if the predicate would hide rows
 *
 * The classification logic lives in `skill-alias-normalization.ts` and is unit-tested
 * without a database. This file is transport: fetch, plan, print, optionally write.
 *
 * ── THE ONE COLUMN IT TOUCHES ──
 *
 * `text_norm`, on rows where it is NULL. Never `text`, `skill_id`, `lang`, `source`,
 * `embedding`, `embedding_model`, `embedded_at` or `is_searchable`. Two reasons that list
 * is a hard rule rather than a preference:
 *
 *   - `deterministicSkillAliasId` hashes the RAW text and the seeder inserts
 *     `ON CONFLICT (id) DO NOTHING`, so rewriting `text` re-mints the id, strands the old
 *     row with its paid embedding and inserts a duplicate. Normalization is strictly
 *     additive to a new column. (Same reasoning as `normalize-job-domain-aliases.ts:23`.)
 *
 *   - `is_searchable` is DUPLICATE ELECTION, and electing here would silently decide
 *     whether the active catalogue is retrievable at all. It is a separate gated step and
 *     is only ever exercised under `--rollback`, as a rehearsal that cannot commit.
 *
 * IDEMPOTENT / RESUMABLE. Only `text_norm IS NULL` rows are fetched, so a completed run is
 * a no-op. There is no `--renormalize` counterpart to the domain runner: this corpus has
 * never been normalized, so there is nothing to re-normalize, and offering the flag before
 * anyone needs it would offer a way to move the L0 keys of 197 already-searchable rows.
 *
 * PRIVACY: the reference catalogue only. Every line printed is ids + counts.
 */
import { config } from "dotenv";
import { sql as dsql } from "drizzle-orm";

import { createDbClient } from "./client";
import {
  argFlag,
  argValue,
  parseCommonCli,
  printCounts,
  printFooter,
  printHeader,
} from "./match-v1-cli";
import {
  planSkillAliasNormalization,
  retrievalPredicateReadiness,
  type SkillAliasNormalizationPlan,
  type SkillAliasNormalizationRow,
} from "./skill-alias-normalization";

config({ path: "../../.env" });

const SCRIPT = "normalize:skill-aliases";

/**
 * Every row plus its skill's status — the planner's input, and the only read this script
 * makes. `text` is fetched because it is the normalizer's input; it is never printed.
 */
const FETCH_ROWS = dsql`
  SELECT sa."id"::text          AS id,
         sa."skill_id"          AS skill_id,
         sa."text"              AS text,
         sa."text_norm"         AS text_norm,
         sa."lang"              AS lang,
         s."status"             AS skill_status,
         sa."is_searchable"     AS is_searchable,
         (sa."embedding" IS NOT NULL) AS has_embedding
    FROM "skill_alias" sa
    JOIN "skill" s ON s."skill_id" = sa."skill_id"
   ORDER BY sa."id"
`;

/**
 * REHEARSAL ONLY — elect one searchable representative per `(skill_id, text_norm, lang)`.
 *
 * Reachable exclusively from the `--rollback` branch below, inside a transaction that is
 * guaranteed to roll back. It exists to answer one question with the real index rather
 * than a simulation: once `text_norm` is filled, does electing the active catalogue
 * actually satisfy `skill_alias_skill_norm_lang_uq`, or does it collide?
 *
 * Mirrors the domain runner's ranked CTE minus reasons 1 and 2 (bucket rows and ISCO
 * shadowing), which schema/skill.ts states do not apply to skills. The winner is chosen
 * deterministically: a row carrying an embedding wins (never strand paid work), then the
 * shortest raw text, then the lowest id. `PARTITION BY` treats NULL `lang` as equal, which
 * is the grouping the index's `NULLS NOT DISTINCT` uses — the two must agree or the pass
 * would elect a winner the index still rejects.
 */
const REHEARSE_ELECT_SEARCHABLE = dsql`
  WITH ranked AS (
    SELECT a."id",
           row_number() OVER (
             PARTITION BY a."skill_id", a."text_norm", a."lang"
             ORDER BY (a."embedding" IS NOT NULL) DESC, length(a."text") ASC, a."id" ASC
           ) AS rn
      FROM "skill_alias" a
     WHERE a."text_norm" IS NOT NULL
  )
  UPDATE "skill_alias" t
     SET "is_searchable" = (r.rn = 1)
    FROM ranked r
   WHERE t."id" = r."id"
     AND t."is_searchable" IS DISTINCT FROM (r.rn = 1)
`;

interface RawRow {
  id: string;
  skill_id: string;
  text: string;
  text_norm: string | null;
  lang: string | null;
  skill_status: string;
  is_searchable: boolean;
  has_embedding: boolean;
}

function toPlannerRows(raw: readonly RawRow[]): SkillAliasNormalizationRow[] {
  return raw.map((r) => ({
    id: r.id,
    skillId: r.skill_id,
    text: r.text,
    textNorm: r.text_norm,
    lang: r.lang,
    skillStatus: r.skill_status,
    isSearchable: r.is_searchable,
    hasEmbedding: r.has_embedding,
  }));
}

/** The report the operator reads before deciding to `--apply`. Counts and ids only. */
function printPlan(plan: SkillAliasNormalizationPlan, rows: readonly SkillAliasNormalizationRow[]): void {
  printCounts(SCRIPT, {
    skill_alias_total: plan.totalRows,
    text_norm_already_populated: plan.alreadyNormalized,
    text_norm_missing: plan.missingTextNorm,
    text_norm_newly_derivable: plan.writes.length,
    normalizes_to_empty_unwritable: plan.normalizesToEmpty.length,
    drift_populated_would_change: plan.drift.length,
    unique_key_conflicts: plan.uniqueKeyConflicts.length,
    cross_skill_collisions: plan.crossSkillCollisions.length,
  });

  console.log(`[${SCRIPT}] by skill.status:`);
  for (const [status, b] of Object.entries(plan.byStatus).sort(([a], [c]) => a.localeCompare(c))) {
    console.log(
      `  ${status.padEnd(14)} rows=${b.rows} normalized=${b.alreadyNormalized} ` +
        `newly_derivable=${b.newlyDerivable} empty=${b.normalizesToEmpty} ` +
        `embedded=${b.embedded} searchable=${b.searchable}`,
    );
  }

  // Drift is never written, so it must be visible or it is invisible forever.
  for (const d of plan.drift) {
    console.log(`[${SCRIPT}] DRIFT ${d.id} (${d.skillId}) stored != recomputed — left untouched.`);
  }
  for (const c of plan.uniqueKeyConflicts) {
    console.log(
      `[${SCRIPT}] UNIQUE-KEY ${c.skillId} lang=${c.lang ?? "NULL"} — ${c.ids.length} row(s) share one ` +
        `text_norm, ${c.searchableIds.length} currently searchable. Election keeps exactly one.`,
    );
  }
  for (const c of plan.crossSkillCollisions) {
    console.log(
      `[${SCRIPT}] CROSS-SKILL ${c.skillIds.join(", ")} share one text_norm (lang=${c.lang ?? "NULL"}) — ` +
        "legal under the index, but L0 has nothing to rank them. Taxonomy decision.",
    );
  }
  if (plan.normalizesToEmpty.length > 0) {
    console.log(
      `[${SCRIPT}] WARN ${plan.normalizesToEmpty.length} alias(es) normalize to empty text and were ` +
        "left NULL — they stay unreachable by L0. Inspect their source rows in the corpus.",
    );
  }

  printReadiness(rows);
}

/**
 * The retrieval-predicate gate, printed on every run so it cannot be forgotten between
 * the normalizer landing and someone reaching for `AND sa.is_searchable`.
 */
function printReadiness(
  rows: readonly SkillAliasNormalizationRow[],
  intentionallyDemoted: readonly string[] = [],
): void {
  const r = retrievalPredicateReadiness(rows, { intentionallyDemoted });
  console.log(
    `[${SCRIPT}] retrieval-predicate readiness: ${r.safe ? "SAFE" : "NOT SAFE"} — active embedded ` +
      `aliases hidden by: not_normalized=${r.hiddenByMissingNormalization.length} ` +
      `not_elected=${r.hiddenWithoutElection.length} ` +
      `losing_duplicate=${r.hiddenAsLosingDuplicate.length} decision=${r.hiddenByDecision.length}`,
  );
  if (!r.safe) {
    console.log(
      `[${SCRIPT}] => \`AND sa.is_searchable\` must NOT be added to any skill-alias retrieval path ` +
        "yet. The first two categories are hidden by omission, not by a decision.",
    );
  }
}

/** Write `text_norm` for the planned rows, in batches. Returns rows written. */
async function writeTextNorm(
  db: ReturnType<typeof createDbClient>["db"],
  plan: SkillAliasNormalizationPlan,
  batchSize: number,
): Promise<number> {
  let written = 0;
  for (let i = 0; i < plan.writes.length; i += batchSize) {
    const batch = plan.writes.slice(i, i + batchSize);
    const values = dsql.join(
      batch.map((p) => dsql`(${p.id}::uuid, ${p.textNorm}::text)`),
      dsql`, `,
    );
    // One multi-row UPDATE ... FROM (VALUES ...) per batch, not N statements. The SET list
    // is one column on purpose — see the header. `text_norm IS NULL` is repeated so a
    // concurrent run cannot double-write a row this plan was built before.
    const res = await db.execute(dsql`
      UPDATE "skill_alias" t
         SET "text_norm" = v.norm
        FROM (VALUES ${values}) AS v(id, norm)
       WHERE t."id" = v.id
         AND t."text_norm" IS NULL
    `);
    written += (res as unknown as { count?: number }).count ?? batch.length;
  }
  return written;
}

async function main(): Promise<void> {
  const opts = parseCommonCli(SCRIPT);
  const rollback = argFlag("rollback");
  const assertSafe = argFlag("assert-predicate-safe");
  // General rehearsal capability rather than two hardcoded alias strings: a demotion is a
  // taxonomy decision, and the runner should not carry the current one as a constant.
  const probeDemote = (argValue("probe-demote") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  printHeader(SCRIPT, opts);
  if (rollback && !opts.apply) {
    console.log(
      `[${SCRIPT}] --rollback has NO EFFECT without --apply; this is an ordinary dry run. ` +
        "Use `--apply --rollback` for the rehearsal.",
    );
  }

  const { db, sql } = createDbClient(opts.databaseUrl, { max: 1 });

  try {
    const raw = (await db.execute(FETCH_ROWS)) as unknown as RawRow[];
    const rows = toPlannerRows(raw);
    const plan = planSkillAliasNormalization(rows);
    printPlan(plan, rows);

    if (assertSafe) {
      const readiness = retrievalPredicateReadiness(rows);
      if (!readiness.safe) {
        throw new Error(
          `--assert-predicate-safe: ${readiness.hiddenByMissingNormalization.length} active embedded ` +
            "alias(es) are hidden by missing normalization. The skill-alias retrieval predicate is unsafe.",
        );
      }
      console.log(`[${SCRIPT}] --assert-predicate-safe: PASS.`);
    }

    if (!opts.apply) {
      printFooter(SCRIPT, opts, plan.writes.length);
      return;
    }

    if (rollback) {
      await rehearse(db, plan, opts.batchSize, probeDemote);
      console.log(
        `[${SCRIPT}] REHEARSAL complete — ${plan.writes.length} row change(s) exercised against the ` +
          "live schema and rolled back. Nothing was written.",
      );
      return;
    }

    const written = await writeTextNorm(db, plan, opts.batchSize);
    const after = toPlannerRows((await db.execute(FETCH_ROWS)) as unknown as RawRow[]);
    printCounts(SCRIPT, {
      text_norm_written: written,
      text_norm_still_null_after: after.filter((r) => r.textNorm === null).length,
      is_searchable_changed: 0,
    });
    printReadiness(after);
    printFooter(SCRIPT, opts, written);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * `--apply --rollback` — run the real write path against the real corpus and the real
 * index, measure, then throw so the transaction unwinds.
 *
 * This is how the normalizer is proved before it is ever committed: a simulation cannot
 * tell you whether `skill_alias_skill_norm_lang_uq` accepts the elected set, because the
 * index is the thing being asked. The rollback is structural — the only exit from
 * `db.transaction` here is the throw at the end.
 */
async function rehearse(
  db: ReturnType<typeof createDbClient>["db"],
  plan: SkillAliasNormalizationPlan,
  batchSize: number,
  probeDemote: readonly string[],
): Promise<void> {
  const SENTINEL = "rehearsal-complete";
  console.log(`[${SCRIPT}] REHEARSAL — writing inside a transaction that will be rolled back.`);

  try {
    await db.transaction(async (tx) => {
      const written = await writeTextNorm(tx as unknown as typeof db, plan, batchSize);

      const mid = toPlannerRows((await tx.execute(FETCH_ROWS)) as unknown as RawRow[]);
      console.log(`[${SCRIPT}] after normalization (uncommitted):`);
      printCounts(SCRIPT, {
        text_norm_written: written,
        text_norm_still_null: mid.filter((r) => r.textNorm === null).length,
        is_searchable_unchanged_true: mid.filter((r) => r.isSearchable).length,
      });
      printReadiness(mid);

      // STEP 2 — the election this runner deliberately does not perform for real. Asks the
      // live unique index whether the post-normalization catalogue is electable at all.
      const elected = await tx.execute(REHEARSE_ELECT_SEARCHABLE);
      const post = toPlannerRows((await tx.execute(FETCH_ROWS)) as unknown as RawRow[]);
      const activeEmbedded = post.filter((r) => r.skillStatus === "active" && r.hasEmbedding);
      console.log(`[${SCRIPT}] after REHEARSED election (uncommitted):`);
      printCounts(SCRIPT, {
        is_searchable_flipped: (elected as unknown as { count?: number }).count ?? 0,
        searchable_total: post.filter((r) => r.isSearchable).length,
        active_embedded_total: activeEmbedded.length,
        active_embedded_searchable: activeEmbedded.filter((r) => r.isSearchable).length,
      });
      printReadiness(post);

      // STEP 3 — can a deliberate demotion still be expressed after election, without
      // deleting the row or losing its embedding provenance?
      const demotedIds: string[] = [];
      for (const target of probeDemote) {
        const hit = (await tx.execute(dsql`
          UPDATE "skill_alias" SET "is_searchable" = false
           WHERE lower("text") = lower(${target})
          RETURNING "id"::text                                  AS id,
                    ("embedding" IS NOT NULL)                   AS has_embedding,
                    ("embedding_model" IS NOT NULL)             AS has_model,
                    ("embedded_at" IS NOT NULL)                 AS has_embedded_at,
                    ("text_norm" IS NOT NULL)                   AS has_text_norm
        `)) as unknown as Array<Record<string, string | boolean>>;
        for (const h of hit) demotedIds.push(String(h.id));
        console.log(
          `[${SCRIPT}] demotion probe "${target}": rows=${hit.length} ` +
            `embedding_kept=${hit.filter((h) => h.has_embedding).length} ` +
            `model_kept=${hit.filter((h) => h.has_model).length} ` +
            `embedded_at_kept=${hit.filter((h) => h.has_embedded_at).length} ` +
            `text_norm_kept=${hit.filter((h) => h.has_text_norm).length}`,
        );
      }

      const demoted = toPlannerRows((await tx.execute(FETCH_ROWS)) as unknown as RawRow[]);
      // Naming the alias on the command line IS the record of intent, so those ids are
      // passed as `intentionallyDemoted`. Printed both ways to show the difference the
      // register makes — without it, a demotion is indistinguishable from an oversight.
      console.log(`[${SCRIPT}] after REHEARSED demotion, WITHOUT the demotion register:`);
      printReadiness(demoted);
      console.log(`[${SCRIPT}] after REHEARSED demotion, WITH the demotion register:`);
      printReadiness(demoted, demotedIds);

      throw new Error(SENTINEL);
    });
  } catch (err) {
    if (!(err instanceof Error) || err.message !== SENTINEL) throw err;
  }

  const final = toPlannerRows((await db.execute(FETCH_ROWS)) as unknown as RawRow[]);
  console.log(`[${SCRIPT}] ROLLED BACK. Committed state re-read from the database:`);
  printCounts(SCRIPT, {
    text_norm_populated: final.filter((r) => r.textNorm !== null).length,
    text_norm_null: final.filter((r) => r.textNorm === null).length,
    is_searchable_true: final.filter((r) => r.isSearchable).length,
  });
}

main().catch((err) => {
  // nosemgrep: javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring -- `SCRIPT` is a module-level string constant declared in this file, never input. This is the CLI's terminal error line; no user- or worker-supplied value reaches the template.
  console.error(`[${SCRIPT}] failed:`, err);
  process.exit(1);
});
