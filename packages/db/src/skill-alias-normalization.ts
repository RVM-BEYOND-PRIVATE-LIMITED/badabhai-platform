/**
 * `skill_alias` normalization PLANNER — the pure half of `normalize-skill-aliases.ts`.
 *
 * Everything here is a function of the rows it is handed. No database, no I/O, no clock,
 * so every classification below is unit-testable and the runner stays a thin transport.
 *
 * ── WHY THIS TABLE NEEDS ITS OWN RUNNER ──
 *
 * `db:normalize:aliases` (migration 0067) fills `text_norm` and elects `is_searchable`
 * for `job_domain_alias` ONLY. `skill_alias` gained the same two columns in 0076 and has
 * never had a runner, so on the live corpus 131 of 328 rows still carry `text_norm IS
 * NULL` — and, because `is_searchable` defaults to false and nothing maintains it, those
 * same 131 are non-searchable. 98 of them are the Gate B active-catalogue aliases: every
 * alias of every `active` skill. Measured, 2026-08-18:
 *
 *     status       text_norm  embedded  is_searchable   rows
 *     provisional  filled     yes       true             197
 *     active       NULL       yes       false             98   <- the whole active catalogue
 *     provisional  NULL       no        false             33
 *
 * That is why `AND sa.is_searchable` cannot be added to the skill-alias retrieval paths
 * yet: it would hide all 98 and make all 30 active skills unreachable, with a green build.
 * See `retrievalPredicateReadiness` at the bottom of this file — the invariant that turns
 * that hazard from a comment into a check.
 *
 * ── ONE NORMALIZER, NOT TWO ──
 *
 * `normalizeOccupationText` from `@badabhai/profiling-lexicon` is called directly. There is
 * deliberately no wrapper and no re-implementation: the query path calls that same
 * function, and a second definition here would drift silently — L0 would simply stop
 * matching and every profiling turn would fall through to a paid embedding. The domain
 * runner documents the same rule at `normalize-job-domain-aliases.ts:10-14`.
 *
 * ── WHAT THE PLAN DELIBERATELY DOES NOT DO ──
 *
 * It never elects `is_searchable`, unlike the domain runner. Electing a representative is
 * a separate, explicitly gated step: on the domain side the flag also encodes bucket rows
 * and ISCO shadowing, and getting it wrong there costs recall; here it decides whether the
 * active catalogue is retrievable at all. Normalization is the reversible half and ships
 * first. `uniqueKeyConflicts` below is precisely the input that election will need.
 *
 * PRIVACY: the reference catalogue only — skill ids and alias text from a curated
 * taxonomy, never worker data. Callers still print ids and counts, never `text`.
 */
import { normalizeOccupationText } from "@badabhai/profiling-lexicon";

/** One `skill_alias` row, joined to its skill's status. The planner's only input. */
export interface SkillAliasNormalizationRow {
  readonly id: string;
  readonly skillId: string;
  readonly text: string;
  /** NULL means "not normalized yet" — the runner's resumability predicate. */
  readonly textNorm: string | null;
  readonly lang: string | null;
  /** `skill.status` — `active` rows are the retrieval-visible catalogue. */
  readonly skillStatus: string;
  readonly isSearchable: boolean;
  readonly hasEmbedding: boolean;
}

/** A row whose `text_norm` is NULL and whose normalized form is writable. */
export interface PlannedWrite {
  readonly id: string;
  readonly skillId: string;
  readonly textNorm: string;
}

/**
 * A row that ALREADY has `text_norm`, but recomputing it today gives something else.
 *
 * Never written by this runner. Rewriting a populated `text_norm` would move the L0 key of
 * a row that may already be searchable and may already be somebody's exact-match target,
 * and on a searchable row it can collide under `skill_alias_skill_norm_lang_uq` mid-pass.
 * Drift is reported so a human can decide; the domain side's `--renormalize` is the
 * deliberate escape hatch, and it is not offered here until the corpus has one.
 */
export interface NormalizationDrift {
  readonly id: string;
  readonly skillId: string;
  readonly stored: string;
  readonly recomputed: string;
}

/**
 * Two or more rows of the SAME skill that share `(text_norm, lang)`.
 *
 * This is the shape `skill_alias_skill_norm_lang_uq UNIQUE (skill_id, text_norm, lang)
 * NULLS NOT DISTINCT WHERE is_searchable` rejects — but only among rows that are actually
 * searchable, which is why `searchableIds` is reported separately from `ids`. A group with
 * 4 members and 1 searchable member is legal today and is exactly what duplicate election
 * produces; a group with 2 searchable members would already be a violated index.
 */
