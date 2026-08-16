/**
 * REUSE ANALYSIS — did the generated taxonomy reuse the vocabulary it already had, and
 * where it did not, was that a mistake or was there simply nothing to reuse?
 *
 * ---------------------------------------------------------------------------
 * THE ONE DESIGN CONSTRAINT THAT SHAPES EVERYTHING BELOW
 * ---------------------------------------------------------------------------
 * A GENERATOR CANNOT GRADE ITS OWN HOMEWORK. Ask a model whether it reused a skill and it
 * answers from the same belief that produced the output: a wrongly-merged pair of concepts
 * is reported as a confident reuse, and a needlessly minted synonym is reported as a
 * confident new skill. Both self-reports are exactly as wrong as the decision they describe,
 * and they are wrong in the direction that looks good.
 *
 * So the two ACCUSING categories are never taken from the generator's own output:
 *
 *   FALSE_REUSE   — derived from (a) `validateTaxonomyCorpus`'s ALIAS_AMBIGUOUS and
 *                   SKILL_LABEL_COLLIDES results, which are computed by a validator that has
 *                   never seen the generator's intent, and (b) a lexical-coherence check on
 *                   the aliases NOW ATTACHED to one skill (`aliasCoherence`). A merged row
 *                   physically carries the vocabulary of both concepts; that residue is
 *                   evidence the generator did not author.
 *
 *   MISSED_REUSE  — derived from the SHIPPED `SKILL_CORPUS`, which existed before the batch
 *                   ran. A new skill whose normalized label or any alias is already a
 *                   shipped label or alias is a missed reuse regardless of what the model
 *                   believed it was doing.
 *
 * The validator's problems are CONSUMED, not recomputed. `analyzeReuse` calls
 * `validateTaxonomyCorpus` (or takes its output via `opts.problems`) and reads the codes
 * with `taxonomyProblemCode`/`taxonomyProblemLocator`. A second implementation of
 * "these two skills fight over one alias" would drift from the one that actually gates the
 * seed, and the copy that drifts is the one nobody runs.
 *
 * ---------------------------------------------------------------------------
 * WHEN IN DOUBT, CATEGORY 5
 * ---------------------------------------------------------------------------
 * Every finding carries a `confidence_signal`. A category 3 or 4 requires `"confident"` —
 * an exact normalized match, a shared surface form, or a validator code. Everything in the
 * band above "worth looking at" and below that is POTENTIAL_AMBIGUITY, which asks a human
 * and accuses nobody. This is not timidity: an over-eager accusation trains a reviewer to
 * skim the report, and a skimmed report is worth less than no report.
 *
 * ---------------------------------------------------------------------------
 * NO GLOBAL REUSE RATE. NOT ONE.
 * ---------------------------------------------------------------------------
 * There is deliberately no `reuse_rate` field anywhere in this module's output, and there
 * must never be one. The shipped corpus is 49 skills covering the CNC/VMC wedge and its
 * neighbours. It contains NOTHING about masonry, and nothing about warehousing. A single
 * blended percentage over all trades says "the generator reused 23% of the time" when the
 * truth is "in three groups it reused most of what existed, and in two others there was
 * literally nothing to reuse" — and the blended number is the one that gets quoted in a
 * review and used to tune a prompt that was never the problem.
 *
 * `by_trade_group` therefore reports, PER GROUP: how many shipped skills plausibly relate
 * to the group at all (`available_candidate_skills`), how many were actually reused
 * (`actual_reuse`), and the ratio between them — which is NULL, never zero, when the
 * denominator is zero. `limitation` names the reading in words so the row cannot be
 * misread by someone scanning columns.
 *
 * PRIVACY: trade vocabulary, published occupation ids and integer counts. No worker data
 * can reach this module by construction — its inputs are corpus records and `SKILL_CORPUS`.
 */
import {
  skillLocator,
  taxonomyProblemCode,
  taxonomyProblemLocator,
  validateTaxonomyCorpus,
  type TaxonomyDomainRecord,
  type TaxonomyDomainSkillRecord,
  type TaxonomyProblemCode,
  type TaxonomySkillRecord,
} from "./taxonomy-corpus";
import {
  aliasCoherence,
  buildSkillSurface,
  equivalenceEvidence,
  informativeTokens,
  shippedSkillViews,
  surfaceOfCorpusSkill,
  surfaceOfShippedSkill,
  type ShippedSkillView,
  type SkillSurface,
} from "./taxonomy-lexical";

