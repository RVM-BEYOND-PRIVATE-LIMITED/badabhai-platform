/**
 * UNIFIED ALIAS LIFECYCLE — one engine for `job_domain_alias` and `skill_alias`.
 *
 *     raw ──▶ normalized ──▶ elected ──▶ embedded ──▶ retrievable
 *
 * ── WHY THIS EXISTS ──
 *
 * Two tables have always modelled one concept, through two runners, with two meanings for
 * the same column and two index shapes. Every defect in the Phase 8/9 workstream lived in
 * that gap: `is_searchable` governing retrieval on one table and nothing on the other, a
 * predicate that would have hidden all 98 active-catalogue aliases, and an election no gate
 * could tell apart from an oversight.
 *
 * ── THE DOMAIN SIDE IS THE REFERENCE, NOT THE LEGACY ──
 *
 * `normalize-job-domain-aliases.ts` has been running correctly in production on 9,121 rows.
 * Verified 2026-08-18 by recomputing its rule and diffing against stored state: 9,121 rows,
 * ZERO mismatches; 0 searchable rows without a vector; one embedding model throughout. So
 * this engine GENERALIZES a proven implementation rather than inventing one, and
 * `verifyElection` exists to keep proving it — on both tables, routinely.
 *
 * What is legacy is the `skill_alias.domain_id` RETRIEVAL PATH, which is a separate thing
 * and is deleted only once Path A actually serves production. The COLUMN stays
 * indefinitely (CLAUDE.md §10 — never drop a production column).
 *
 * ── ELECTION IS FOUR REASONS, ALWAYS ALL FOUR ──
 *
 * A row is elected when its parent is eligible, its parent is not shadowed, it is the
 * representative of its `(parent, text_norm, lang)` group, and no recorded decision demotes
 * it. Reasons that do not apply to a table are STATED AS NO-OPS rather than omitted — see
 * `SKILL_ALIAS_SPEC.parentShadowed`. An omitted rule is indistinguishable from a forgotten
 * one, which is how the two runners drifted apart in the first place.
 *
 * PRIVACY: reference catalogue only. Ids, flags and counts — never worker data.
 */
import { sql as dsql } from "drizzle-orm";

/** The lifecycle states, in order. Derived from columns; never stored as an enum. */
export const ALIAS_STATES = ["raw", "normalized", "elected", "embedded", "retrievable"] as const;
export type AliasState = (typeof ALIAS_STATES)[number];

/** One alias row, reduced to what the lifecycle reasons about. */
export interface LifecycleAliasRow {
  readonly id: string;
  /** `job_domain_id` or `skill_id` — whichever this table hangs off. */
  readonly parentId: string;
  readonly text: string;
  readonly textNorm: string | null;
  readonly lang: string | null;
  readonly hasEmbedding: boolean;
  readonly isSearchable: boolean;
}

/** The owning `job_domain` / `skill` row, reduced to what eligibility reasons about. */
export interface LifecycleParentRow {
  readonly id: string;
  readonly status: string | null;
  /** `job_domain` only. */
  readonly selectable?: boolean;
  /** `job_domain` only — `isco08` units can be shadowed by their NCO children. */
  readonly source?: string | null;
  /** `job_domain` only — precomputed, because the shadow test is a child EXISTS query. */
  readonly hasSelectableActiveChild?: boolean;
}

/** Why a row is NOT elected. Empty on an elected row. */
export type NotElectedReason =
  | "not_normalized"
  | "parent_missing"
  | "parent_ineligible"
  | "parent_shadowed"
  | "not_group_representative"
  | "recorded_demotion";

export interface ElectionResult {
  readonly id: string;
  readonly elected: boolean;
  /** Every reason that applies, not just the first — an operator fixing one at a time. */
  readonly reasons: readonly NotElectedReason[];
  /** The representative of this row's group, or null when the row is un-normalized. */
  readonly winnerId: string | null;
}

/**
 * Per-table policy. The only thing that differs between the two tables, and it is data.
 */
export interface AliasTableSpec {
  readonly table: "job_domain_alias" | "skill_alias";
  readonly parentTable: "job_domain" | "skill";
  readonly parentKey: "job_domain_id" | "skill_id";
  /** REASON 1 — may this parent be retrieved at all? */
  parentEligible(parent: LifecycleParentRow): boolean;
  /** REASON 2 — is a more specific parent hiding this one? */
  parentShadowed(parent: LifecycleParentRow): boolean;
  /** Human sentence for the shadow rule, including when it is a no-op. */
  readonly shadowingNote: string;
}