export interface UniqueKeyConflict {
  readonly skillId: string;
  readonly textNorm: string;
  readonly lang: string | null;
  readonly ids: readonly string[];
  readonly searchableIds: readonly string[];
}

/**
 * Two or more rows of DIFFERENT skills that share `(text_norm, lang)`.
 *
 * NOT a constraint violation — the unique index is partitioned by `skill_id`, so Postgres
 * accepts these. It is a RETRIEVAL hazard: L0 is an exact-equality probe on `text_norm`, so
 * a collision means one normalized phrase resolves to two skills with nothing to rank them.
 * Reported, never auto-resolved: which skill should own a shared surface form is a taxonomy
 * decision, not a normalizer's.
 */
export interface CrossSkillCollision {
  readonly textNorm: string;
  readonly lang: string | null;
  readonly skillIds: readonly string[];
  readonly ids: readonly string[];
}

/** Per-`skill.status` counts, so the active catalogue is never averaged into the total. */
export interface StatusBreakdown {
  readonly rows: number;
  readonly alreadyNormalized: number;
  readonly newlyDerivable: number;
  readonly normalizesToEmpty: number;
  readonly embedded: number;
  readonly searchable: number;
}

export interface SkillAliasNormalizationPlan {
  readonly totalRows: number;
  readonly alreadyNormalized: number;
  readonly missingTextNorm: number;
  /** The only rows this runner writes, and it writes only their `text_norm`. */
  readonly writes: readonly PlannedWrite[];
  /**
   * Rows whose normalized form is `""`. Unwritable: an empty `text_norm` collides with
   * every other empty one under the unique index's `NULLS NOT DISTINCT`. They stay NULL
   * and are re-attempted on a later run, exactly as the domain runner treats them.
   * `normalizeOccupationText` only returns empty for input with no kept character at all,
   * so any hit here is a corpus defect worth surfacing rather than normalizing away.
   */
  readonly normalizesToEmpty: readonly string[];
  readonly drift: readonly NormalizationDrift[];
  readonly uniqueKeyConflicts: readonly UniqueKeyConflict[];
  readonly crossSkillCollisions: readonly CrossSkillCollision[];
  readonly byStatus: Readonly<Record<string, StatusBreakdown>>;
}

/**
 * The grouping key, reproducing the unique index's `NULLS NOT DISTINCT` semantics.
 *
 * JSON, not a delimiter-joined string: `lang` is nullable, and every separator character
 * that could distinguish `null` from the literal `"null"` is a character that can legally
 * appear in `text_norm` (the normalizer keeps intra-word `-` and `/`). A previous key
 * builder in this package used `\0` as a separator, which made the source file read as
 * binary to grep and every lookup miss in silence. JSON has neither problem.
 */
function groupKey(parts: readonly (string | null)[]): string {
  return JSON.stringify(parts);
}

/**
 * What `text_norm` this row WILL have once the plan is applied.
 *
 * Populated rows keep their stored value even when it drifts — collision detection must
 * describe the post-apply table, and this runner does not rewrite populated rows.
 */
function effectiveTextNorm(row: SkillAliasNormalizationRow): string | null {
  if (row.textNorm !== null) return row.textNorm;
  const recomputed = normalizeOccupationText(row.text);
  return recomputed.length > 0 ? recomputed : null;
}

const EMPTY_BREAKDOWN: StatusBreakdown = {
  rows: 0,
  alreadyNormalized: 0,
  newlyDerivable: 0,
  normalizesToEmpty: 0,
  embedded: 0,
  searchable: 0,
};

/**
 * Classify every row. Pure, deterministic and order-independent in its counts; the arrays
 * preserve input order so a caller that sorted by id gets a stable, diffable plan.
 *
 * IDEMPOTENT BY CONSTRUCTION: `writes` is derived from `textNorm === null`, so applying a
 * plan and re-planning the same corpus yields `writes: []`. There is no other mutation to
 * be idempotent about.
 */