// ===========================================================================
// Categories
// ===========================================================================

/**
 * Exactly one of these per accepted skill decision. The five are exhaustive and mutually
 * exclusive by construction — `classify` returns from a single ordered chain.
 */
export type ReuseCategory =
  /** 1 — an existing SKILL_CORPUS skill was referenced and is genuinely equivalent. */
  | "CORRECT_REUSE"
  /** 2 — a new canonical skill, and no suitable existing one exists. */
  | "CORRECT_NEW"
  /** 3 — distinct concepts wrongly collapsed onto one skill. */
  | "FALSE_REUSE"
  /** 4 — a new skill minted when an existing equivalent was available. */
  | "MISSED_REUSE"
  /** 5 — cannot be decided mechanically; a human must rule. */
  | "POTENTIAL_AMBIGUITY";

export const REUSE_CATEGORIES: readonly ReuseCategory[] = [
  "CORRECT_REUSE",
  "CORRECT_NEW",
  "FALSE_REUSE",
  "MISSED_REUSE",
  "POTENTIAL_AMBIGUITY",
];

/**
 * How strong the evidence behind a finding is.
 *
 * THE INVARIANT THIS FIELD ENCODES: a FALSE_REUSE or a MISSED_REUSE is always `confident`,
 * and a POTENTIAL_AMBIGUITY is always `worth_looking_at`. There is no such thing as a
 * weakly-evidenced accusation in this report — it is downgraded to category 5 instead.
 */
export type ReuseConfidenceSignal = "confident" | "worth_looking_at" | "none";

/** The validator codes this analyzer consumes as FALSE_REUSE evidence. */
export const FALSE_REUSE_PROBLEM_CODES: readonly TaxonomyProblemCode[] = [
  // An alias owned by two skills: canonicalization is a coin flip, which IS two concepts
  // fighting over one row.
  "ALIAS_AMBIGUOUS",
  // Two canonical labels that normalize alike: one concept split across two rows, or two
  // concepts about to be collapsed onto one. Either way a human has to look.
  "SKILL_LABEL_COLLIDES",
];

// ===========================================================================
// Output shapes
// ===========================================================================

export interface ReuseDecision {
  skill_id: string;
  label_en: string;
  category: ReuseCategory;
  /** One sentence for the human. Prose — never parsed, free to improve. */
  reason: string;
  /** The shipped id this decision should have used (MISSED_REUSE), else null. */
  matched_existing_skill_id: string | null;
  /**
   * Machine-readable evidence lines, prefixed by their PROVENANCE:
   *   `VALIDATOR:<CODE> …`  — consumed from `validateTaxonomyCorpus`, not recomputed here.
   *   `LEXICAL:<relation> …` — computed here from labels/aliases.
   * The prefix is the point: it makes "where did this accusation come from?" answerable
   * from the report alone.
   */
  evidence: string[];
  confidence_signal: ReuseConfidenceSignal;
}

/**
 * The STARTING-CORPUS LIMITATION, per trade group. See the header for why this is not a
 * single number.
 */
export interface TradeGroupReuseReport {
  trade_group: string;
  /** The domains in this group that the corpus actually covers. */
  job_domain_ids: string[];
  /**
   * Shipped skills that PLAUSIBLY relate to this group — the reuse opportunities that
   * existed before the batch ran. Computed lexically (see `candidateShippedSkills`), and
   * unioned with the shipped skills the group actually referenced, so the ratio below can
   * never exceed 1.
   */
  available_candidate_skills: number;
  /** The ids behind that number, so it is auditable rather than asserted. */
  candidate_skill_ids: string[];
  /** Distinct SHIPPED skill ids this group's edges actually referenced. */
  actual_reuse: number;
  /** Distinct NEW skill ids this group's edges referenced. */
  new_skills: number;
  /**
   * `actual_reuse / available_candidate_skills`, rounded to 3dp.
   *
   * NULL — NEVER ZERO — when there were no candidates. Zero would read as "the generator
   * failed to reuse anything"; null reads as "there was nothing to reuse", which is the
   * truth for every trade the 49-skill wedge corpus does not cover.
   */
  reuse_opportunity_ratio: number | null;
  /** The reading, in words, so a column-scanner cannot get it backwards. */
  limitation: "no_shipped_coverage" | "thin_shipped_coverage" | "covered";
}

