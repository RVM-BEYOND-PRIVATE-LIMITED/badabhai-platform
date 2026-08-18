/**
 * The shared LEXICAL EVIDENCE layer for the taxonomy reuse + convergence detectors.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * `taxonomy-reuse-analysis.ts` and `taxonomy-convergence.ts` ask the same three lexical
 * questions of two skills ("is this the same normalized label?", "do these share a surface
 * form a worker could type?", "is one label a strict token-subset of the other?"). Two
 * copies of those answers would drift, and the copy that drifts is the one whose detector
 * silently stops firing — which is the exact failure both detectors exist to catch. So the
 * primitives live here once and both consume them.
 *
 * It is NOT a second definition of validity. `validateTaxonomyCorpus` decides what may be
 * SEEDED; nothing in this file rejects anything. This file only turns two records into
 * *evidence about their relationship*, which the detectors then grade.
 *
 * ---------------------------------------------------------------------------
 * ONE NORMALIZER, NEVER TWO
 * ---------------------------------------------------------------------------
 * Every string that enters here goes through `normalizeOccupationText` — the SAME function
 * the retrieval path, `skill_alias.text_norm` and `validateTaxonomyCorpus` call. That is
 * non-negotiable: a detector that decided "these two labels are equal" under different
 * rules than the ones the database and the canonicalizer use would be answering a question
 * nobody asked. If the normalizer changes, these detectors change with it, for free.
 *
 * TOKENIZATION is the one thing added on top, and it is a read of the normalizer's output,
 * not a rewrite of it. `normalizeOccupationText` deliberately KEEPS `-` and `/` inside a
 * word ("cnc operator-turning", "oxy-fuel cutting") because they are part of the surface
 * string a worker types. For an OVERLAP measure they are separators: "CNC Operator-Turning"
 * has to share the token `turning` with "Turning (lathe operation)" or the whole
 * starting-corpus report reads zero. Splitting on them here changes nothing about what is
 * stored or matched.
 *
 * UNINFORMATIVE TOKENS are `GENERIC_SKILL_STOPLIST`, imported from `taxonomy-corpus.ts`
 * rather than restated. That list already encodes "words that carry no trade information"
 * ("work", "machine", "quality", "operation", …) and is the reason the validator flags a
 * single-word generic skill. Overlap on `machine` is not evidence of anything; overlap on
 * `fanuc` is. Reusing the list means the two ideas cannot drift apart.
 *
 * PRIVACY: trade vocabulary and published occupation ids only. Same construction argument
 * as the corpus itself — nothing here can read a worker row.
 */
import { normalizeOccupationText } from "@badabhai/profiling-lexicon";
import { SKILL_CORPUS } from "@badabhai/taxonomy";

import {
  GENERIC_SKILL_STOPLIST,
  taxonomyTokens,
  type TaxonomySkillRecord,
} from "./taxonomy-corpus";

// ===========================================================================
// Tokens
// ===========================================================================

/**
 * Re-exported, NOT redefined. `taxonomyTokens` lives in `taxonomy-corpus.ts` so the validator
 * and this file cannot drift — they did, and the divergence let an all-generic label slip
 * every check in the pipeline. See the docblock there.
 */
export { taxonomyTokens };

/** `normalizeOccupationText` + {@link taxonomyTokens}. The only way text enters this file. */
export function normalizedTokens(text: string): string[] {
  return taxonomyTokens(normalizeOccupationText(text));
}

/** Tokens that carry no trade information. See the header — this is `GENERIC_SKILL_STOPLIST`. */
const UNINFORMATIVE: ReadonlySet<string> = new Set(GENERIC_SKILL_STOPLIST);

/** True when a token is in `GENERIC_SKILL_STOPLIST` and therefore worthless as evidence. */
export function isUninformativeToken(token: string): boolean {
  return UNINFORMATIVE.has(token);
}

/** The tokens of `text` that actually carry trade meaning. MAY BE EMPTY (e.g. "machine work"). */
export function informativeTokens(text: string): Set<string> {
  return new Set(normalizedTokens(text).filter((t) => !UNINFORMATIVE.has(t)));
}