export function planSkillAliasNormalization(
  rows: readonly SkillAliasNormalizationRow[],
): SkillAliasNormalizationPlan {
  const writes: PlannedWrite[] = [];
  const normalizesToEmpty: string[] = [];
  const drift: NormalizationDrift[] = [];
  const byStatus = new Map<string, StatusBreakdown>();

  const bump = (status: string, patch: Partial<StatusBreakdown>): void => {
    const cur = byStatus.get(status) ?? EMPTY_BREAKDOWN;
    byStatus.set(status, {
      rows: cur.rows + (patch.rows ?? 0),
      alreadyNormalized: cur.alreadyNormalized + (patch.alreadyNormalized ?? 0),
      newlyDerivable: cur.newlyDerivable + (patch.newlyDerivable ?? 0),
      normalizesToEmpty: cur.normalizesToEmpty + (patch.normalizesToEmpty ?? 0),
      embedded: cur.embedded + (patch.embedded ?? 0),
      searchable: cur.searchable + (patch.searchable ?? 0),
    });
  };

  for (const row of rows) {
    const recomputed = normalizeOccupationText(row.text);

    bump(row.skillStatus, {
      rows: 1,
      embedded: row.hasEmbedding ? 1 : 0,
      searchable: row.isSearchable ? 1 : 0,
    });

    if (row.textNorm !== null) {
      bump(row.skillStatus, { alreadyNormalized: 1 });
      if (recomputed !== row.textNorm) {
        drift.push({
          id: row.id,
          skillId: row.skillId,
          stored: row.textNorm,
          recomputed,
        });
      }
      continue;
    }

    if (recomputed.length === 0) {
      normalizesToEmpty.push(row.id);
      bump(row.skillStatus, { normalizesToEmpty: 1 });
      continue;
    }

    writes.push({ id: row.id, skillId: row.skillId, textNorm: recomputed });
    bump(row.skillStatus, { newlyDerivable: 1 });
  }

  return {
    totalRows: rows.length,
    alreadyNormalized: rows.filter((r) => r.textNorm !== null).length,
    missingTextNorm: rows.filter((r) => r.textNorm === null).length,
    writes,
    normalizesToEmpty,
    drift,
    uniqueKeyConflicts: findUniqueKeyConflicts(rows),
    crossSkillCollisions: findCrossSkillCollisions(rows),
    byStatus: Object.fromEntries(byStatus),
  };
}

/** Groups of same-skill rows sharing `(text_norm, lang)` AFTER the plan is applied. */
export function findUniqueKeyConflicts(
  rows: readonly SkillAliasNormalizationRow[],
): UniqueKeyConflict[] {
  const groups = new Map<string, SkillAliasNormalizationRow[]>();

  for (const row of rows) {
    const norm = effectiveTextNorm(row);
    if (norm === null) continue; // an un-normalizable row is outside the partial index
    const key = groupKey([row.skillId, norm, row.lang]);
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [row]);
    else bucket.push(row);
  }

  const out: UniqueKeyConflict[] = [];
  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue;
    const head = bucket[0];
    if (head === undefined) continue;
    out.push({
      skillId: head.skillId,
      textNorm: effectiveTextNorm(head) ?? "",
      lang: head.lang,
      ids: bucket.map((r) => r.id),
      searchableIds: bucket.filter((r) => r.isSearchable).map((r) => r.id),
    });
  }
  return out;
}

