/**
 * Matching V1 — the `@badabhai/taxonomy` seam for the V1 match vocabulary.
 *
 * RECONCILED 2026-07-31. This module was a temporary adapter: the five V1 exports were
 * authored in `packages/taxonomy` by a PARALLEL workstream, so it read them off the
 * taxonomy namespace by name in order to compile before that workstream landed. It has
 * landed. The namespace read and its `readNamespace` cast are GONE, replaced by a plain
 * static import — a missing or renamed export is now a COMPILE error here, which is the
 * only place it can be caught before a seeder runs against production.
 *
 * WHAT SURVIVES, and why it is not ceremony:
 *   * `loadMatchTaxonomy` still exists as the single entry point every script calls, so
 *     the scripts did not have to change and the validator cannot be bypassed.
 *   * `missingMatchTaxonomyExports` / `hasMatchTaxonomy` still exist because an export
 *     can be present at compile time and `undefined` at RUNTIME — a stale `dist/` from a
 *     half-finished build is the ordinary way that happens — and a seeder must fail
 *     loudly at startup rather than write zero rows and report success.
 *   * `validateMatchTaxonomy` is unchanged and is still the gate before every write.
 *
 * NOTHING HERE INVENTS VOCABULARY. There is no fallback corpus, no default relation set,
 * and no guessed id. If the taxonomy is absent the scripts refuse to run.
 */
import {
  ATTRIBUTE_TO_MATCH_SKILLS,
  MATCH_SKILLS,
  MATCH_SKILL_RELATION_PAIRS,
  ROLE_TO_MATCH_SKILL,
  TRADE_TO_MATCH_SKILL,
} from "@badabhai/taxonomy";

/**
 * Provenance / lifecycle of a canonical skill (must match the DB `SkillSource` /
 * `SkillStatus`). Kept as local aliases so `packages/db` states the DB's own contract;
 * they are structurally identical to the taxonomy's `SkillSource` / `SkillStatus`, and
 * the static import above is what proves the two agree.
 */
export type MatchSkillSource = "esco" | "onet" | "nco" | "rvm";
/** Lifecycle (must match the DB `SkillStatus`). */
export type MatchSkillStatus = "active" | "provisional" | "deprecated";

/** Every V1 match-skill id lives in this prefix. Enforced by the D1 validator. */
export const MATCH_SKILL_ID_PREFIX = "mskill_";
/** The launch industry — the DEFAULT the 0052 migration backfills `skill.industry_id` to. */
export const DEFAULT_INDUSTRY_ID = "ind_industrial_manufacturing";
/** The second industry Matching V1 introduces (authored in packages/taxonomy). */
export const QUICK_COMMERCE_INDUSTRY_ID = "ind_quick_commerce";

/**
 * One MATCHABLE unit of work — a `skill` row with kind='match_skill'.
 * `skillId` is immutable and never reused (ADR-0030 SG-5), like every other skill id.
 */
export interface MatchSkillSeed {
  skillId: string; // "mskill_*"
  labelEn: string;
  labelHi?: string | null;
  industryId: string; // "ind_*"
  domainId: string; // skill-domain slug (see SKILL_DOMAINS)
  source: MatchSkillSource;
  status?: MatchSkillStatus; // defaults to 'active' when the corpus omits it
}

/**
 * One UNORDERED adjacency between two match skills. The D1 seeder writes BOTH directed
 * rows into `skill_related`; the pair list must therefore contain each pair ONCE.
 */
export type MatchSkillRelationPair = readonly [string, string];

/** The five V1 exports `packages/db` consumes. */
export interface MatchTaxonomy {
  /** The closed `mskill_*` vocabulary. */
  MATCH_SKILLS: readonly MatchSkillSeed[];
  /** Unordered adjacency pairs — the TIER-2 reach expansion. */
  MATCH_SKILL_RELATION_PAIRS: readonly MatchSkillRelationPair[];
  /** ROLE BRIDGE: `worker_profiles.canonical_role_id` (role_*) → one match skill. */
  ROLE_TO_MATCH_SKILL: Readonly<Record<string, string>>;
  /** ATTRIBUTE BRIDGE: an attribute-kind skill id → the match skills it implies. */
  ATTRIBUTE_TO_MATCH_SKILLS: Readonly<Record<string, readonly string[]>>;
  /** TRADE BRIDGE: a legacy `jobs.trade_key` → one match skill (the D4 cutover). */
  TRADE_TO_MATCH_SKILL: Readonly<Record<string, string>>;
}

/**
 * The five V1 exports, bound STATICALLY. A rename or a deletion in
 * `@badabhai/taxonomy` breaks this line at compile time, which is the whole point of
 * the reconcile: the failure lands in CI, not in a seeder halfway through a run.
 */
const V1_EXPORTS = {
  MATCH_SKILLS,
  MATCH_SKILL_RELATION_PAIRS,
  ROLE_TO_MATCH_SKILL,
  ATTRIBUTE_TO_MATCH_SKILLS,
  TRADE_TO_MATCH_SKILL,
} as const;

/**
 * Which of the five V1 exports are missing at RUNTIME.
 *
 * Compiling is not the same as being loaded: a stale `packages/taxonomy/dist` (the
 * ordinary result of a half-finished build) type-checks against the source but ships
 * `undefined` at import time. A seeder that then writes zero rows and prints success is
 * worse than one that refuses, so the presence check stays.
 */
export function missingMatchTaxonomyExports(): string[] {
  return Object.entries(V1_EXPORTS)
    .filter(([, value]) => value === undefined)
    .map(([name]) => name);
}