export interface ReuseAnalysis {
  decisions: ReuseDecision[];
  /** Counts per category. Exhaustive: every key of `REUSE_CATEGORIES` is present, even at 0. */
  totals: Record<ReuseCategory, number>;
  by_trade_group: TradeGroupReuseReport[];
  /**
   * Which validator codes were consumed and how many of each. Provenance for the FALSE_REUSE
   * findings — a reader can check the analyzer did not invent them.
   */
  consumed_problem_codes: Record<string, number>;
  /**
   * Edge skill ids that are neither a corpus record nor shipped. Those are the validator's
   * EDGE_UNKNOWN_SKILL, not an accepted decision, so they are excluded from the categories
   * and surfaced here instead of being silently counted as anything.
   */
  skipped_unknown_skill_ids: string[];
  /** Size of the reusable shipped vocabulary this analysis ran against. */
  shipped_skill_count: number;
}

/** Under this many plausible shipped candidates, a group's low reuse says nothing at all. */
export const THIN_COVERAGE_THRESHOLD = 3;

export interface AnalyzeReuseOptions {
  /**
   * The domains in scope. REQUIRED and in an options object for the same reason
   * `validateTaxonomyCorpus` does it: the per-group report is the deliverable, and an
   * accidental `undefined` would silently produce an empty `by_trade_group` that looks
   * like "no groups" rather than "you forgot the domains".
   */
  domains: readonly TaxonomyDomainRecord[];
  /**
   * The shipped vocabulary to grade against. Defaults to `SKILL_CORPUS` minus deprecated.
   * Injectable ONLY so a test can prove a detector fires without depending on which ids
   * happen to ship this month.
   */
  shipped?: readonly ShippedSkillView[];
  /**
   * Validator output to consume. Defaults to calling `validateTaxonomyCorpus` on the same
   * inputs. Injectable so a caller that has already validated (the ingest path) does not
   * pay for it twice — and so a test can prove the analyzer CONSUMES these rather than
   * recomputing an equivalent of its own.
   */
  problems?: readonly string[];
}

// ===========================================================================
// The starting-corpus limitation
// ===========================================================================

/**
 * The tokens that characterise a trade group: every informative token of its domain labels,
 * plus the group name's own words.
 *
 * The group name is included because it is frequently the only signal — `quality_inspection`
 * contributes `inspection`, which is how the shipped `skill_dimensional_inspection` is
 * recognised as an opportunity that existed. It is split on `_` because that is how a
 * `trade_group` is written (`cnc_machining`, `warehouse_logistics`).
 */
export function tradeGroupTokens(
  group: string,
  domains: readonly TaxonomyDomainRecord[],
): Set<string> {
  const tokens = new Set<string>();
  for (const t of informativeTokens(group.split("_").join(" "))) tokens.add(t);
  for (const d of domains) {
    if (typeof d.label_en !== "string") continue;
    for (const t of informativeTokens(d.label_en)) tokens.add(t);
  }
  return tokens;
}

/**
 * Which shipped skills plausibly relate to a trade group.
 *
 * LEXICAL AND DELIBERATELY CRUDE: one shared informative token between the shipped skill's
 * vocabulary (label + aliases) and the group's vocabulary. A hand-authored map of
 * group -> relevant shipped skills would be more precise and would be worthless — it would
 * be maintained by the same person reading the report, which makes the denominator a matter
 * of opinion exactly where the report needs it to be a matter of record.
 *
 * Generic tokens cannot contribute: `informativeTokens` drops `GENERIC_SKILL_STOPLIST`, so
 * a shipped "Machine maintenance" does not become a candidate for every group that has the
 * word "machine" in a job title.
 */
export function candidateShippedSkills(
  groupTokens: ReadonlySet<string>,
  shipped: readonly SkillSurface[],
): string[] {
  return shipped
    .filter((s) => [...s.all_tokens].some((t) => groupTokens.has(t)))
    .map((s) => s.skill_id)
    .sort();
}

// ===========================================================================
// analyzeReuse
// ===========================================================================