/** Groups of DIFFERENT-skill rows sharing `(text_norm, lang)` AFTER the plan is applied. */
export function findCrossSkillCollisions(
  rows: readonly SkillAliasNormalizationRow[],
): CrossSkillCollision[] {
  const groups = new Map<string, SkillAliasNormalizationRow[]>();

  for (const row of rows) {
    const norm = effectiveTextNorm(row);
    if (norm === null) continue;
    const key = groupKey([norm, row.lang]);
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [row]);
    else bucket.push(row);
  }

  const out: CrossSkillCollision[] = [];
  for (const bucket of groups.values()) {
    const skillIds = [...new Set(bucket.map((r) => r.skillId))];
    if (skillIds.length < 2) continue; // same-skill duplicates are `UniqueKeyConflict`
    const head = bucket[0];
    if (head === undefined) continue;
    out.push({
      textNorm: effectiveTextNorm(head) ?? "",
      lang: head.lang,
      skillIds,
      ids: bucket.map((r) => r.id),
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────
// ELECTION PROJECTION — what election WOULD do, computed without doing it
// ─────────────────────────────────────────────────────────────────────────────────────

/** Which of a `(skill_id, text_norm, lang)` group would survive election. */
export type ElectionOutcome = "winner" | "loser";

/**
 * How a row relates to others sharing its normalized form. Precedence matters: a row can
 * be BOTH a same-skill duplicate and part of a cross-skill collision, and the same-skill
 * relation is reported because that is the one the unique index acts on.
 */
export type DuplicateClassification = "unique" | "same_skill_duplicate" | "cross_skill_collision";

export interface ElectionProjectionRow {
  readonly id: string;
  readonly election: ElectionOutcome;
  readonly duplicateClassification: DuplicateClassification;
}

/**
 * Project the duplicate election WITHOUT performing it.
 *
 * Mirrors the ranked CTE in `normalize-skill-aliases.ts`: an embedded row wins (never
 * strand paid work), then the shortest raw text, then the lowest id. `lang` NULLs group as
 * equal, matching the index's `NULLS NOT DISTINCT`.
 *
 * WHY THE TIE-BREAK DIFFERS FROM `seed-domain-skills.ts`. That seeder elects among rows it
 * is about to INSERT from a corpus file, and its docstring explains it has no embedding
 * tier because `deterministicAliasId` hashes the raw text — so an existing embedded row IS
 * the planned row, not a rival. Here the rows already exist and were embedded by separate
 * runs, so an embedded rival is real and outranking it would strand paid work. Same
 * ordering as `normalize-job-domain-aliases.ts`, which faces the same situation.
 *
 * Length is counted in CODE POINTS, not UTF-16 units, because the SQL tie-break uses
 * Postgres `length()`, which counts characters. Identical for the Devanagari and Latin in
 * this corpus (all BMP), and pinned so a future non-BMP alias cannot make the projection
 * disagree with the statement it is predicting.
 */
export function projectElection(
  rows: readonly SkillAliasNormalizationRow[],
): ElectionProjectionRow[] {
  const bySkillGroup = new Map<string, SkillAliasNormalizationRow[]>();
  const byNormGroup = new Map<string, Set<string>>();

  for (const r of rows) {
    const norm = effectiveTextNorm(r);
    if (norm === null) continue;
    const sk = groupKey([r.skillId, norm, r.lang]);
    const bucket = bySkillGroup.get(sk);
    if (bucket === undefined) bySkillGroup.set(sk, [r]);
    else bucket.push(r);

    const nk = groupKey([norm, r.lang]);
    const skills = byNormGroup.get(nk);
    if (skills === undefined) byNormGroup.set(nk, new Set([r.skillId]));
    else skills.add(r.skillId);
  }

  const winners = new Set<string>();
  for (const bucket of bySkillGroup.values()) {
    const ranked = [...bucket].sort(
      (a, b) =>
        Number(b.hasEmbedding) - Number(a.hasEmbedding) ||
        [...a.text].length - [...b.text].length ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const top = ranked[0];
    if (top !== undefined) winners.add(top.id);
  }

  const out: ElectionProjectionRow[] = [];
  for (const r of rows) {
    const norm = effectiveTextNorm(r);
    if (norm === null) continue;
    const sameSkill = bySkillGroup.get(groupKey([r.skillId, norm, r.lang]))?.length ?? 1;
    const skillsSharingNorm = byNormGroup.get(groupKey([norm, r.lang]))?.size ?? 1;
    out.push({
      id: r.id,
      election: winners.has(r.id) ? "winner" : "loser",
      duplicateClassification:
        sameSkill > 1
          ? "same_skill_duplicate"
          : skillsSharingNorm > 1
            ? "cross_skill_collision"
            : "unique",
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────
// THE RETRIEVAL-PREDICATE INVARIANT
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Why a row is allowed to be invisible. Every value is a RECORDED claim from an election
 * decision manifest — never something derived from the table's own contents.
 */
export type AliasVisibilityDecision = "elected" | "intentionally_demoted" | "duplicate_loser";

export interface PredicateReadiness {
  /** True when none of the three blocker lists below is populated. */
  readonly safe: boolean;
  /**
   * BLOCKER 1 — never processed. `active` + embedded + not searchable + `text_norm IS NULL`.
   *
   * Adding `AND sa.is_searchable` while this is non-empty removes a live, paid-for vector
   * from retrieval for a reason nobody chose. On 2026-08-18 this set was all 98
   * active-catalogue aliases; after the normalization write it is empty.
   */
  readonly hiddenByMissingNormalization: readonly string[];
  /**
   * BLOCKER 2 — hidden, and no decision record says why.
   *
   * THIS CATEGORY EXISTS BECAUSE THE FIRST DRAFT OF THIS CHECK WAS WRONG, TWICE.
   *
   * Draft one treated any populated `text_norm` as proof of intent, so the rolled-back
   * rehearsal reported SAFE at the exact midpoint where all 98 active aliases were
   * normalized and none had been elected — the same total blackout, one step later.
   *
   * Draft two fixed that but still inferred safety for a "losing duplicate" whenever some
   * sibling row happened to be searchable. That is inference from table state again, just
   * a subtler kind: it answers "is this form reachable?" when the question is "did anyone
   * DECIDE this row should be invisible?". A group whose winner was elected by accident,
   * or by a half-finished pass, reads identically.
   *
   * So nothing in the table counts as evidence. `text_norm IS NOT NULL` never does, and
   * neither does a searchable sibling. Every hidden active embedded alias must be NAMED in
   * `decisions`, and absent that this fails closed.
   */
  readonly hiddenWithoutDecision: readonly string[];
  /**
   * BLOCKER 3 — the record and the table disagree.
   *
   * A row recorded `elected` that is not searchable, or recorded hidden that is. Blocking
   * on the second case is deliberate even though nothing is hidden by omission there: a
   * decision record that misdescribes the rows it covers cannot be trusted about the rows
   * it claims are safely hidden either. Fail closed (CLAUDE.md §3).
   */
  readonly contradictedDecisions: readonly string[];
  /** Fine — hidden, and a decision record says exactly why. Grouped by reason. */
  readonly hiddenByRecordedDecision: Readonly<Record<AliasVisibilityDecision, readonly string[]>>;
}

export interface PredicateReadinessOptions {
  /**
   * The election decision manifest, as `alias_id -> reason`. Supplied by the caller
   * because visibility is a taxonomy decision, and deliberately never inferred.
   */
  readonly decisions?: Readonly<Record<string, AliasVisibilityDecision>>;
}

/**
 * May `AND sa.is_searchable` be added to the skill-alias retrieval paths yet?
 *
 * The question the flag cannot answer about itself. `is_searchable` on `skill_alias` is an
 * UNMAINTAINED materialized projection: it defaults to false and, until this runner and
 * its election step have both run, false means "not processed" far more often than it
 * means "excluded". A predicate over it is only meaningful once that stops being true —
 * and "once" means after election, not after normalization.
 */
export function retrievalPredicateReadiness(
  rows: readonly SkillAliasNormalizationRow[],
  options: PredicateReadinessOptions = {},
): PredicateReadiness {
  const decisions = options.decisions ?? {};

  const hiddenByMissingNormalization: string[] = [];
  const hiddenWithoutDecision: string[] = [];
  const contradictedDecisions: string[] = [];
  const byReason: Record<AliasVisibilityDecision, string[]> = {
    elected: [],
    intentionally_demoted: [],
    duplicate_loser: [],
  };

  for (const r of rows) {
    if (r.skillStatus !== "active" || !r.hasEmbedding) continue;
    const decision = Object.prototype.hasOwnProperty.call(decisions, r.id)
      ? decisions[r.id]
      : undefined;

    if (r.isSearchable) {
      // Visible. Only a record claiming it is hidden is a problem.
      if (decision !== undefined && decision !== "elected") contradictedDecisions.push(r.id);
      continue;
    }

    if (r.textNorm === null) {
      hiddenByMissingNormalization.push(r.id);
    } else if (decision === undefined) {
      hiddenWithoutDecision.push(r.id);
    } else if (decision === "elected") {
      contradictedDecisions.push(r.id); // record says elected, table says hidden
    } else {
      byReason[decision].push(r.id);
    }
  }

  return {
    safe:
      hiddenByMissingNormalization.length === 0 &&
      hiddenWithoutDecision.length === 0 &&
      contradictedDecisions.length === 0,
    hiddenByMissingNormalization,
    hiddenWithoutDecision,
    contradictedDecisions,
    hiddenByRecordedDecision: byReason,
  };
}

/** Fail-closed form of {@link retrievalPredicateReadiness}, for a runner or a gate. */
export function assertRetrievalPredicateSafe(
  rows: readonly SkillAliasNormalizationRow[],
  options: PredicateReadinessOptions = {},
): void {
  const r = retrievalPredicateReadiness(rows, options);
  if (r.safe) return;
  throw new Error(
    "Refusing the skill-alias retrieval predicate: " +
      `${r.hiddenByMissingNormalization.length} active embedded alias(es) were never normalized, ` +
      `${r.hiddenWithoutDecision.length} are hidden with no decision record naming them, and ` +
      `${r.contradictedDecisions.length} contradict the record. Nothing in the table counts as ` +
      "evidence of election — not text_norm, not a searchable sibling. Run the election, record " +
      "every hidden active embedded alias in the decision manifest, then re-check.",
  );
}