/** |A ∩ B| / |A ∪ B|, with 0 for two empty sets rather than NaN. */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** The members of `a` that are also in `b`, sorted — for a readable evidence string. */
export function sharedTokens(a: ReadonlySet<string>, b: ReadonlySet<string>): string[] {
  return [...a].filter((t) => b.has(t)).sort();
}

// ===========================================================================
// The surface of one skill
// ===========================================================================

/**
 * Everything about one skill that the detectors are allowed to reason over.
 *
 * `surface_norms` is the union of the canonical label and every alias, normalized — i.e.
 * EVERY STRING THAT IS SUPPOSED TO LAND ON THIS SKILL. Two skills sharing one of these is
 * not a stylistic coincidence: it is the exact condition that makes canonicalization a coin
 * flip, which is why `validateTaxonomyCorpus` has ALIAS_AMBIGUOUS at all.
 *
 * `label_tokens` (informative, label only) and `all_tokens` (informative, every surface
 * form) are kept SEPARATE on purpose. The subset/overlap relations are defined by the brief
 * over LABELS — "one label being a strict token-subset of the other" — while a concept
 * probe has to be able to reach a skill through an alias. Collapsing them would make a
 * skill with many aliases equivalent to everything.
 */
export interface SkillSurface {
  skill_id: string;
  label_en: string;
  /** `normalizeOccupationText(label_en)`. */
  label_norm: string;
  /** Normalized label + every normalized alias, deduped and sorted. */
  surface_norms: string[];
  /** Informative tokens of the LABEL. */
  label_tokens: Set<string>;
  /** Informative tokens across every surface form. */
  all_tokens: Set<string>;
}

/** Build a surface from a label + its alias texts. The one constructor; everything else wraps it. */
export function buildSkillSurface(
  skillId: string,
  labelEn: string,
  aliasTexts: readonly string[],
): SkillSurface {
  const labelNorm = normalizeOccupationText(labelEn);
  const norms = new Set<string>();
  if (labelNorm.length > 0) norms.add(labelNorm);
  const all = new Set<string>(informativeTokens(labelEn));
  for (const text of aliasTexts) {
    const norm = normalizeOccupationText(text);
    if (norm.length === 0) continue;
    norms.add(norm);
    for (const t of informativeTokens(text)) all.add(t);
  }
  return {
    skill_id: skillId,
    label_en: labelEn,
    label_norm: labelNorm,
    surface_norms: [...norms].sort(),
    label_tokens: informativeTokens(labelEn),
    all_tokens: all,
  };
}

/** A corpus record -> its surface. */
export function surfaceOfCorpusSkill(record: TaxonomySkillRecord): SkillSurface {
  const aliases = Array.isArray(record.aliases) ? record.aliases : [];
  return buildSkillSurface(
    record.skill_id,
    typeof record.label_en === "string" ? record.label_en : "",
    aliases.map((a) => (typeof a?.text === "string" ? a.text : "")).filter((t) => t.length > 0),
  );
}

// ===========================================================================
// The SHIPPED vocabulary, imported READ-ONLY
// ===========================================================================

/**
 * The read-only view of a shipped `SKILL_CORPUS` skill these detectors need.
 *
 * A view rather than the `SkillSeed` itself so a test can inject a synthetic shipped
 * vocabulary and prove a detector fires without depending on which ids happen to be in the
 * corpus this month — the same argument `ValidateTaxonomyCorpusOptions.existingSkillIds`
 * makes, for the same reason.
 */
export interface ShippedSkillView {
  skill_id: string;
  label_en: string;
  aliases: readonly string[];
}

/**
 * Every shipped skill a new corpus skill COULD have reused, as a view.
 *
 * DEPRECATED SKILLS ARE EXCLUDED, exactly as `skillCatalogue` excludes them: a "missed
 * reuse" that names a retired id is not a missed reuse, it is a worse mistake being
 * recommended. `SKILL_CORPUS` is imported READ-ONLY and never grown (see the taxonomy-corpus
 * header).
 */
export function shippedSkillViews(): ShippedSkillView[] {
  return SKILL_CORPUS.filter((s) => s.status !== "deprecated").map((s) => ({
    skill_id: s.skillId,
    label_en: s.labelEn,
    aliases: s.aliases.map((a) => a.text),
  }));
}

