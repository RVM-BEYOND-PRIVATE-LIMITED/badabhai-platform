/**
 * Matching V1 — the `@badabhai/taxonomy` seam for the V1 match vocabulary.
 *
 * ⚠️ TEMPORARY ADAPTER, DELETE-ON-RECONCILE. The five V1 exports below are authored in
 * `packages/taxonomy` by a PARALLEL workstream and did not exist in this worktree when
 * the migration train was written. This module reads them off the taxonomy namespace by
 * their EXACT names, so:
 *   * the data scripts are written against the real API, not a local fork;
 *   * `packages/db` compiles TODAY, before that workstream lands;
 *   * the moment it lands, every script works with no edit;
 *   * until it lands, any script that needs them fails LOUDLY at startup with the exact
 *     list of missing exports — never silently, and never with a fabricated fallback.
 *
 * RECONCILE AT MERGE: once `@badabhai/taxonomy` exports all five, replace the namespace
 * read in `loadMatchTaxonomy` with a plain static import and delete `readNamespace`. The
 * exported TYPES below should then be replaced by the taxonomy package's own.
 *
 * NOTHING HERE INVENTS VOCABULARY. There is no fallback corpus, no default relation set,
 * and no guessed id. If the taxonomy is absent the scripts refuse to run.
 */
import * as taxonomyNamespace from "@badabhai/taxonomy";

/** Provenance of a canonical skill (must match the DB `SkillSource`). */
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

const REQUIRED_EXPORTS = [
  "MATCH_SKILLS",
  "MATCH_SKILL_RELATION_PAIRS",
  "ROLE_TO_MATCH_SKILL",
  "ATTRIBUTE_TO_MATCH_SKILLS",
  "TRADE_TO_MATCH_SKILL",
] as const;

/**
 * Read the namespace as an untyped record. The cast is the whole point of this module:
 * it is what lets `packages/db` name exports that its build-time copy of
 * `@badabhai/taxonomy` may not have yet. It is NEVER used to fabricate a value — every
 * caller goes through the presence check below.
 */
function readNamespace(): Record<string, unknown> {
  return taxonomyNamespace as unknown as Record<string, unknown>;
}

/** Which of the five V1 exports are missing from the installed taxonomy build. */
export function missingMatchTaxonomyExports(): string[] {
  const ns = readNamespace();
  return REQUIRED_EXPORTS.filter((name) => ns[name] === undefined);
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
      `[${scriptName}] @badabhai/taxonomy is missing the Matching V1 exports: ` +
        `${missing.join(", ")}.\n` +
        `  The V1 match vocabulary is authored in packages/taxonomy by the parallel\n` +
        `  Matching-V1 workstream. Build it first (\`pnpm build\`) and re-run. This script\n` +
        `  deliberately has NO fallback corpus — it will not invent skill ids.`,
    );
  }
  const ns = readNamespace();
  return {
    MATCH_SKILLS: ns.MATCH_SKILLS as readonly MatchSkillSeed[],
    MATCH_SKILL_RELATION_PAIRS: ns.MATCH_SKILL_RELATION_PAIRS as readonly MatchSkillRelationPair[],
    ROLE_TO_MATCH_SKILL: ns.ROLE_TO_MATCH_SKILL as Readonly<Record<string, string>>,
    ATTRIBUTE_TO_MATCH_SKILLS: ns.ATTRIBUTE_TO_MATCH_SKILLS as Readonly<
      Record<string, readonly string[]>
    >,
    TRADE_TO_MATCH_SKILL: ns.TRADE_TO_MATCH_SKILL as Readonly<Record<string, string>>,
  };
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