/** True when the installed `@badabhai/taxonomy` carries the full V1 vocabulary. */
export function hasMatchTaxonomy(): boolean {
  return missingMatchTaxonomyExports().length === 0;
}

/**
 * Load the V1 vocabulary, or THROW with an actionable message. Fail-closed: a script
 * that cannot see the real vocabulary must not write a partial or invented one.
 */
export function loadMatchTaxonomy(scriptName: string): MatchTaxonomy {
  const missing = missingMatchTaxonomyExports();
  if (missing.length > 0) {
    throw new Error(
      `[${scriptName}] @badabhai/taxonomy loaded without the Matching V1 exports: ` +
        `${missing.join(", ")}.\n` +
        `  These are compiled into packages/taxonomy — an absent one at runtime means a\n` +
        `  STALE dist/. Run \`pnpm build\` and re-run. This script deliberately has NO\n` +
        `  fallback corpus — it will not invent skill ids.`,
    );
  }
  // No casts: the taxonomy's own types satisfy these structurally. If that ever stops
  // being true, this is a compile error rather than a runtime surprise in a seeder.
  return V1_EXPORTS;
}

// ---------------------------------------------------------------------------
// Corpus validation — runs BEFORE any write, in every script that reads the corpus.
// ---------------------------------------------------------------------------

/**
 * Structural problems with the V1 vocabulary. An EMPTY array is the only acceptable
 * result before a write. The relation checks are the DB's missing symmetry trigger
 * (see the `skill_related` comment in schema.ts — symmetry is a seeder + test invariant).
 */
export function validateMatchTaxonomy(t: MatchTaxonomy): string[] {
  const problems: string[] = [];

  if (t.MATCH_SKILLS.length === 0) problems.push("MATCH_SKILLS is empty");

  const ids = new Set<string>();
  for (const s of t.MATCH_SKILLS) {
    if (!s.skillId?.startsWith(MATCH_SKILL_ID_PREFIX)) {
      problems.push(
        `MATCH_SKILLS: "${s.skillId}" is not in the ${MATCH_SKILL_ID_PREFIX}* id space`,
      );
    }
    if (ids.has(s.skillId)) problems.push(`MATCH_SKILLS: duplicate skillId "${s.skillId}"`);
    ids.add(s.skillId);
    if (!s.labelEn) problems.push(`MATCH_SKILLS: "${s.skillId}" has no labelEn`);
    if (!s.industryId?.startsWith("ind_")) {
      problems.push(`MATCH_SKILLS: "${s.skillId}" industryId "${s.industryId}" is not an ind_* id`);
    }
    if (!s.domainId) problems.push(`MATCH_SKILLS: "${s.skillId}" has no domainId`);
  }

  // Relations: no self-pair, both sides must be MATCH skills (never an attribute), and
  // each UNORDERED pair may appear at most once (the seeder writes both directions).
  const seenUnordered = new Set<string>();
  for (const [a, b] of t.MATCH_SKILL_RELATION_PAIRS) {
    if (a === b) {
      problems.push(`MATCH_SKILL_RELATION_PAIRS: self-relation "${a}"`);
      continue;
    }
    if (!ids.has(a)) {
      problems.push(
        `MATCH_SKILL_RELATION_PAIRS: "${a}" is not a match skill (a relation may never ` +
          `reference an attribute-kind id)`,
      );
    }
    if (!ids.has(b)) {
      problems.push(
        `MATCH_SKILL_RELATION_PAIRS: "${b}" is not a match skill (a relation may never ` +
          `reference an attribute-kind id)`,
      );
    }
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seenUnordered.has(key)) {
      problems.push(
        `MATCH_SKILL_RELATION_PAIRS: pair (${a}, ${b}) is listed twice — pairs are ` +
          `UNORDERED and the seeder writes both directions, so listing it twice is a bug`,
      );
    }
    seenUnordered.add(key);
  }

  // Bridges must only ever TARGET match skills; a bridge pointing at an attribute id
  // would silently write an unmatched worker_skill row.
  for (const [roleId, mskill] of Object.entries(t.ROLE_TO_MATCH_SKILL)) {
    if (!ids.has(mskill)) {
      problems.push(`ROLE_TO_MATCH_SKILL["${roleId}"] → "${mskill}" is not a match skill`);
    }
  }
  for (const [attrId, list] of Object.entries(t.ATTRIBUTE_TO_MATCH_SKILLS)) {
    for (const mskill of list) {
      if (!ids.has(mskill)) {
        problems.push(`ATTRIBUTE_TO_MATCH_SKILLS["${attrId}"] → "${mskill}" is not a match skill`);
      }
    }
  }
  for (const [tradeKey, mskill] of Object.entries(t.TRADE_TO_MATCH_SKILL)) {
    if (!ids.has(mskill)) {
      problems.push(`TRADE_TO_MATCH_SKILL["${tradeKey}"] → "${mskill}" is not a match skill`);
    }
  }

  return problems;
}

/** Expand an unordered pair list into the two DIRECTED rows `skill_related` stores. */
export function directedRelationRows(
  pairs: readonly MatchSkillRelationPair[],
): { skillId: string; relatedSkillId: string }[] {
  const rows: { skillId: string; relatedSkillId: string }[] = [];
  for (const [a, b] of pairs) {
    rows.push({ skillId: a, relatedSkillId: b });
    rows.push({ skillId: b, relatedSkillId: a });
  }
  return rows;
}