/** A shipped view -> its surface. */
export function surfaceOfShippedSkill(view: ShippedSkillView): SkillSurface {
  return buildSkillSurface(view.skill_id, view.label_en, view.aliases);
}

// ===========================================================================
// Equivalence evidence
// ===========================================================================

/**
 * How far apart two labels may be and still count as one concept by STRICT evidence.
 *
 * "Fanuc CNC" vs "Fanuc CNC Control" is one extra token and is the fragmentation this whole
 * exercise is about. "Welding" vs "Underwater Pipeline Welding Certification" is three, and
 * calling those one concept is a false accusation — the second is plainly a narrower,
 * genuinely different skill. Two is the line: it admits a qualifier and a noun, and refuses
 * a re-specification.
 */
export const MAX_SUBSET_EXTRA_TOKENS = 2;

/**
 * The "worth looking at, not provable" band. Half the informative tokens shared, with no
 * strict relation, is enough for a human to glance at and nowhere near enough to assert.
 */
export const WEAK_OVERLAP_MIN_JACCARD = 0.5;

/**
 * How many informative tokens two labels must carry before an IDENTICAL token set counts as
 * strong evidence.
 *
 * TWO. With two or more, "Lathe Turning" and "Turning (lathe operation)" differ only in word
 * order and in filler the stoplist already calls worthless, and treating them as one concept
 * is right. With ONE, the same rule would equate "Welding machine" (a thing) with "Machine
 * welding" (a process) purely because `machine` is generic — a real distinction destroyed by
 * an over-eager rule. A single-token overlap falls through to the weak band instead, where a
 * human decides.
 */
export const MIN_TOKENS_FOR_SET_EQUALITY = 2;

/** The relation that fired, as a stable machine-readable name. Reported, counted, asserted on. */
export type EquivalenceRelation =
  /** Both labels normalize to the same string. */
  | "normalized_label_equal"
  /** A label-or-alias of one is a label-or-alias of the other. */
  | "surface_form_shared"
  /** Same informative tokens in a different order / with different filler. */
  | "informative_tokens_equal"
  /** One label's informative tokens are a strict subset of the other's, within the cap. */
  | "strict_token_subset"
  /** Neither of the above, but the labels share at least half their informative tokens. */
  | "high_token_overlap";

export interface EquivalenceEvidence {
  relation: EquivalenceRelation;
  /**
   * `strong` may be asserted on; `weak` may only be escalated to a human.
   *
   * This split is the whole discipline of both detectors. An over-eager confident finding
   * is a false accusation, and a reviewer who is wrong-footed twice stops reading the
   * report — at which point the real findings are invisible too.
   */
  strength: "strong" | "weak";
  /** Human-readable, for the evidence line. Never parsed. */
  detail: string;
}

/** True when `sub` is a non-empty strict subset of `sup` within {@link MAX_SUBSET_EXTRA_TOKENS}. */
function isBoundedStrictSubset(sub: ReadonlySet<string>, sup: ReadonlySet<string>): boolean {
  if (sub.size === 0 || sub.size >= sup.size) return false;
  if (sup.size - sub.size > MAX_SUBSET_EXTRA_TOKENS) return false;
  for (const t of sub) if (!sup.has(t)) return false;
  return true;
}

/**
 * The evidence that two skills are the SAME concept, or `null` for none at all.
 *
 * Strongest relation wins, and the order is not arbitrary: an identical normalized label is
 * a fact, a shared surface form is a fact about retrieval, a bounded subset is a strong
 * inference, and token overlap is a hint. Only the first three may ever justify a confident
 * finding.
 *
 * NOTE WHAT IS ABSENT: nothing here reads a trade group, a domain, or a batch. Two skills
 * are equivalent because of what they SAY, never because of where they were emitted. That
 * is the difference between a detector that finds bad behaviour and one that forces a
 * predetermined taxonomy.
 */