/** Internal: everything known about one decided skill id before it is classified. */
interface DecisionInput {
  skill_id: string;
  label_en: string;
  surface: SkillSurface;
  /** True when the id belongs to the shipped corpus — i.e. this decision is a REUSE. */
  is_reuse: boolean;
  /** Validator problems attributed to this skill's locator, filtered to the codes we consume. */
  validator_evidence: string[];
}

/** The strongest shipped match for a NEW skill, if any. */
interface ShippedMatch {
  skill_id: string;
  strength: "strong" | "weak";
  detail: string;
  relation: string;
}

/**
 * The strongest equivalence between a NEW skill and another NEW skill in the SAME batch.
 *
 * Deliberately the same `equivalenceEvidence` the shipped comparison uses — a duplicate is a
 * duplicate regardless of whether its twin arrived last week or in this file, and two
 * different notions of equivalence would disagree at exactly the boundary that matters.
 *
 * Skips itself by id. Reuse decisions are excluded by the caller: a record that points at a
 * shipped id is not "a new skill that should have reused something".
 */
function bestSiblingMatch(
  input: DecisionInput,
  siblings: readonly DecisionInput[],
): ShippedMatch | null {
  let weak: ShippedMatch | null = null;
  for (const other of siblings) {
    if (other.skill_id === input.skill_id || other.is_reuse) continue;
    const evidence = equivalenceEvidence(input.surface, other.surface);
    if (evidence === null) continue;
    if (evidence.strength === "strong") {
      return {
        skill_id: other.skill_id,
        strength: "strong",
        detail: evidence.detail,
        relation: evidence.relation,
      };
    }
    weak ??= {
      skill_id: other.skill_id,
      strength: "weak",
      detail: evidence.detail,
      relation: evidence.relation,
    };
  }
  return weak;
}

function bestShippedMatch(
  surface: SkillSurface,
  shipped: readonly SkillSurface[],
): ShippedMatch | null {
  let weak: ShippedMatch | null = null;
  for (const candidate of shipped) {
    const evidence = equivalenceEvidence(surface, candidate);
    if (evidence === null) continue;
    if (evidence.strength === "strong") {
      // First strong match wins; `shipped` is sorted by id upstream so this is deterministic.
      return {
        skill_id: candidate.skill_id,
        strength: "strong",
        detail: evidence.detail,
        relation: evidence.relation,
      };
    }
    weak ??= {
      skill_id: candidate.skill_id,
      strength: "weak",
      detail: evidence.detail,
      relation: evidence.relation,
    };
  }
  return weak;
}

/**
 * Classify every accepted skill decision, and report the starting-corpus limitation per
 * trade group. PURE: same inputs, byte-identical output.
 *
 * A "decision" is one distinct `skill_id` that the batch put into the corpus — either as a
 * new record in `skills`, or as an edge pointing at a shipped id (which is how a reuse is
 * expressed; see `TaxonomySkillRecord.reuses_existing`). Edges are what make a decision
 * REAL, so an id reachable only through `skills` still counts (the validator's SKILL_ORPHAN
 * covers the "seeded but unreachable" fault; it is not this module's job).
 */
