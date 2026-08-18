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
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

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
  projectElection,
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

/**
 * A checksum over EVERY column this runner promises not to touch.
 *
 * Taken before and after the write, inside the same transaction, and compared. This is the
 * proof — not the assertion — that `embedding`, `embedding_model`, `embedded_at`,
 * `is_searchable`, `text`, `skill_id`, `lang` and `source` came through unchanged. A
 * `SET text_norm = ...` obviously cannot alter them, but a trigger, a rule, or a future
 * edit to the statement can, and "obviously" is what this class of bug hides behind.
 *
 * `md5(embedding::text)` rather than the vector itself: 295 x 768 floats is megabytes of
 * string_agg, and a digest of the text form is equally sensitive to any change.
 */
const IMMUTABLE_COLUMNS_CHECKSUM = dsql`
  SELECT md5(string_agg(
           "id"::text || chr(1) ||
           "skill_id" || chr(1) ||
           "text" || chr(1) ||
           coalesce("lang", '~') || chr(1) ||
           "source" || chr(1) ||
           "is_searchable"::text || chr(1) ||
           coalesce("embedding_model", '~') || chr(1) ||
           coalesce("embedded_at"::text, '~') || chr(1) ||
           coalesce(md5("embedding"::text), '~'),
           '|' ORDER BY "id"
         )) AS checksum
    FROM "skill_alias"
`;

/** Same-skill `(text_norm, lang)` groups with >1 member, and cross-skill ones, from the DB. */
const COLLISION_COUNTS = dsql`
  SELECT (SELECT count(*)::int FROM (
            SELECT 1 FROM "skill_alias" WHERE "text_norm" IS NOT NULL
             GROUP BY "skill_id", "text_norm", "lang" HAVING count(*) > 1
          ) g)                                            AS same_skill_groups,
         (SELECT count(*)::int FROM (
            SELECT 1 FROM "skill_alias" WHERE "text_norm" IS NOT NULL
             GROUP BY "text_norm", "lang" HAVING count(DISTINCT "skill_id") > 1
          ) g)                                            AS cross_skill_groups
`;

interface CollisionCounts {
  same_skill_groups: number;
  cross_skill_groups: number;
}

interface ManifestRow {
  id: string;
  skill_id: string;
  skill_status: string;
  lang: string | null;
  old_text_norm: string | null;
  new_text_norm: string;
  election: string;
  duplicate_classification: string;
}

interface Manifest {
  script: string;
  scope: string;
  statement: string;
  totals: Record<string, number>;
  /**
   * PROJECTIONS, not applied state. Election is a separate gated step and this runner does
   * not perform it; these fields say what it WOULD produce from the post-write table.
   */
  projected: Record<string, number>;
  rows: ManifestRow[];
  rollback_ids: string[];
  rollback_sql: string;
  immutable_columns_checksum: string;
  collisions_before: CollisionCounts;
}

/**
 * Canonical JSON: keys sorted at EVERY depth, arrays left in order.
 *
 * Deliberately not `JSON.stringify(m, Object.keys(m).sort())` — the second argument is an
 * allow-list applied recursively, so that form silently drops every nested key absent from
 * the top-level list and digests a truncated document.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * `sha256` over the canonical body, so the digest is a function of CONTENT, not key order.
 * Stored beside the body, never inside it — a structure cannot contain its own hash.
 */
function manifestDigest(m: Manifest): string {
  return createHash("sha256").update(canonicalJson(m)).digest("hex");
}

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

/**
 * Build the pre-write manifest: every row that will change, what it will change to, and
 * the projected election outcome so the write can be audited against a fixed expectation.
 */