export const JOB_DOMAIN_ALIAS_SPEC: AliasTableSpec = {
  table: "job_domain_alias",
  parentTable: "job_domain",
  parentKey: "job_domain_id",
  // Bucket rows ("Craft and Related Trades Workers") organize the tree; nobody holds one
  // as a job.
  parentEligible: (p) => p.selectable === true && p.status === "active",
  // THE F4 FIX. All 436 ISCO unit groups are seeded selectable alongside 3,449 NCO
  // occupations, and 370 have selectable NCO children. Leaving both in play makes the
  // shortlist mix two granularities — "Welders and Flame Cutters" competing with 44
  // specific NCO welding occupations. The 66 UNSHADOWED units stay reachable, because for
  // those the unit group IS the leaf. Measured in production: 3,989 aliases are
  // non-searchable for this reason alone.
  parentShadowed: (p) => p.source === "isco08" && p.hasSelectableActiveChild === true,
  shadowingNote: "isco08 unit groups with a selectable active NCO child are shadowed (F4)",
};

export const SKILL_ALIAS_SPEC: AliasTableSpec = {
  table: "skill_alias",
  parentTable: "skill",
  parentKey: "skill_id",
  // PROVISIONAL SKILLS STAY ELECTED, and that is deliberate. Retrieval already filters
  // `s.status = 'active'` in its own WHERE clause (Phase 7 Gate A), so a provisional
  // skill is unreachable regardless of this flag. De-electing it here would mean
  // promotion had to RE-ELECT — turning a status flip into a second corpus mutation, with
  // a window in between where a freshly promoted skill is active and invisible. Election
  // answers "is this row the representative of its text?", not "should this skill ship?".
  parentEligible: (p) => p.status === "active" || p.status === "provisional",
  // EXPLICIT NO-OP, STATED RATHER THAN OMITTED. `skill` has no parent/child hierarchy, so
  // nothing can shadow anything. Writing `false` here — instead of leaving the rule out of
  // the skill path — is the whole point of the unified engine: an omitted rule reads
  // identically to a forgotten one, which is how the two runners drifted apart. If skills
  // ever gain a hierarchy, this is the single line that changes.
  parentShadowed: () => false,
  shadowingNote: "skills have no hierarchy — shadowing is a stated no-op, not an omission",
};

export const ALIAS_TABLE_SPECS = [JOB_DOMAIN_ALIAS_SPEC, SKILL_ALIAS_SPEC] as const;

/**
 * The grouping key, reproducing the unique index's `NULLS NOT DISTINCT`.
 *
 * JSON, not a delimiter join: `lang` is nullable and every separator that could tell
 * `null` from the literal `"null"` is a character `text_norm` may legally contain (the
 * normalizer keeps intra-word `-` and `/`).
 */
function groupKey(parentId: string, textNorm: string, lang: string | null): string {
  return JSON.stringify([parentId, textNorm, lang]);
}

/**
 * The shared tie-break: an embedded row wins (never strand paid work), then the shortest
 * raw text, then the lowest id.
 *
 * Length in CODE POINTS, matching Postgres `length()`, which counts characters. Identical
 * for the Latin and Devanagari in these corpora (all BMP); pinned so a future non-BMP alias
 * cannot make this disagree with the SQL it mirrors.
 */