export function analyzeReuse(
  skills: readonly TaxonomySkillRecord[],
  edges: readonly TaxonomyDomainSkillRecord[],
  opts: AnalyzeReuseOptions,
): ReuseAnalysis {
  const shippedViews = opts.shipped ?? shippedSkillViews();
  const shippedSurfaces = shippedViews
    .map(surfaceOfShippedSkill)
    .sort((a, b) => a.skill_id.localeCompare(b.skill_id));
  const shippedById = new Map(shippedSurfaces.map((s) => [s.skill_id, s]));

  // CONSUMED, NOT RECOMPUTED. See the header.
  const problems =
    opts.problems ?? validateTaxonomyCorpus(skills, edges, { domains: opts.domains });

  const consumedProblemCodes: Record<string, number> = {};
  /** skill_id -> the problem strings we treat as FALSE_REUSE evidence. */
  const problemsBySkill = new Map<string, string[]>();
  for (const p of problems) {
    const code = taxonomyProblemCode(p);
    if (!FALSE_REUSE_PROBLEM_CODES.includes(code as TaxonomyProblemCode)) continue;
    const locator = taxonomyProblemLocator(p);
    if (locator === null) continue;
    consumedProblemCodes[code] = (consumedProblemCodes[code] ?? 0) + 1;
    const bucket = problemsBySkill.get(locator);
    if (bucket === undefined) problemsBySkill.set(locator, [`VALIDATOR:${code} ${p}`]);
    else bucket.push(`VALIDATOR:${code} ${p}`);
  }

  const recordById = new Map<string, TaxonomySkillRecord>();
  for (const s of skills) {
    if (typeof s.skill_id === "string" && !recordById.has(s.skill_id)) recordById.set(s.skill_id, s);
  }

  const decidedIds = new Set<string>([...recordById.keys()]);
  for (const e of edges) {
    if (typeof e.skill_id === "string" && e.skill_id.length > 0) decidedIds.add(e.skill_id);
  }

  const inputs: DecisionInput[] = [];
  const skippedUnknown: string[] = [];
  for (const id of [...decidedIds].sort()) {
    const record = recordById.get(id);
    const ship = shippedById.get(id);
    if (record === undefined && ship === undefined) {
      // Neither a corpus record nor a shipped id: EDGE_UNKNOWN_SKILL. Not a decision.
      skippedUnknown.push(id);
      continue;
    }
    // A `reuses_existing` record is BOTH: the shipped row keeps its labels, and the record
    // adds aliases. The surface must be the UNION, because "the aliases now attached to one
    // skill" is exactly what the false-reuse coherence check reads.
    let surface: SkillSurface;
    if (record !== undefined && ship !== undefined) {
      surface = buildSkillSurface(id, ship.label_en, [
        ...ship.surface_norms,
        ...(Array.isArray(record.aliases) ? record.aliases.map((a) => a?.text ?? "") : []),
        record.label_en,
      ]);
    } else if (record !== undefined) {
      surface = surfaceOfCorpusSkill(record);
    } else {
      surface = ship as SkillSurface;
    }
    inputs.push({
      skill_id: id,
      label_en: surface.label_en,
      surface,
      is_reuse: ship !== undefined,
      validator_evidence: problemsBySkill.get(skillLocator(id)) ?? [],
    });
  }

  const decisions = inputs.map((input) => classify(input, shippedSurfaces, inputs));

  const totals = Object.fromEntries(REUSE_CATEGORIES.map((c) => [c, 0])) as Record<
    ReuseCategory,
    number
  >;
  for (const d of decisions) totals[d.category] += 1;

  return {
    decisions,
    totals,
    by_trade_group: buildTradeGroupReports(edges, opts.domains, shippedSurfaces, shippedById),
    consumed_problem_codes: consumedProblemCodes,
    skipped_unknown_skill_ids: skippedUnknown,
    shipped_skill_count: shippedSurfaces.length,
  };
}

/**
 * The ordered classification chain. Severity first, confidence always.
 *
 * Read the order as a policy, because that is what it is:
 *   1. A confident FALSE_REUSE outranks everything — two concepts on one row corrupts
 *      retrieval for both, and it is the finding with the shortest shelf life (the row is
 *      about to be seeded and its id is then immutable).
 *   2. A confident MISSED_REUSE next — a duplicate row splits one concept permanently.
 *   3. Anything weaker becomes POTENTIAL_AMBIGUITY. Never an accusation.
 *   4. Otherwise the decision was fine, and which kind of fine depends only on whether the
 *      id was shipped.
 */