export function equivalenceEvidence(a: SkillSurface, b: SkillSurface): EquivalenceEvidence | null {
  if (a.skill_id === b.skill_id) return null;

  if (a.label_norm.length > 0 && a.label_norm === b.label_norm) {
    return {
      relation: "normalized_label_equal",
      strength: "strong",
      detail: `both labels normalize to ${JSON.stringify(a.label_norm)}`,
    };
  }

  const bSurfaces = new Set(b.surface_norms);
  const shared = a.surface_norms.filter((s) => bSurfaces.has(s));
  if (shared.length > 0) {
    return {
      relation: "surface_form_shared",
      strength: "strong",
      detail:
        `${a.skill_id} and ${b.skill_id} both answer to ${shared.map((s) => JSON.stringify(s)).join(", ")} ` +
        `— canonicalizing that phrase is a coin flip between them`,
    };
  }

  if (
    a.label_tokens.size >= MIN_TOKENS_FOR_SET_EQUALITY &&
    a.label_tokens.size === b.label_tokens.size &&
    [...a.label_tokens].every((t) => b.label_tokens.has(t))
  ) {
    return {
      relation: "informative_tokens_equal",
      strength: "strong",
      detail:
        `${JSON.stringify(a.label_norm)} and ${JSON.stringify(b.label_norm)} carry the same ` +
        `informative tokens (${[...a.label_tokens].sort().join(", ")}) — they differ only in word ` +
        `order and generic filler`,
    };
  }

  if (isBoundedStrictSubset(a.label_tokens, b.label_tokens)) {
    return {
      relation: "strict_token_subset",
      strength: "strong",
      detail: `${JSON.stringify(a.label_norm)} is a strict token-subset of ${JSON.stringify(b.label_norm)}`,
    };
  }
  if (isBoundedStrictSubset(b.label_tokens, a.label_tokens)) {
    return {
      relation: "strict_token_subset",
      strength: "strong",
      detail: `${JSON.stringify(b.label_norm)} is a strict token-subset of ${JSON.stringify(a.label_norm)}`,
    };
  }

  const overlap = jaccard(a.label_tokens, b.label_tokens);
  if (overlap >= WEAK_OVERLAP_MIN_JACCARD) {
    return {
      relation: "high_token_overlap",
      strength: "weak",
      detail:
        `labels share ${sharedTokens(a.label_tokens, b.label_tokens).join(", ")} ` +
        `(jaccard ${overlap.toFixed(2)}) but neither contains the other`,
    };
  }
  return null;
}

// ===========================================================================
// Alias coherence — does ONE skill hold more than one concept?
// ===========================================================================

/** One connected group of a skill's surface forms. */
export interface SurfaceCluster {
  /** The normalized surface forms in this cluster, sorted. */
  members: string[];
  /** True for the cluster the canonical label sits in. */
  contains_label: boolean;
}

export interface AliasCoherence {
  clusters: SurfaceCluster[];
  /**
   * Clusters that do NOT contain the label and have TWO OR MORE members.
   *
   * The two-member floor is the important half. Aliases are synonyms, so a LONE alias with
   * no lexical overlap with the label is completely normal and completely correct —
   * "GMAW" for "MIG welding", "Sinumerik" for "Siemens control operation". Flagging that
   * would flag most of the shipped corpus. A cluster of two or more mutually-overlapping
   * phrases that share nothing with the canonical label is a different animal: it is a
   * SECOND CONCEPT that has grown its own vocabulary on someone else's row.
   */
  divergent_clusters: SurfaceCluster[];
}

/** Devanagari, the only non-Latin script this corpus carries (`lang: "hi"`). */
const DEVANAGARI = /[ऀ-ॿ]/;

/**
 * Which writing system a surface form is in.
 *
 * THIS EXISTS BECAUSE TOKEN OVERLAP IS MEANINGLESS ACROSS SCRIPTS, and treating it as
 * meaningful produced a confident false accusation on the corpus's own required input shape.
 *
 * `normalizeOccupationText` preserves Devanagari, so a Hindi alias and an English label can
 * NEVER share a token — not because they describe different concepts, but because they are
 * written in different alphabets. `aliasCoherence` reads "shares no token with the label" as
 * evidence of a second concept, so before this split every skill with two families of Hindi
 * aliases scored two divergent clusters and blocked as FALSE_REUSE. Verified on a real
 * fixture: `"Mortar Mixing"` with `गारा मिश्रण / गारा बनाना / मसाला तैयार / मसाला घोल` —
 * four correct Hindi synonyms — produced clusters
 * `[["mortar mix","mortar mixing"],["गारा बनाना","गारा मिश्रण"],["मसाला घोल","मसाला तैयार"]]`
 * and a BLOCK. The prompt REQUIRES those aliases (`generate-domain-skills.ts` asks for
 * "Hindi in Devanagari"), so the gate was rejecting exactly what it asked for.
 *
 * A form containing ANY Devanagari counts as Devanagari: a mixed form like `MIG वेल्डिंग`
 * belongs with the Hindi vocabulary it is written for.
 */