function tieBreak(a: LifecycleAliasRow, b: LifecycleAliasRow): number {
  return (
    Number(b.hasEmbedding) - Number(a.hasEmbedding) ||
    [...a.text].length - [...b.text].length ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

export interface ElectionInput {
  readonly spec: AliasTableSpec;
  readonly aliases: readonly LifecycleAliasRow[];
  readonly parents: readonly LifecycleParentRow[];
  /**
   * REASON 4 — alias ids a human decided should not be retrievable (the `fitting`/`gauge`
   * class). Supplied from outside because visibility is a taxonomy decision and NEVER
   * inferable from the table: a demoted row and a never-processed one are byte-identical.
   */
  readonly demotions?: ReadonlySet<string>;
}

/**
 * Compute election for every row. PURE — no database, no clock, no I/O.
 *
 * ORDER IS LOAD-BEARING AND MIRRORS THE SQL: the group representative is chosen over ALL
 * normalized rows in the group, INDEPENDENT of eligibility, and eligibility is then ANDed.
 * The production statement does exactly this (`row_number()` in the CTE, `eligible AND
 * rn = 1` in the UPDATE). Filtering ineligible rows out of the ranking first would elect a
 * different winner whenever a group's best row belongs to an ineligible parent — and
 * `verifyElection` against production would report thousands of false mismatches.
 */
export function computeElection(input: ElectionInput): ElectionResult[] {
  const { spec, aliases, parents } = input;
  const demotions = input.demotions ?? new Set<string>();
  const parentById = new Map(parents.map((p) => [p.id, p]));

  const groups = new Map<string, LifecycleAliasRow[]>();
  for (const a of aliases) {
    if (a.textNorm === null) continue;
    const key = groupKey(a.parentId, a.textNorm, a.lang);
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [a]);
    else bucket.push(a);
  }

  const winnerByGroup = new Map<string, string>();
  for (const [key, members] of groups) {
    const top = [...members].sort(tieBreak)[0];
    if (top !== undefined) winnerByGroup.set(key, top.id);
  }

  return aliases.map((a) => {
    const reasons: NotElectedReason[] = [];

    if (a.textNorm === null) {
      // An un-normalized row has no L0 key and no group. It can never be searchable, and
      // the domain runner clears the flag explicitly for exactly this case.
      return { id: a.id, elected: false, reasons: ["not_normalized"], winnerId: null };
    }

    const key = groupKey(a.parentId, a.textNorm, a.lang);
    const winnerId = winnerByGroup.get(key) ?? null;
    const parent = parentById.get(a.parentId);

    if (parent === undefined) reasons.push("parent_missing");
    else {
      if (!spec.parentEligible(parent)) reasons.push("parent_ineligible");
      if (spec.parentShadowed(parent)) reasons.push("parent_shadowed");
    }
    if (winnerId !== a.id) reasons.push("not_group_representative");
    if (demotions.has(a.id)) reasons.push("recorded_demotion");

    return { id: a.id, elected: reasons.length === 0, reasons, winnerId };
  });
}

/** Which lifecycle state a row is in, given the election just computed for it. */
export function aliasState(
  row: LifecycleAliasRow,
  parentActive: boolean,
): AliasState {
  if (row.textNorm === null) return "raw";
  if (!row.isSearchable) return "normalized";
  if (!row.hasEmbedding) return "elected";
  return parentActive ? "retrievable" : "embedded";
}

// ─────────────────────────────────────────────────────────────────────────────────────
// VERIFY
// ─────────────────────────────────────────────────────────────────────────────────────

export interface ElectionMismatch {
  readonly id: string;
  readonly stored: boolean;
  readonly expected: boolean;
  readonly reasons: readonly NotElectedReason[];
}

export interface VerifyReport {
  readonly table: AliasTableSpec["table"];
  readonly rowsChecked: number;
  readonly storedElected: number;
  readonly expectedElected: number;
  readonly mismatches: readonly ElectionMismatch[];
  /** Counts of every not-elected reason across the table. Diagnostics, not identity. */
  readonly reasonHistogram: Readonly<Partial<Record<NotElectedReason, number>>>;
  /** INVARIANTS. Each is a property that must hold for retrieval to behave. */
  readonly invariants: readonly InvariantResult[];
  /** True when every invariant holds and no row's stored flag disagrees. */
  readonly clean: boolean;
}

export interface InvariantResult {
  readonly name: string;
  readonly description: string;
  readonly violations: number;
  readonly passed: boolean;
  /** Up to a handful of offending ids, for an operator to go look at. */
  readonly sample: readonly string[];
}

/**
 * Recompute election and diff it against what is stored, plus the standing invariants.
 *
 * This is the function that PROVED the production domain surface sound (9,121 rows, 0
 * mismatches) and it is the same code path both tables now run. A mismatch means the stored
 * flag and the rule disagree — either the runner never ran, or something wrote the column
 * out of band.
 */
export function verifyElection(input: ElectionInput): VerifyReport {
  const { spec, aliases, parents } = input;
  const parentById = new Map(parents.map((p) => [p.id, p]));
  const results = computeElection(input);
  const byId = new Map(results.map((r) => [r.id, r]));

  const mismatches: ElectionMismatch[] = [];
  const reasonHistogram: Partial<Record<NotElectedReason, number>> = {};
  for (const a of aliases) {
    const r = byId.get(a.id);
    if (r === undefined) continue;
    for (const reason of r.reasons) reasonHistogram[reason] = (reasonHistogram[reason] ?? 0) + 1;
    if (a.isSearchable !== r.elected) {
      mismatches.push({ id: a.id, stored: a.isSearchable, expected: r.elected, reasons: r.reasons });
    }
  }

  const check = (
    name: string,
    description: string,
    offenders: readonly LifecycleAliasRow[],
  ): InvariantResult => ({
    name,
    description,
    violations: offenders.length,
    passed: offenders.length === 0,
    sample: offenders.slice(0, 5).map((o) => o.id),
  });

  // Group-uniqueness is computed over the STORED flags, because that is what the partial
  // unique index actually constrains.
  const searchablePerGroup = new Map<string, LifecycleAliasRow[]>();
  for (const a of aliases) {
    if (!a.isSearchable || a.textNorm === null) continue;
    const key = groupKey(a.parentId, a.textNorm, a.lang);
    const b = searchablePerGroup.get(key);
    if (b === undefined) searchablePerGroup.set(key, [a]);
    else b.push(a);
  }
  const duplicateWinners = [...searchablePerGroup.values()].filter((g) => g.length > 1).flat();

  const invariants: InvariantResult[] = [
    check(
      "normalized_before_elected",
      "no row is searchable while its text_norm is NULL (it would have no L0 key)",
      aliases.filter((a) => a.isSearchable && a.textNorm === null),
    ),
    check(
      "one_winner_per_group",
      "at most one searchable row per (parent, text_norm, lang) — the partial UNIQUE index",
      duplicateWinners,
    ),
    check(
      "searchable_is_embedded",
      "every searchable row carries a vector, or retrieval returns a row it cannot rank",
      aliases.filter((a) => a.isSearchable && !a.hasEmbedding),
    ),
    check(
      "searchable_parent_exists",
      "no searchable row points at a missing parent",
      aliases.filter((a) => a.isSearchable && !parentById.has(a.parentId)),
    ),
    check(
      "searchable_parent_eligible",
      "no searchable row hangs off an ineligible or shadowed parent",
      aliases.filter((a) => {
        if (!a.isSearchable) return false;
        const p = parentById.get(a.parentId);
        return p !== undefined && (!spec.parentEligible(p) || spec.parentShadowed(p));
      }),
    ),
    check(
      "no_empty_text_norm",
      "text_norm is never the empty string — it would collide with every other empty one",
      aliases.filter((a) => a.textNorm === ""),
    ),
  ];

  return {
    table: spec.table,
    rowsChecked: aliases.length,
    storedElected: aliases.filter((a) => a.isSearchable).length,
    expectedElected: results.filter((r) => r.elected).length,
    mismatches,
    reasonHistogram,
    invariants,
    clean: mismatches.length === 0 && invariants.every((i) => i.passed),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────
// READ-ONLY SQL
// ─────────────────────────────────────────────────────────────────────────────────────

/** Every alias of one table, shaped for the engine. SELECT only. */
export function aliasFetchSql(spec: AliasTableSpec) {
  return spec.table === "job_domain_alias"
    ? dsql`
        SELECT a."id"::text AS id, a."job_domain_id" AS parent_id, a."text" AS text,
               a."text_norm" AS text_norm, a."lang" AS lang,
               (a."embedding" IS NOT NULL) AS has_embedding, a."is_searchable" AS is_searchable
          FROM "job_domain_alias" a ORDER BY a."id"`
    : dsql`
        SELECT a."id"::text AS id, a."skill_id" AS parent_id, a."text" AS text,
               a."text_norm" AS text_norm, a."lang" AS lang,
               (a."embedding" IS NOT NULL) AS has_embedding, a."is_searchable" AS is_searchable
          FROM "skill_alias" a ORDER BY a."id"`;
}

/** Every parent row, including the precomputed shadow test. SELECT only. */
export function parentFetchSql(spec: AliasTableSpec) {
  return spec.table === "job_domain_alias"
    ? dsql`
        SELECT d."job_domain_id" AS id, d."status" AS status, d."selectable" AS selectable,
               d."source" AS source,
               EXISTS (SELECT 1 FROM "job_domain" c
                        WHERE c."parent_job_domain_id" = d."job_domain_id"
                          AND c."selectable" AND c."status" = 'active') AS has_selectable_active_child
          FROM "job_domain" d`
    : dsql`SELECT s."skill_id" AS id, s."status" AS status FROM "skill" s`;
}

/** Coerce a driver row into the engine's alias shape. */
export function toLifecycleAlias(r: Record<string, unknown>): LifecycleAliasRow {
  return {
    id: String(r.id),
    parentId: String(r.parent_id),
    text: String(r.text ?? ""),
    textNorm: r.text_norm === null || r.text_norm === undefined ? null : String(r.text_norm),
    lang: r.lang === null || r.lang === undefined ? null : String(r.lang),
    hasEmbedding: r.has_embedding === true,
    isSearchable: r.is_searchable === true,
  };
}

/** Coerce a driver row into the engine's parent shape. */
export function toLifecycleParent(r: Record<string, unknown>): LifecycleParentRow {
  return {
    id: String(r.id),
    status: r.status === null || r.status === undefined ? null : String(r.status),
    selectable: r.selectable === undefined ? undefined : r.selectable === true,
    source: r.source === null || r.source === undefined ? undefined : String(r.source),
    hasSelectableActiveChild:
      r.has_selectable_active_child === undefined ? undefined : r.has_selectable_active_child === true,
  };
}