function classify(
  input: DecisionInput,
  shipped: readonly SkillSurface[],
  siblings: readonly DecisionInput[],
): ReuseDecision {
  const coherence = aliasCoherenceOf(input.surface);
  const divergent = coherence.length;

  // ── 3. FALSE_REUSE ────────────────────────────────────────────────────────
  if (input.validator_evidence.length > 0) {
    return {
      skill_id: input.skill_id,
      label_en: input.label_en,
      category: "FALSE_REUSE",
      reason:
        `the corpus validator reports this skill in conflict with another over a shared name or ` +
        `alias — two concepts are contending for one immutable row.`,
      matched_existing_skill_id: null,
      evidence: [...input.validator_evidence, ...coherence],
      confidence_signal: "confident",
    };
  }
  if (divergent >= 2) {
    return {
      skill_id: input.skill_id,
      label_en: input.label_en,
      category: "FALSE_REUSE",
      reason:
        `this skill's aliases fall into ${divergent} groups that share no vocabulary with its ` +
        `canonical label — distinct concepts have been collapsed onto one skill.`,
      matched_existing_skill_id: null,
      evidence: coherence,
      confidence_signal: "confident",
    };
  }

  // ── 4. MISSED_REUSE ───────────────────────────────────────────────────────
  //
  // TWO SOURCES OF "SHOULD HAVE REUSED", AND THE SECOND IS THE ONE THAT HIDES.
  //
  // (a) against the SHIPPED corpus — an equivalent existed before the batch began.
  // (b) against the BATCH ITSELF — two NEW skills minted in the same run that mean the
  //     same thing. Neither is shipped, so (a) is structurally blind to it.
  //
  // A harness with only (a) passes every existing-catalogue reuse test while the batch
  // quietly duplicates itself, which is the exact failure this analyzer exists to catch.
  // Demonstrated before this branch was written: "Hydraulic Hose Crimping" and "Crimping
  // Hydraulic Hoses", both new, both in the same batch, both classified CORRECT_NEW.
  //
  // `detectConvergence` does NOT cover this. It only inspects concepts a caller declared
  // as a probe inside a named group — so a duplicate pair outside those five groups is
  // invisible to it. The two checks are complementary, not redundant: convergence answers
  // "did the concepts I asked about converge", this answers "did the batch duplicate
  // anything at all".
  //
  // Same category rather than a sixth, because the brief's definition already covers it:
  // "generator creates a new skill where an existing equivalent should have been reused".
  // The equivalent is simply a sibling in this batch instead of a shipped row. Which of a
  // duplicate pair is "the original" is not knowable here, so BOTH are reported and the
  // reviewer picks the survivor; reporting one would silently nominate a winner.
  const shippedMatch = input.is_reuse ? null : bestShippedMatch(input.surface, shipped);
  const siblingMatch = input.is_reuse ? null : bestSiblingMatch(input, siblings);
  const match = shippedMatch ?? siblingMatch;
  if (shippedMatch !== null && shippedMatch.strength === "strong") {
    return {
      skill_id: input.skill_id,
      label_en: input.label_en,
      category: "MISSED_REUSE",
      reason:
        `a new canonical skill was minted although shipped ${shippedMatch.skill_id} already means the ` +
        `same thing — two rows for one concept split it permanently.`,
      matched_existing_skill_id: shippedMatch.skill_id,
      evidence: [`LEXICAL:${shippedMatch.relation} ${shippedMatch.detail}`, ...coherence],
      confidence_signal: "confident",
    };
  }
  if (siblingMatch !== null && siblingMatch.strength === "strong") {
    return {
      skill_id: input.skill_id,
      label_en: input.label_en,
      category: "MISSED_REUSE",
      reason:
        `this batch minted BOTH this skill and ${siblingMatch.skill_id} for what reads as one ` +
        `concept. Neither is shipped, so no against-catalogue check can see it — the batch ` +
        `duplicated itself. Keep one and fold the other's aliases into it.`,
      matched_existing_skill_id: siblingMatch.skill_id,
      evidence: [
        `WITHIN_BATCH:${siblingMatch.relation} ${siblingMatch.detail}`,
        ...coherence,
      ],
      confidence_signal: "confident",
    };
  }

  // ── 5. POTENTIAL_AMBIGUITY ────────────────────────────────────────────────
  if (divergent === 1) {
    return {
      skill_id: input.skill_id,
      label_en: input.label_en,
      category: "POTENTIAL_AMBIGUITY",
      reason:
        `one group of this skill's aliases shares no vocabulary with its label. That is often a ` +
        `legitimate synonym set and sometimes a second concept; a human must rule.`,
      matched_existing_skill_id: null,
      evidence: coherence,
      confidence_signal: "worth_looking_at",
    };
  }
  if (match !== null) {
    return {
      skill_id: input.skill_id,
      label_en: input.label_en,
      category: "POTENTIAL_AMBIGUITY",
      reason:
        `this new skill partially overlaps shipped ${match.skill_id}, but neither label contains ` +
        `the other and they share no alias. Reuse may or may not have been available.`,
      matched_existing_skill_id: match.skill_id,
      evidence: [`LEXICAL:${match.relation} ${match.detail}`],
      confidence_signal: "worth_looking_at",
    };
  }

  // ── 1 / 2. The decision was fine ──────────────────────────────────────────
  if (input.is_reuse) {
    return {
      skill_id: input.skill_id,
      label_en: input.label_en,
      category: "CORRECT_REUSE",
      reason: `references shipped ${input.skill_id}; no conflicting name, alias or validator problem.`,
      matched_existing_skill_id: input.skill_id,
      evidence: [],
      confidence_signal: "none",
    };
  }
  return {
    skill_id: input.skill_id,
    label_en: input.label_en,
    category: "CORRECT_NEW",
    reason: `no shipped skill shares this label, an alias, or enough of its tokens to reuse.`,
    matched_existing_skill_id: null,
    evidence: [],
    confidence_signal: "none",
  };
}