function scriptOf(normalized: string): "deva" | "latn" {
  return DEVANAGARI.test(normalized) ? "deva" : "latn";
}

/**
 * Cluster a skill's surface forms by shared informative token, WITHIN ONE WRITING SYSTEM.
 *
 * THIS IS THE HALF THE GENERATOR CANNOT PRODUCE. A generator that wrongly merges two
 * concepts reports it as a confident reuse — it cannot grade its own homework. What it
 * leaves behind is physical: the merged row now carries the vocabulary of both concepts,
 * and that shows up as two mutually-disconnected groups of alias text on one skill.
 *
 * ONLY THE LABEL'S SCRIPT PRODUCES DIVERGENCE. Forms in another script are clustered and
 * reported (so the shape of the vocabulary is still visible) but can never be `divergent`,
 * because the question divergence asks — "does this share vocabulary with the canonical
 * label?" — has no answer across alphabets. Nor is divergence computed inside the other
 * script: two Hindi synonym families for one concept routinely share no token (`गारा` and
 * `मसाला` are both mortar), so a cluster count there is not evidence of anything.
 */
export function aliasCoherence(surface: SkillSurface): AliasCoherence {
  const labelScript = scriptOf(surface.label_norm);
  const nodes = surface.surface_norms;
  const tokensOf = new Map<string, Set<string>>(
    nodes.map((n) => [n, new Set(taxonomyTokens(n).filter((t) => !UNINFORMATIVE.has(t)))]),
  );

  /** Union-find over the surface forms. Small n; readability beats asymptotics here. */
  const parent = new Map<string, string>(nodes.map((n) => [n, n]));
  const find = (x: string): string => {
    let root = x;
    for (;;) {
      const next = parent.get(root);
      if (next === undefined || next === root) break;
      root = next;
    }
    return root;
  };
  const union = (x: string, y: string): void => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent.set(rx, ry);
  };

  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i] as string;
      const b = nodes[j] as string;
      // Cross-script pairs are never joined, and never compared — see `scriptOf`. Their
      // token sets are disjoint by construction, so the check below would "correctly"
      // return false and the whole point is that the false is not evidence.
      if (scriptOf(a) !== scriptOf(b)) continue;
      const ta = tokensOf.get(a) as Set<string>;
      const tb = tokensOf.get(b) as Set<string>;
      if ([...ta].some((t) => tb.has(t))) union(a, b);
    }
  }

  const byRoot = new Map<string, string[]>();
  for (const n of nodes) {
    const root = find(n);
    const bucket = byRoot.get(root);
    if (bucket === undefined) byRoot.set(root, [n]);
    else bucket.push(n);
  }

  const clusters: SurfaceCluster[] = [...byRoot.values()]
    .map((members) => ({
      members: [...members].sort(),
      contains_label: members.includes(surface.label_norm),
    }))
    // Deterministic order: the label's cluster first, then by size, then lexically.
    .sort(
      (a, b) =>
        Number(b.contains_label) - Number(a.contains_label) ||
        b.members.length - a.members.length ||
        (a.members[0] ?? "").localeCompare(b.members[0] ?? ""),
    );

  return {
    clusters,
    divergent_clusters: clusters.filter(
      (c) =>
        !c.contains_label &&
        c.members.length >= 2 &&
        // Same alphabet as the label, or "shares nothing with the label" is a fact about
        // Unicode rather than about meaning.
        c.members.every((m) => scriptOf(m) === labelScript),
    ),
  };
}
