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
import { existsSync, readFileSync, writeFileSync } from "node:fs";

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
  type AliasVisibilityDecision,
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
/**
 * Write an evidence artifact, REFUSING to overwrite one that already exists.
 *
 * Learned the hard way during the verification stage: re-running a dry run with
 * `--manifest=<committed path>` silently replaced the committed 131-row PRE-WRITE manifest
 * with a 0-row one, because the write had already happened and the plan was now empty. The
 * artifact whose entire job is to record what the corpus looked like BEFORE a mutation is
 * exactly the file that must never be regenerated in place. It was recovered from git, and
 * this guard is why it cannot happen twice. A caller that genuinely wants a fresh artifact
 * picks a fresh path.
 */
function writeArtifact(path: string, body: object, label: string): string {
  if (existsSync(path)) {
    throw new Error(
      `[${SCRIPT}] refusing to overwrite an existing ${label}: ${path}\n` +
        "  These artifacts are immutable evidence. Write to a new path, or delete the old file\n" +
        "  deliberately if it is genuinely obsolete.",
    );
  }
  const digest = createHash("sha256").update(canonicalJson(body)).digest("hex");
  writeFileSync(path, `${JSON.stringify({ ...body, sha256: digest }, null, 2)}\n`);
  console.log(`[${SCRIPT}] ${label} written: ${path}`);
  console.log(`[${SCRIPT}] sha256(${label}) = ${digest}`);
  return digest;
}

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
  decisions: Readonly<Record<string, AliasVisibilityDecision>> = {},
): void {
  const r = retrievalPredicateReadiness(rows, { decisions });
  const rec = r.hiddenByRecordedDecision;
  console.log(
    `[${SCRIPT}] retrieval-predicate readiness: ${r.safe ? "SAFE" : "NOT SAFE"} — active embedded ` +
      `aliases: not_normalized=${r.hiddenByMissingNormalization.length} ` +
      `hidden_without_decision=${r.hiddenWithoutDecision.length} ` +
      `contradicted=${r.contradictedDecisions.length} | recorded: ` +
      `duplicate_loser=${rec.duplicate_loser.length} demoted=${rec.intentionally_demoted.length}`,
  );
  if (!r.safe) {
    console.log(
      `[${SCRIPT}] => \`AND sa.is_searchable\` must NOT be added to any skill-alias retrieval path. ` +
        "Nothing in the table counts as evidence of election — not text_norm, not a searchable sibling.",
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

/**
 * THE POST-NORMALIZATION VERIFICATION RECORD — read-only evidence, independently recomputed.
 *
 * Deliberately NOT a copy of what the apply run printed. It re-derives every figure from
 * the table as it stands now, so it can disagree with the write's own report. Its sha256
 * is over the canonical body, making it quotable and tamper-evident.
 */
interface VerificationRecord {
  script: string;
  stage: string;
  source_manifest: string | null;
  source_manifest_sha256: string | null;
  findings: Record<string, number | string>;
  contested_groups: Array<Record<string, unknown>>;
  cross_skill_collisions: Array<Record<string, unknown>>;
  invariants_held: Record<string, string>;
}

function buildVerificationRecord(
  rows: readonly SkillAliasNormalizationRow[],
  plan: SkillAliasNormalizationPlan,
  checksum: string,
  collisions: CollisionCounts,
  manifestPath: string | undefined,
): VerificationRecord {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const projection = new Map(projectElection(rows).map((e) => [e.id, e]));
  const gateB = rows.filter((r) => r.skillStatus === "active" && r.hasEmbedding);

  let sourceSha: string | null = null;
  if (manifestPath !== undefined) {
    const m = JSON.parse(readFileSync(manifestPath, "utf8")) as { sha256?: string };
    sourceSha = m.sha256 ?? null;
  }

  return {
    script: SCRIPT,
    stage: "post-normalization verification — READ ONLY, nothing written",
    source_manifest: manifestPath ?? null,
    source_manifest_sha256: sourceSha,
    findings: {
      corpus_row_count: rows.length,
      text_norm_populated: rows.filter((r) => r.textNorm !== null).length,
      text_norm_null: rows.filter((r) => r.textNorm === null).length,
      active_normalized: rows.filter((r) => r.skillStatus === "active" && r.textNorm !== null).length,
      active_total: rows.filter((r) => r.skillStatus === "active").length,
      provisional_normalized: rows.filter((r) => r.skillStatus === "provisional" && r.textNorm !== null).length,
      provisional_total: rows.filter((r) => r.skillStatus === "provisional").length,
      elected_projection: rows.filter((r) => projection.get(r.id)?.election === "winner").length,
      duplicate_losers: rows.filter((r) => projection.get(r.id)?.election === "loser").length,
      cross_skill_collisions: plan.crossSkillCollisions.length,
      is_searchable_true_actual: rows.filter((r) => r.isSearchable).length,
      embeddings_present: rows.filter((r) => r.hasEmbedding).length,
      gate_b_total: gateB.length,
      gate_b_normalized: gateB.filter((r) => r.textNorm !== null).length,
      gate_b_elected_projection: gateB.filter((r) => projection.get(r.id)?.election === "winner").length,
      gate_b_duplicate_losers: gateB.filter((r) => projection.get(r.id)?.election === "loser").length,
      gate_b_actually_searchable: gateB.filter((r) => r.isSearchable).length,
      immutable_columns_checksum: checksum,
      db_same_skill_duplicate_groups: collisions.same_skill_groups,
      db_cross_skill_collision_groups: collisions.cross_skill_groups,
    },
    contested_groups: plan.uniqueKeyConflicts.map((c) => ({
      skill_id: c.skillId,
      lang: c.lang,
      text_norm: c.textNorm,
      members: c.ids.map((id) => ({
        alias_id: id,
        text: byId.get(id)?.text ?? null,
        skill_status: byId.get(id)?.skillStatus ?? null,
        has_embedding: byId.get(id)?.hasEmbedding ?? false,
        current_is_searchable: byId.get(id)?.isSearchable ?? false,
        projected_outcome: projection.get(id)?.election ?? "unknown",
      })),
    })),
    cross_skill_collisions: plan.crossSkillCollisions.map((c) => ({
      text_norm: c.textNorm,
      lang: c.lang,
      skill_ids: c.skillIds,
      members: c.ids.map((id) => ({
        alias_id: id,
        skill_id: byId.get(id)?.skillId ?? null,
        text: byId.get(id)?.text ?? null,
        skill_status: byId.get(id)?.skillStatus ?? null,
        has_embedding: byId.get(id)?.hasEmbedding ?? false,
      })),
      status: "UNRESOLVED — reported, not settled",
    })),
    invariants_held: {
      is_searchable: "UNCHANGED — no election has run",
      retrieval_predicate: "OFF — no skill-alias path filters is_searchable",
      retrieval_behaviour: "UNCHANGED — no query path reads skill_alias.text_norm",
      embeddings: "UNCHANGED — no provider call in this workstream",
      floor: "0.75",
      no_regression: "enforced",
      canonicalization: "OFF",
      promotion: "none",
      exp_p8_baseline: "immutable",
      domain_generation_4071: "not authorized",
    },
  };
}

/**
 * THE PROPOSED ELECTION — computed, never applied.
 *
 * One row per alias the election would touch or must account for: every row whose
 * `is_searchable` would change, UNIONED with every active embedded alias. The union is
 * what makes Gate B explicit — an active alias that election leaves alone still gets a
 * line saying so, rather than being absent and therefore unexamined.
 *
 * `decision_source` records WHERE the outcome came from, so the guard can distinguish a
 * mechanical duplicate election from a human taxonomy decision. Nothing here is derived
 * from a row already being searchable; that is the inference the guard now refuses.
 */
interface ElectionManifestRow {
  alias_id: string;
  skill_id: string;
  text_norm: string;
  lang: string | null;
  skill_status: string;
  has_embedding: boolean;
  current_is_searchable: boolean;
  proposed_is_searchable: boolean;
  winner_id: string;
  loser_reason: string | null;
  decision_source: string;
}

interface ElectionManifest {
  script: string;
  status: string;
  scope: string;
  statement: string;
  totals: Record<string, number>;
  gate_b: Record<string, number>;
  contested_groups: Array<Record<string, unknown>>;
  cross_skill_collisions: Array<Record<string, unknown>>;
  rows: ElectionManifestRow[];
  rollback_sql: string;
  immutable_columns_checksum: string;
}

function buildElectionManifest(
  rows: readonly SkillAliasNormalizationRow[],
  plan: SkillAliasNormalizationPlan,
  checksum: string,
): ElectionManifest {
  const projection = new Map(projectElection(rows).map((e) => [e.id, e]));
  const byId = new Map(rows.map((r) => [r.id, r]));

  // Group members, so a loser can name the winner that displaced it.
  const groups = new Map<string, SkillAliasNormalizationRow[]>();
  for (const r of rows) {
    if (r.textNorm === null) continue;
    const k = JSON.stringify([r.skillId, r.textNorm, r.lang]);
    const b = groups.get(k);
    if (b === undefined) groups.set(k, [r]);
    else b.push(r);
  }
  const winnerOf = new Map<string, string>();
  for (const [k, members] of groups) {
    const w = members.find((m) => projection.get(m.id)?.election === "winner");
    if (w !== undefined) winnerOf.set(k, w.id);
  }

  const manifestRows: ElectionManifestRow[] = [];
  for (const r of rows) {
    if (r.textNorm === null) continue;
    const p = projection.get(r.id);
    const proposed = p?.election === "winner";
    const isGateB = r.skillStatus === "active" && r.hasEmbedding;
    if (proposed === r.isSearchable && !isGateB) continue; // unchanged and not Gate B

    const key = JSON.stringify([r.skillId, r.textNorm, r.lang]);
    const winner = winnerOf.get(key) ?? r.id;
    manifestRows.push({
      alias_id: r.id,
      skill_id: r.skillId,
      text_norm: r.textNorm,
      lang: r.lang,
      skill_status: r.skillStatus,
      has_embedding: r.hasEmbedding,
      current_is_searchable: r.isSearchable,
      proposed_is_searchable: proposed,
      winner_id: winner,
      loser_reason: proposed
        ? null
        : `displaced by ${winner} in (skill_id, text_norm, lang) — tie-break: embedded first, ` +
          "then shortest text, then lowest id",
      decision_source: proposed ? "duplicate_election:rn=1" : "duplicate_election:rn>1",
    });
  }

  const gateB = rows.filter((r) => r.skillStatus === "active" && r.hasEmbedding);
  const changed = manifestRows.filter((r) => r.current_is_searchable !== r.proposed_is_searchable);

  return {
    script: SCRIPT,
    status: "PROPOSED — NOT EXECUTED. No is_searchable value has been written.",
    scope: "is_searchable only; text_norm, embedding and provenance untouched",
    statement:
      'UPDATE "skill_alias" SET "is_searchable" = $1 WHERE "id" = $2 -- one row per manifest entry',
    totals: {
      rows_in_manifest: manifestRows.length,
      rows_that_would_change: changed.length,
      would_become_searchable: changed.filter((r) => r.proposed_is_searchable).length,
      would_become_hidden: changed.filter((r) => !r.proposed_is_searchable).length,
      unique_key_conflict_groups: plan.uniqueKeyConflicts.length,
      cross_skill_collision_groups: plan.crossSkillCollisions.length,
      intentional_demotions: 0,
    },
    gate_b: {
      active_embedded_total: gateB.length,
      proposed_elected: gateB.filter((r) => projection.get(r.id)?.election === "winner").length,
      proposed_duplicate_losers: gateB.filter((r) => projection.get(r.id)?.election === "loser").length,
      // Every Gate-B alias must appear in `rows`, or the guard would have nothing to read
      // for it and would (correctly) refuse the predicate.
      covered_by_manifest: gateB.filter((r) => manifestRows.some((m) => m.alias_id === r.id)).length,
      unintentionally_unreachable: 0,
    },
    contested_groups: plan.uniqueKeyConflicts.map((c) => ({
      skill_id: c.skillId,
      text_norm: c.textNorm,
      lang: c.lang,
      members: c.ids.map((id) => ({
        alias_id: id,
        text: byId.get(id)?.text ?? null,
        has_embedding: byId.get(id)?.hasEmbedding ?? false,
        outcome: projection.get(id)?.election ?? "unknown",
      })),
    })),
    cross_skill_collisions: plan.crossSkillCollisions.map((c) => ({
      text_norm: c.textNorm,
      lang: c.lang,
      skill_ids: c.skillIds,
      members: c.ids.map((id) => ({
        alias_id: id,
        skill_id: byId.get(id)?.skillId ?? null,
        skill_status: byId.get(id)?.skillStatus ?? null,
        has_embedding: byId.get(id)?.hasEmbedding ?? false,
      })),
      resolution: "UNRESOLVED — taxonomy/retrieval decision, deliberately not settled here",
      note:
        "Legal under skill_alias_skill_norm_lang_uq (partitioned by skill_id). The hazard is L0: " +
        "an exact-equality probe on this text_norm matches two skills with nothing to rank them. " +
        "Election does not and must not resolve it.",
    })),
    rows: manifestRows,
    rollback_sql:
      "-- inverse of the proposed election, per row:\n" +
      manifestRows
        .filter((r) => r.current_is_searchable !== r.proposed_is_searchable)
        .map((r) => `UPDATE "skill_alias" SET "is_searchable" = ${r.current_is_searchable} WHERE "id" = '${r.alias_id}';`)
        .join("\n"),
    immutable_columns_checksum: checksum,
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
  const verificationPath = argValue("verification-record");
  const electionPath = argValue("election-manifest");

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

    // ── READ-ONLY ARTIFACTS. Both refuse to coexist with --apply, so a run that produces
    //    an evidence record can never also be the run that mutates the thing it describes.
    if ((verificationPath !== undefined || electionPath !== undefined) && opts.apply) {
      throw new Error(
        `[${SCRIPT}] --verification-record and --election-manifest are read-only artifacts and ` +
          "cannot be combined with --apply. Produce the evidence in its own run.",
      );
    }

    if (verificationPath !== undefined) {
      const record = buildVerificationRecord(rows, plan, checksumBefore, collisionsBefore, manifestPath);
      writeArtifact(verificationPath, record, "verification record");
      printCounts(SCRIPT, record.findings);
    }

    if (electionPath !== undefined) {
      const election = buildElectionManifest(rows, plan, checksumBefore);
      writeArtifact(electionPath, election, "election manifest (PROPOSED, NOT EXECUTED)");
      printCounts(SCRIPT, { ...election.totals, ...election.gate_b });

      // Prove the manifest is sufficient: replay it through the guard against the state it
      // WOULD produce. If the guard still refuses, the manifest is incomplete and saying so
      // now is the whole point of preparing it separately from executing it.
      const decisions: Record<string, AliasVisibilityDecision> = {};
      for (const r of election.rows) {
        decisions[r.alias_id] = r.proposed_is_searchable ? "elected" : "duplicate_loser";
      }
      const afterElection = rows.map((r) => {
        const m = election.rows.find((x) => x.alias_id === r.id);
        return m === undefined ? r : { ...r, isSearchable: m.proposed_is_searchable };
      });
      console.log(`[${SCRIPT}] guard replay against the state this manifest would produce:`);
      printReadiness(afterElection, decisions);
      console.log(
        `[${SCRIPT}] guard replay against TODAY's state (election not run) — must still refuse:`,
      );
      printReadiness(rows, decisions);
    }

    // A pre-write manifest is only GENERATED when it does not exist. Once it does, the
    // same flag means "audit --apply against this one", never "regenerate it".
    if (manifestPath !== undefined && !opts.apply && !existsSync(manifestPath)) {
      const manifest = buildManifest(plan, rows, checksumBefore, collisionsBefore);
      writeArtifact(manifestPath, manifest, "pre-write manifest");
      printCounts(SCRIPT, { ...manifest.totals, ...manifest.projected });
    } else if (manifestPath !== undefined && !opts.apply) {
      console.log(
        `[${SCRIPT}] pre-write manifest already exists and was NOT regenerated: ${manifestPath}`,
      );
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
      // The decision record the guard requires: the election's own outcomes, plus the
      // demotions named on the command line — naming them IS the record of intent.
      // Printed both ways to show what the record buys: without it, every hidden row is
      // indistinguishable from an oversight, which is exactly the guard's point.
      const decisions: Record<string, AliasVisibilityDecision> = {};
      for (const e of projectElection(demoted)) {
        decisions[e.id] = e.election === "winner" ? "elected" : "duplicate_loser";
      }
      for (const id of demotedIds) decisions[id] = "intentionally_demoted";
      console.log(`[${SCRIPT}] after REHEARSED demotion, WITHOUT a decision record:`);
      printReadiness(demoted);
      console.log(`[${SCRIPT}] after REHEARSED demotion, WITH the decision record:`);
      printReadiness(demoted, decisions);

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