/**
 * `aliasCoherence`'s divergent clusters, rendered as evidence lines. EMPTY MEANS COHERENT,
 * which is what the classifier reads as "no lexical signal".
 */
function aliasCoherenceOf(surface: SkillSurface): string[] {
  return aliasCoherence(surface).divergent_clusters.map(
    (c) =>
      `LEXICAL:alias_cluster_divergence aliases ${c.members.map((m) => JSON.stringify(m)).join(", ")} ` +
      `share no informative token with label ${JSON.stringify(surface.label_norm)}`,
  );
}

// ===========================================================================
// Per-group starting-corpus limitation
// ===========================================================================

function buildTradeGroupReports(
  edges: readonly TaxonomyDomainSkillRecord[],
  domains: readonly TaxonomyDomainRecord[],
  shippedSurfaces: readonly SkillSurface[],
  shippedById: ReadonlyMap<string, SkillSurface>,
): TradeGroupReuseReport[] {
  const byGroup = new Map<string, TaxonomyDomainRecord[]>();
  for (const d of domains) {
    if (typeof d.job_domain_id !== "string") continue;
    const group = typeof d.trade_group === "string" && d.trade_group.length > 0 ? d.trade_group : "<ungrouped>";
    const bucket = byGroup.get(group);
    if (bucket === undefined) byGroup.set(group, [d]);
    else bucket.push(d);
  }

  const domainToGroup = new Map<string, string>();
  for (const [group, members] of byGroup) {
    for (const d of members) domainToGroup.set(d.job_domain_id, group);
  }

  /** group -> the distinct skill ids its edges referenced. */
  const skillsByGroup = new Map<string, Set<string>>();
  for (const e of edges) {
    const group = domainToGroup.get(e.job_domain_id);
    if (group === undefined) continue;
    let bucket = skillsByGroup.get(group);
    if (bucket === undefined) {
      bucket = new Set<string>();
      skillsByGroup.set(group, bucket);
    }
    if (typeof e.skill_id === "string" && e.skill_id.length > 0) bucket.add(e.skill_id);
  }

  return [...byGroup.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, members]) => {
      const referenced = skillsByGroup.get(group) ?? new Set<string>();
      const reused = [...referenced].filter((id) => shippedById.has(id)).sort();
      const minted = [...referenced].filter((id) => !shippedById.has(id)).sort();

      const lexical = candidateShippedSkills(tradeGroupTokens(group, members), shippedSurfaces);
      // A skill the group ACTUALLY reused was, self-evidently, available to it. Unioning
      // guarantees `actual_reuse <= available_candidate_skills`, so the ratio is a real
      // fraction rather than something that can exceed 1 when the lexical heuristic is
      // narrower than the model's judgement.
      const candidates = [...new Set([...lexical, ...reused])].sort();

      const ratio =
        candidates.length === 0
          ? null
          : Math.round((reused.length / candidates.length) * 1000) / 1000;

      return {
        trade_group: group,
        job_domain_ids: members.map((d) => d.job_domain_id).sort(),
        available_candidate_skills: candidates.length,
        candidate_skill_ids: candidates,
        actual_reuse: reused.length,
        new_skills: minted.length,
        reuse_opportunity_ratio: ratio,
        limitation:
          candidates.length === 0
            ? "no_shipped_coverage"
            : candidates.length < THIN_COVERAGE_THRESHOLD
              ? "thin_shipped_coverage"
              : "covered",
      };
    });
}