function buildManifest(
  plan: SkillAliasNormalizationPlan,
  rows: readonly SkillAliasNormalizationRow[],
  checksum: string,
  collisions: CollisionCounts,
): Manifest {
  const byId = new Map(rows.map((r) => [r.id, r]));
  // Project election over the POST-write table: every planned write applied, nothing else.
  const applied = rows.map((r) => {
    const w = plan.writes.find((x) => x.id === r.id);
    return w === undefined ? r : { ...r, textNorm: w.textNorm };
  });
  const election = new Map(projectElection(applied).map((e) => [e.id, e]));

  const manifestRows: ManifestRow[] = plan.writes.map((w) => {
    const row = byId.get(w.id);
    const e = election.get(w.id);
    return {
      id: w.id,
      skill_id: w.skillId,
      skill_status: row?.skillStatus ?? "unknown",
      lang: row?.lang ?? null,
      old_text_norm: row?.textNorm ?? null,
      new_text_norm: w.textNorm,
      election: e?.election ?? "unknown",
      duplicate_classification: e?.duplicateClassification ?? "unknown",
    };
  });

  const ids = manifestRows.map((r) => r.id);
  const activeRows = manifestRows.filter((r) => r.skill_status === "active");
  const gateB = applied.filter((r) => r.skillStatus === "active" && r.hasEmbedding);

  return {
    script: SCRIPT,
    scope: "text_norm only, on rows WHERE text_norm IS NULL",
    statement: 'UPDATE "skill_alias" SET "text_norm" = $1 WHERE "id" = $2 AND "text_norm" IS NULL',
    totals: {
      total_rows_to_update: manifestRows.length,
      active_rows: activeRows.length,
      provisional_rows: manifestRows.filter((r) => r.skill_status === "provisional").length,
      cross_skill_collisions: plan.crossSkillCollisions.length,
      unique_key_conflict_groups: plan.uniqueKeyConflicts.length,
    },
    projected: {
      duplicate_winners: manifestRows.filter((r) => r.election === "winner").length,
      duplicate_losers: manifestRows.filter((r) => r.election === "loser").length,
      gate_b_active_embedded_total: gateB.length,
      gate_b_projected_elected: gateB.filter((r) => election.get(r.id)?.election === "winner").length,
      gate_b_projected_losers: gateB.filter((r) => election.get(r.id)?.election === "loser").length,
    },
    rows: manifestRows,
    rollback_ids: ids,
    // Every `old_text_norm` in this manifest is NULL by construction (the plan only ever
    // selects `text_norm IS NULL`), so a blanket re-NULL over the captured id set is an
    // exact inverse, not an approximation.
    rollback_sql: `UPDATE "skill_alias" SET "text_norm" = NULL WHERE "id" IN (${ids
      .map((i) => `'${i}'`)
      .join(", ")});`,
    immutable_columns_checksum: checksum,
    collisions_before: collisions,
  };
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
  const manifestPath = argValue("manifest");

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

    const checksumBefore = String(
      ((await db.execute(IMMUTABLE_COLUMNS_CHECKSUM)) as unknown as Array<{ checksum: string }>)[0]
        ?.checksum ?? "",
    );
    const collisionsBefore = ((await db.execute(COLLISION_COUNTS)) as unknown as CollisionCounts[])[0] ?? {
      same_skill_groups: 0,
      cross_skill_groups: 0,
    };

    if (manifestPath !== undefined && !opts.apply) {
      const manifest = buildManifest(plan, rows, checksumBefore, collisionsBefore);
      const digest = manifestDigest(manifest);
      writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, sha256: digest }, null, 2)}\n`);
      console.log(`[${SCRIPT}] manifest written: ${manifestPath}`);
      console.log(`[${SCRIPT}] sha256(manifest) = ${digest}`);
      printCounts(SCRIPT, { ...manifest.totals, ...manifest.projected });
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

    // ── APPLY. Single transaction, fail-closed on every deviation from the manifest. ──
    if (manifestPath === undefined) {
      throw new Error(
        `[${SCRIPT}] --apply requires --manifest=<path> pointing at a manifest produced by a dry ` +
          "run of this same script. The write is audited against it row by row.",
      );
    }
    const expected = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest & { sha256: string };
    const { sha256: recordedDigest, ...body } = expected;
    const recomputed = manifestDigest(body as Manifest);
    if (recomputed !== recordedDigest) {
      throw new Error(
        `[${SCRIPT}] manifest digest mismatch — recorded ${recordedDigest}, recomputed ${recomputed}. ` +
          "The manifest was edited after it was generated. Refusing to write.",
      );
    }
    console.log(`[${SCRIPT}] manifest verified: ${manifestPath} (sha256 ${recordedDigest})`);

    const started = Date.now();
    const result = await applyGuarded(db, plan, expected, opts.batchSize, checksumBefore, collisionsBefore);
    const elapsedMs = Date.now() - started;

    const after = toPlannerRows((await db.execute(FETCH_ROWS)) as unknown as RawRow[]);
    printCounts(SCRIPT, {
      rows_updated: result.written,
      rows_skipped: plan.writes.length - result.written,
      elapsed_ms: elapsedMs,
      text_norm_still_null_after: after.filter((r) => r.textNorm === null).length,
      is_searchable_changed: 0,
    });
    printReadiness(after);
    printFooter(SCRIPT, opts, result.written);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * THE AUTHORIZED WRITE. One transaction, four fail-closed checks, no partial state.
 *
 * Every check aborts by throwing, which unwinds the transaction — there is no code path
 * that reports a problem and commits anyway.
 *
 *  1. SCOPE. The plan built from the live table must match the manifest exactly, id for id
 *     and value for value. A row that appeared, vanished or normalizes differently since
 *     the manifest was generated means the corpus moved underneath it.
 *  2. ROW COUNT. `rows_updated` must equal the manifest length. Fewer means a concurrent
 *     writer took a row (the `AND text_norm IS NULL` guard fired); more is impossible by
 *     construction and is checked anyway.
 *  3. IMMUTABLE COLUMNS. The checksum over `embedding`, `embedding_model`, `embedded_at`,
 *     `is_searchable`, `text`, `skill_id`, `lang`, `source` must be byte-identical before
 *     and after. This is what makes "no other column may change" a measurement.
 *  4. COLLISION GROWTH. Same-skill duplicate groups and cross-skill collision groups must
 *     match the manifest's projection. Unexpected growth means the normalizer collapsed
 *     two aliases nobody predicted it would, and that is a taxonomy event, not a backfill.
 */
async function applyGuarded(
  db: ReturnType<typeof createDbClient>["db"],
  plan: SkillAliasNormalizationPlan,
  manifest: Manifest,
  batchSize: number,
  checksumBefore: string,
  collisionsBefore: CollisionCounts,
): Promise<{ written: number }> {
  // CHECK 1 — scope, before opening the transaction.
  const planned = new Map(plan.writes.map((w) => [w.id, w.textNorm]));
  const expected = new Map(manifest.rows.map((r) => [r.id, r.new_text_norm]));
  if (planned.size !== expected.size) {
    throw new Error(
      `scope check failed: the live table plans ${planned.size} write(s), the manifest records ` +
        `${expected.size}. Regenerate the manifest.`,
    );
  }
  for (const [id, value] of planned) {
    const want = expected.get(id);
    if (want === undefined) throw new Error(`scope check failed: ${id} is not in the manifest.`);
    if (want !== value) {
      throw new Error(`scope check failed: ${id} would be written a value the manifest does not record.`);
    }
  }
  if (checksumBefore !== manifest.immutable_columns_checksum) {
    throw new Error(
      "scope check failed: the immutable-column checksum has moved since the manifest was " +
        "generated. Another writer touched skill_alias. Regenerate the manifest.",
    );
  }

  let written = 0;
  await db.transaction(async (tx) => {
    const inner = tx as unknown as typeof db;
    written = await writeTextNorm(inner, plan, batchSize);

    // CHECK 2 — row count.
    if (written !== manifest.rows.length) {
      throw new Error(
        `row-count check failed: updated ${written}, manifest records ${manifest.rows.length}. ` +
          "Rolling back.",
      );
    }

    // CHECK 3 — immutable columns.
    const after = String(
      ((await inner.execute(IMMUTABLE_COLUMNS_CHECKSUM)) as unknown as Array<{ checksum: string }>)[0]
        ?.checksum ?? "",
    );
    if (after !== checksumBefore) {
      throw new Error(
        "immutable-column check FAILED: a column outside text_norm changed during the write. " +
          "Rolling back.",
      );
    }

    // CHECK 4 — collision growth.
    const collisions = ((await inner.execute(COLLISION_COUNTS)) as unknown as CollisionCounts[])[0];
    const wantSame = manifest.totals.unique_key_conflict_groups ?? 0;
    const wantCross = manifest.totals.cross_skill_collisions ?? 0;
    if (collisions === undefined) throw new Error("collision check failed: no counts returned.");
    if (collisions.same_skill_groups !== wantSame || collisions.cross_skill_groups !== wantCross) {
      throw new Error(
        `collision check FAILED: same-skill groups ${collisionsBefore.same_skill_groups} -> ` +
          `${collisions.same_skill_groups} (expected ${wantSame}), cross-skill ` +
          `${collisionsBefore.cross_skill_groups} -> ${collisions.cross_skill_groups} ` +
          `(expected ${wantCross}). Rolling back.`,
      );
    }

    console.log(
      `[${SCRIPT}] all four guards passed inside the transaction — scope, row count, ` +
        "immutable columns, collision growth. Committing.",
    );
  });

  return { written };
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
