/**
 * THE TAXONOMY QUALITY GATE — the stage between "the validator says the shape is legal"
 * and "these rows are about to exist forever".
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * `validateTaxonomyCorpus` answers a STRUCTURAL question: are the ids well-formed, do the
 * edges point at things, is any alias owned twice, is any label empty. It is a good gate and
 * it is not the interesting one. A batch can pass every one of those checks and still be
 * unfit to seed, because the faults that actually destroy a taxonomy are SEMANTIC:
 *
 *   - two new skills minted in the same run that mean the same thing. Both ids are
 *     well-formed, neither collides, no alias is shared, every edge resolves. The validator
 *     has nothing to say. Half the workers who have the skill will match only the postings
 *     that happened to pick the other row.
 *   - a concept that fragments across related trades instead of converging on one row.
 *   - a "skill" that is a rung on a ladder — "Assistant Masonry" — which every helper in
 *     the trade has and which therefore separates no two candidates.
 *
 * The invariant this file enforces, stated once:
 *
 *   A CANDIDATE SET CONTAINING A BLOCKING DUPLICATE OR CONVERGENCE FAILURE MUST NOT BE
 *   PERSISTED MERELY BECAUSE THE SCHEMA VALIDATOR PASSED.
 *
 * ---------------------------------------------------------------------------
 * ANALYSIS AND ENFORCEMENT ARE SEPARATE, AND THERE IS ONE COPY OF THE ANALYSIS
 * ---------------------------------------------------------------------------
 *                       analyzeTaxonomyQuality(...)
 *                                  |
 *                        TaxonomyQualityFindings
 *                            /            \
 *          formatTaxonomyQualityReport   taxonomyQualityVerdict
 *              (humans, `--report`)      (the gate: ingest + seed)
 *
 * The ingest path does NOT re-implement any of this. It calls `analyzeTaxonomyQuality` once,
 * hands the result to `taxonomyQualityVerdict`, and prints it with the same formatter the
 * report command uses. A second copy of "is this a duplicate?" living in the ingest would
 * drift from the one the tests exercise, and the copy that drifts is the one that ships.
 *
 * Nothing here recomputes the validator either: `opts.problems` is the validator's own
 * output, consumed. `analyzeReuse` makes the same promise for the same reason.
 *
 * ---------------------------------------------------------------------------
 * ATTRIBUTION — WHOSE FAULT IS IT?
 * ---------------------------------------------------------------------------
 * The ingest validates the UNION of the committed corpus and the batch's candidates, because
 * the cross-batch faults are the ones that matter most. That union means a pre-existing fault
 * in the committed corpus would otherwise block an innocent batch forever.
 *
 * So a finding carries `attributable`, and only an attributable finding blocks:
 *
 *   ingest  — `attributableSkillIds` is the skills the batch AUTHORED, and
 *             `attributableEdgeSkillIds` is the skills it WIRED INTO A DOMAIN. A duplicate
 *             pair with one committed member and one new member is attributable: the new row
 *             is the one that split the concept.
 *   seed    — both are OMITTED, which means EVERYTHING is accountable. The seed is the last
 *             gate before ids become immutable, and at that point "somebody else committed
 *             it" is not a reason to write it to a database.
 *
 * THE TWO SETS ARE NOT THE SAME SET, and collapsing them was a real defect. Putting reused
 * ids into the authored set made a batch inherit the faults of every skill it pointed at, so
 * correctly echoing `existing_skill_id` blocked while lazily minting a fresh synonym passed —
 * the gate punished the one behaviour the whole harness exists to encourage. A duplicate row
 * is a property of the SKILL; fragmentation is a property of the EDGES. Hence one set per
 * axis.
 *
 * A non-attributable finding is still REPORTED, as advisory. Silence would let a corpus rot
 * one un-blamed batch at a time.
 *
 * ---------------------------------------------------------------------------
 * WHAT BLOCKS, AND WHY EACH ONE
 * ---------------------------------------------------------------------------
 * The policy is DATA (`BLOCKING_CODES`), not a chain of `if`s, so that "what blocks a seed?"
 * is answered by reading one array and is asserted directly by a test.
 *
 * Everything in it shares one property: THE DAMAGE IS PERMANENT. A `skill_id` is immutable
 * and never reused (ADR-0030 SG-5), so a wrong row is not a typo to be fixed later — undoing
 * it means deprecating an id and recreating the concept, and every worker profile and job
 * posting that referenced it in the meantime points at the deprecated one.
 *
 * Everything NOT in it shares the opposite property: it is a question, not a defect.
 * POTENTIAL_AMBIGUITY and CONVERGENCE_NEEDS_REVIEW exist precisely because the machine cannot
 * tell a synonym from a specialisation, and a gate that blocked on them would train an
 * operator to pass `--i-know-better`, which is worth less than no gate. CONVERGENCE_ABSENT is
 * not a defect at all: a domain that did not emit a concept has not fragmented anything.
 *
 * PRIVACY: trade vocabulary, published occupation ids and integer counts. No worker data can
 * reach this module by construction — its inputs are corpus records and `SKILL_CORPUS`.
 */
import {
  detectConvergence,
  detectSeniorityLabels,
  type ConvergenceGroup,
  type ConvergenceReport,
  type SeniorityFinding,
} from "./taxonomy-convergence";
import {
  loadTaxonomyCorpus,
  validateTaxonomyCorpus,
  type TaxonomyDomainRecord,
  type TaxonomyDomainSkillRecord,
  type TaxonomySkillRecord,
} from "./taxonomy-corpus";
import { shippedSkillViews, type ShippedSkillView } from "./taxonomy-lexical";
import { analyzeReuse, type ReuseAnalysis } from "./taxonomy-reuse-analysis";

// ===========================================================================
// The production convergence assertions
// ===========================================================================

/**
 * The concepts checked for convergence on every ingest and every seed.
 *
 * EVERY DOMAIN ID BELOW IS A VERIFIED ENTITY. They are the ids in
 * `data/taxonomy/sample-domains.jsonl`, which are themselves real `jd_*` rows in
 * `job_domain`. Nothing here is transcribed from a design brief, and the gate does not take
 * that on trust: `CONVERGENCE_GROUP_UNKNOWN_DOMAIN` re-checks every id against the corpus at
 * runtime, because an assertion naming a domain that does not exist does not fail — it
 * reports ABSENT for every concept, which reads as "the generator produced nothing" when the
 * truth is "the question was never asked".
 *
 * THE PROBES DESCRIBE BEHAVIOUR TO WATCH FOR, NOT AN ANSWER TO PRODUCE. This distinction is
 * the whole design of `taxonomy-convergence.ts` and it survives here: a probe asks "which
 * skills in these domains are about mortar?", and FRAGMENTED is reported only if two of the
 * answers are semantically equivalent BY EVIDENCE. A group may legitimately contain several
 * genuinely distinct mortar skills; that is NEEDS_REVIEW, and NEEDS_REVIEW does not block.
 *
 * NOTE ON WELDING. The unit tests carry a fourth welding concept, `"Anything called
 * setting"`, whose probe is deliberately over-broad — it exists to prove the detector reports
 * NEEDS_REVIEW instead of inventing a fragmentation. It is deliberately NOT here. A probe
 * chosen to demonstrate a failure mode is not a probe you run in production.
 *
 * NOTE ON WAREHOUSE. `warehouse_logistics` is the CONTROL. The shipped 49-skill corpus is the
 * CNC/VMC wedge and covers nothing about warehousing, so this group's reuse row will read
 * `no_shipped_coverage` with a NULL ratio — and must. If a change to this file or to the
 * analyzer ever makes warehouse look like a reuse failure, the analyzer is wrong, not the
 * warehouse.
 */
export const TAXONOMY_CONVERGENCE_GROUPS: readonly ConvergenceGroup[] = [
  {
    group: "cnc_machining",
    job_domain_ids: ["jd_nco_7223_6002", "jd_nco_7223_6003", "jd_nco_7223_0701"],
    concepts: [
      { concept: "Fanuc control operation", probes: ["fanuc"] },
      // Three spellings because a generated corpus will contain all three and the detector
      // does no morphology. See `ConvergenceConcept`.
      { concept: "G-code programming", probes: ["g-code", "g code", "gcode"] },
    ],
  },
  {
    group: "welding",
    job_domain_ids: ["jd_nco_7212_0301", "jd_nco_7212_0100", "jd_nco_7212_0300"],
    concepts: [
      { concept: "Weld bead inspection", probes: ["bead"] },
      { concept: "Torch flame setting", probes: ["torch"] },
      { concept: "Machine program setting", probes: ["program parameter"] },
    ],
  },
  {
    group: "quality_inspection",
    job_domain_ids: ["jd_nco_7543_2001", "jd_nco_7313_2601"],
    concepts: [
      { concept: "Dimensional inspection", probes: ["dimensional inspection"] },
      { concept: "Measuring instruments", probes: ["micrometer"] },
    ],
  },
  {
    group: "construction",
    job_domain_ids: ["jd_nco_7112_0100", "jd_nco_7112_0601"],
    concepts: [{ concept: "Mortar work", probes: ["mortar"] }],
  },
  {
    group: "warehouse_logistics",
    job_domain_ids: ["jd_isco_4321", "jd_nco_4321_0100", "jd_nco_4321_0601"],
    concepts: [
      { concept: "Stock counting", probes: ["stock"] },
      { concept: "Material handling", probes: ["handling"] },
    ],
  },
];

// ===========================================================================
// Findings
// ===========================================================================

export type QualityGateSeverity = "BLOCKING" | "ADVISORY";

/**
 * STABLE. These appear in `quality-gate.json` and in the batch manifest, so a run six months
 * from now stays comparable with one today. Adding a code is additive; renaming one is a
 * breaking change to the audit trail, exactly like renaming a `TaxonomyProblemCode`.
 */
export type QualityGateCode =
  /** Distinct concepts collapsed onto ONE immutable row. Corrupts retrieval for both. */
  | "FALSE_REUSE"
  /** A new skill minted although a SHIPPED equivalent existed before the batch ran. */
  | "MISSED_REUSE_CATALOGUE"
  /**
   * A new skill minted although an equivalent was minted alongside it — no shipped row
   * involved, so no against-catalogue check can see it. On the seed path "batch" reads as
   * "the corpus under review": two committed skills that duplicate each other are the same
   * defect arriving by a slower route.
   */
  | "MISSED_REUSE_WITHIN_BATCH"
  /** Two or more semantically equivalent skills carry one concept across related domains. */
  | "CONVERGENCE_FRAGMENTED"
  /** A level word wearing a skill's clothes. Every worker at that rung "has" it. */
  | "SENIORITY_AS_SKILL"
  /** A declared probe group names a domain the corpus does not contain — a vacuous assertion. */
  | "CONVERGENCE_GROUP_UNKNOWN_DOMAIN"
  // ── advisory: questions, not defects ──────────────────────────────────────
  /** The machine cannot rule. A human must. Never an accusation, never a block. */
  | "POTENTIAL_AMBIGUITY"
  /** Several skills answered one probe with no evidence of equivalence. Usually correct. */
  | "CONVERGENCE_NEEDS_REVIEW"
  /** No domain in the group emitted the concept. A coverage question, not a failure. */
  | "CONVERGENCE_ABSENT"
  /** An edge points at a skill that is neither a corpus record nor shipped. The validator's
   *  EDGE_UNKNOWN_SKILL; surfaced so the gate's own numbers account for it. */
  | "EDGE_SKILL_UNRESOLVED";

/**
 * EXHAUSTIVE BY CONSTRUCTION, not by discipline.
 *
 * `QUALITY_GATE_CODES` is derived from this witness rather than hand-listed, because a
 * hand-listed array is only checked to be a subset of the union: dropping a member kept
 * `tsc` green, and `totals[f.code] += 1` on an absent key silently produced `NaN`, which
 * serializes into `quality-gate.json` — the permanent audit record — as `null`. Adding a
 * member to `QualityGateCode` now fails compilation until it is added here.
 */
const CODE_WITNESS: Record<QualityGateCode, true> = {
  FALSE_REUSE: true,
  MISSED_REUSE_CATALOGUE: true,
  MISSED_REUSE_WITHIN_BATCH: true,
  CONVERGENCE_FRAGMENTED: true,
  SENIORITY_AS_SKILL: true,
  CONVERGENCE_GROUP_UNKNOWN_DOMAIN: true,
  POTENTIAL_AMBIGUITY: true,
  CONVERGENCE_NEEDS_REVIEW: true,
  CONVERGENCE_ABSENT: true,
  EDGE_SKILL_UNRESOLVED: true,
};

export const QUALITY_GATE_CODES: readonly QualityGateCode[] = Object.keys(
  CODE_WITNESS,
) as QualityGateCode[];

/**
 * THE POLICY, AS DATA.
 *
 * Every member is a PERMANENT defect: the row is about to exist under an immutable id, and
 * undoing it means deprecating that id, not editing it. Nothing here is a matter of taste,
 * and nothing here is a finding the analyzer marks `worth_looking_at` — a weakly-evidenced
 * accusation is downgraded to POTENTIAL_AMBIGUITY before it ever reaches this list.
 */
export const BLOCKING_CODES: readonly QualityGateCode[] = [
  "FALSE_REUSE",
  "MISSED_REUSE_CATALOGUE",
  "MISSED_REUSE_WITHIN_BATCH",
  "CONVERGENCE_FRAGMENTED",
  "SENIORITY_AS_SKILL",
  "CONVERGENCE_GROUP_UNKNOWN_DOMAIN",
];

const BLOCKING_SET: ReadonlySet<QualityGateCode> = new Set(BLOCKING_CODES);

/** True when this code would block a persist, IF it is attributable. */
export function isBlockingCode(code: QualityGateCode): boolean {
  return BLOCKING_SET.has(code);
}

export interface QualityGateFinding {
  code: QualityGateCode;
  severity: QualityGateSeverity;
  /** What the finding is ABOUT: a skill id, or `<group>/<concept>`. Report key, stable. */
  subject: string;
  /** Every skill id implicated. A fragmentation cluster has several; a probe group has none. */
  skill_ids: string[];
  /**
   * Whether at least one implicated id is the responsibility of the change under review.
   * Only an attributable finding can block — see the header.
   */
  attributable: boolean;
  reason: string;
  /** Provenance-prefixed lines (`VALIDATOR:` / `LEXICAL:` / `WITHIN_BATCH:` / `STRONG:`). */
  evidence: string[];
}

export interface TaxonomyQualityFindings {
  findings: QualityGateFinding[];
  /** The underlying reports, unmodified, so a reader can audit how a finding was derived. */
  reuse: ReuseAnalysis;
  convergence: ConvergenceReport;
  seniority: SeniorityFinding[];
  /** Counts per code. Exhaustive — every code present, even at 0. */
  totals: Record<QualityGateCode, number>;
  /** The ids held accountable, or NULL meaning "everything" (the seed path). */
  attributable_skill_ids: string[] | null;
}

export interface TaxonomyQualityVerdict {
  verdict: "PASS" | "BLOCK";
  /** Attributable findings whose code is in `BLOCKING_CODES`. Non-empty iff BLOCK. */
  blocking: QualityGateFinding[];
  /** Everything else that was found. Reported, never enforced. */
  advisory: QualityGateFinding[];
}

// ===========================================================================
// analyzeTaxonomyQuality
// ===========================================================================

export interface AnalyzeTaxonomyQualityOptions {
  /**
   * The domains in scope. REQUIRED for the same reason the analyzer and the validator
   * require it: without them the convergence groups resolve to nothing and the seniority
   * detector's "level word plus the domain's own name" half silently does nothing. A
   * detector that quietly half-works is worse than one that is obviously absent.
   */
  domains: readonly TaxonomyDomainRecord[];
  /**
   * `validateTaxonomyCorpus` output, CONSUMED. Pass it when the caller has already validated
   * (both wired call sites have) so the work is not done twice and — more importantly — so
   * the gate reasons about exactly the problem set the caller acted on.
   */
  problems?: readonly string[];
  /**
   * Skills this change CREATED or MODIFIED — i.e. skills whose own text it authored. Governs
   * every skill-level finding: FALSE_REUSE, both MISSED_REUSE codes, SENIORITY_AS_SKILL,
   * POTENTIAL_AMBIGUITY.
   *
   * OMIT to hold everything accountable. Note what omitting means: not "no attribution" but
   * "total attribution". That is the safe default and the one the seed path relies on.
   *
   * WHAT MUST NOT GO IN HERE: a skill the change merely POINTED AT. Reusing a committed skill
   * does not make you responsible for its label, its aliases, or the duplicate somebody else
   * minted next to it — and putting reused ids in this set inverted the whole harness: a batch
   * that correctly echoed `existing_skill_id` inherited that skill's pre-existing FALSE_REUSE
   * and blocked, while a batch that lazily minted a fresh synonym sailed through. The gate
   * punished the exact behaviour it exists to encourage. Reuse belongs in
   * `attributableEdgeSkillIds` below.
   */
  attributableSkillIds?: readonly string[];
  /**
   * Skills this change newly ATTACHED to a domain, whether it authored them or not.
   *
   * Governs CONVERGENCE findings ONLY, and only in addition to `attributableSkillIds`. The
   * asymmetry is the point. A duplicate row is a property of the SKILL, so pointing at one
   * cannot be your fault. Fragmentation is a property of the EDGES: two equivalent skills sit
   * harmlessly in the corpus until somebody wires them into the same family of trades, and
   * whoever added that wire is who can undo it.
   *
   * Ignored entirely when `attributableSkillIds` is omitted, because everything is already
   * accountable then.
   */
  attributableEdgeSkillIds?: readonly string[];
  /** Defaults to `TAXONOMY_CONVERGENCE_GROUPS`. Injectable for tests and for a scoped run. */
  groups?: readonly ConvergenceGroup[];
  /** Defaults to `SKILL_CORPUS` minus deprecated. Injectable for tests. */
  shipped?: readonly ShippedSkillView[];
}

/**
 * Run every semantic detector over one candidate set and return STRUCTURED FINDINGS.
 *
 * PURE — same inputs, byte-identical output. Decides nothing about whether to persist; that
 * is `taxonomyQualityVerdict`, and the split is what lets the report command run the exact
 * analysis the gate runs without inheriting its teeth.
 */
export function analyzeTaxonomyQuality(
  skills: readonly TaxonomySkillRecord[],
  edges: readonly TaxonomyDomainSkillRecord[],
  opts: AnalyzeTaxonomyQualityOptions,
): TaxonomyQualityFindings {
  const shipped = opts.shipped ?? shippedSkillViews();
  const shippedIds = new Set(shipped.map((s) => s.skill_id));
  const groups = opts.groups ?? TAXONOMY_CONVERGENCE_GROUPS;
  const problems =
    opts.problems ?? validateTaxonomyCorpus(skills, edges, { domains: opts.domains });

  const accountable = opts.attributableSkillIds;
  const accountableSet = accountable === undefined ? null : new Set(accountable);
  /**
   * Skill-level attribution: did this change author any of the skills implicated?
   * No scope means TOTAL accountability, never none. See the options docblock.
   */
  const isAttributable = (ids: readonly string[]): boolean =>
    accountableSet === null ? true : ids.some((id) => accountableSet.has(id));
  /**
   * Convergence attribution: authored OR newly edged. Wider than `isAttributable` because
   * fragmentation is created by the wiring, not by the rows — see `attributableEdgeSkillIds`.
   */
  const edgedSet =
    accountableSet === null
      ? null
      : new Set([...accountableSet, ...(opts.attributableEdgeSkillIds ?? [])]);
  const isEdgeAttributable = (ids: readonly string[]): boolean =>
    edgedSet === null ? true : ids.some((id) => edgedSet.has(id));

  const reuse = analyzeReuse(skills, edges, {
    domains: opts.domains,
    shipped,
    problems,
  });
  const convergence = detectConvergence(skills, edges, groups, { shipped });
  const seniority = detectSeniorityLabels(skills, edges, { domains: opts.domains });

  const findings: QualityGateFinding[] = [];

  /**
   * The ONE constructor for a finding, and the only place `severity` is set.
   *
   * `severity` is DERIVED from `BLOCKING_CODES`, never written by hand. It used to be typed
   * at each call site, which made it decorative: the verdict reads `isBlockingCode(f.code)`
   * and never the field, so flipping every `"BLOCKING"` to `"ADVISORY"` changed nothing
   * except the permanent audit record in `quality-gate.json` — a silent lie no test could
   * catch. One derivation cannot disagree with the policy it is derived from.
   */
  const push = (f: Omit<QualityGateFinding, "severity">): void => {
    findings.push({ ...f, severity: isBlockingCode(f.code) ? "BLOCKING" : "ADVISORY" });
  };

  // ── Probe-group integrity, FIRST ──────────────────────────────────────────
  //
  // Before any convergence finding is believed, the questions must have been askable. A
  // group naming a domain the corpus does not contain yields ABSENT for all its concepts,
  // and ABSENT is advisory — so a stale probe set would silently downgrade the entire
  // convergence stage to "nothing to see here". Always attributable: this is a fault in the
  // gate's own configuration, not in anybody's batch, so there is nobody to excuse it.
  const knownDomains = new Set(
    opts.domains.map((d) => d.job_domain_id).filter((id) => typeof id === "string"),
  );
  for (const group of groups) {
    const unknown = group.job_domain_ids.filter((id) => !knownDomains.has(id)).sort();
    if (unknown.length === 0) continue;
    push({
      code: "CONVERGENCE_GROUP_UNKNOWN_DOMAIN",
      subject: group.group,
      skill_ids: [],
      attributable: true,
      reason:
        `convergence group ${JSON.stringify(group.group)} names ${unknown.length} domain(s) that are ` +
        `not in this corpus, so its concepts can only ever report ABSENT. A vacuous assertion is ` +
        `worse than no assertion: it reads as a passing check.`,
      evidence: unknown.map((id) => `CONFIG:unknown_domain ${id}`),
    });
  }

  // ── Reuse: categories 3 and 4 accuse; 5 asks ──────────────────────────────
  for (const d of reuse.decisions) {
    if (d.category === "FALSE_REUSE") {
      push({
        code: "FALSE_REUSE",
        subject: d.skill_id,
        skill_ids: [d.skill_id],
        attributable: isAttributable([d.skill_id]),
        reason: d.reason,
        evidence: d.evidence,
      });
      continue;
    }
    if (d.category === "MISSED_REUSE") {
      const matched = d.matched_existing_skill_id;
      // STRUCTURAL, not a string match on the evidence prefix. A catalogue match names a
      // SHIPPED id by construction; a within-batch match names a sibling, which by
      // definition is not shipped. Reading the prefix would couple this gate to the wording
      // of another module's evidence line.
      const code: QualityGateCode =
        matched !== null && shippedIds.has(matched)
          ? "MISSED_REUSE_CATALOGUE"
          : "MISSED_REUSE_WITHIN_BATCH";
      const implicated = matched === null ? [d.skill_id] : [d.skill_id, matched];
      push({
        code,
        subject: d.skill_id,
        skill_ids: implicated,
        attributable: isAttributable(implicated),
        reason: d.reason,
        evidence: d.evidence,
      });
      continue;
    }
    if (d.category === "POTENTIAL_AMBIGUITY") {
      const implicated =
        d.matched_existing_skill_id === null
          ? [d.skill_id]
          : [d.skill_id, d.matched_existing_skill_id];
      push({
        code: "POTENTIAL_AMBIGUITY",
        subject: d.skill_id,
        skill_ids: implicated,
        attributable: isAttributable(implicated),
        reason: d.reason,
        evidence: d.evidence,
      });
    }
    // CORRECT_REUSE / CORRECT_NEW are not findings. A gate report that lists the healthy
    // rows alongside the broken ones is a report nobody finishes reading.
  }

  for (const id of reuse.skipped_unknown_skill_ids) {
    push({
      code: "EDGE_SKILL_UNRESOLVED",
      subject: id,
      skill_ids: [id],
      attributable: isAttributable([id]),
      reason:
        `an edge references ${id}, which is neither a corpus record nor a shipped skill. The ` +
        `validator reports this as EDGE_UNKNOWN_SKILL and drops the edge; it is surfaced here ` +
        `only so this report's counts account for every id the batch mentioned.`,
      evidence: [],
    });
  }

  // ── Convergence — attributed by the EDGES, not by the rows ────────────────
  for (const f of convergence.findings) {
    const subject = `${f.group}/${f.concept}`;
    if (f.status === "FRAGMENTED") {
      const implicated = [...new Set(f.fragmented_clusters.flat())].sort();
      push({
        code: "CONVERGENCE_FRAGMENTED",
        subject,
        skill_ids: implicated,
        // `isEdgeAttributable`, not `isAttributable`: two equivalent skills sit harmlessly in
        // the corpus until somebody wires them into the same family of trades. Whoever added
        // the wire owns the fragmentation, even if both rows predate them.
        attributable: isEdgeAttributable(implicated),
        reason: f.reason,
        evidence: f.evidence,
      });
      continue;
    }
    if (f.status === "NEEDS_REVIEW") {
      push({
        code: "CONVERGENCE_NEEDS_REVIEW",
        subject,
        skill_ids: f.skill_ids,
        attributable: isEdgeAttributable(f.skill_ids),
        reason: f.reason,
        evidence: f.evidence,
      });
      continue;
    }
    if (f.status === "ABSENT") {
      push({
        code: "CONVERGENCE_ABSENT",
        subject,
        skill_ids: [],
        // A concept nobody emitted implicates no skill, so `isAttributable([])` would read
        // false under a scope and true without one. Neither is meaningful and neither can
        // block, since ABSENT is advisory — pinned false so the field is not read as a claim.
        attributable: false,
        reason: f.reason,
        evidence: [],
      });
    }
    // CONVERGED is the outcome we wanted. Not a finding.
  }

  // ── Seniority ─────────────────────────────────────────────────────────────
  for (const s of seniority) {
    push({
      code: "SENIORITY_AS_SKILL",
      subject: s.skill_id,
      skill_ids: [s.skill_id],
      attributable: isAttributable([s.skill_id]),
      reason: s.reason,
      evidence: [
        `LEXICAL:seniority_tokens ${s.seniority_tokens.join(", ")}`,
        `LEXICAL:residual_tokens ${s.residual_tokens.length === 0 ? "(none)" : s.residual_tokens.join(", ")}`,
      ],
    });
  }

  const totals = Object.fromEntries(QUALITY_GATE_CODES.map((c) => [c, 0])) as Record<
    QualityGateCode,
    number
  >;
  for (const f of findings) totals[f.code] += 1;

  return {
    // Sorted so two runs over the same inputs produce byte-identical `quality-gate.json`,
    // which is what makes a diff between two batches readable.
    findings: findings.sort(
      (a, b) => a.code.localeCompare(b.code) || a.subject.localeCompare(b.subject),
    ),
    reuse,
    convergence,
    seniority,
    totals,
    attributable_skill_ids: accountable === undefined ? null : [...new Set(accountable)].sort(),
  };
}

// ===========================================================================
// The verdict
// ===========================================================================

/**
 * Enforcement, and nothing else. Reads `BLOCKING_CODES` and `attributable`; computes nothing.
 *
 * Deliberately trivial and deliberately separate. Every judgement was already made — by the
 * validator, by the reuse analyzer, by the convergence detector — and a gate that re-derived
 * any part of it would be a second opinion with no test behind it.
 */
export function taxonomyQualityVerdict(findings: TaxonomyQualityFindings): TaxonomyQualityVerdict {
  const blocking = findings.findings.filter((f) => isBlockingCode(f.code) && f.attributable);
  const blocked = new Set(blocking);
  const advisory = findings.findings.filter((f) => !blocked.has(f));
  return { verdict: blocking.length === 0 ? "PASS" : "BLOCK", blocking, advisory };
}

// ===========================================================================
// Reporting
// ===========================================================================

/**
 * Render the findings for a terminal. Reporting ONLY — it makes no decision and is safe to
 * call on a passing run, which is the point: the same lines appear whether the gate blocked
 * or not, so an operator learns to read one format.
 */
export function formatTaxonomyQualityReport(
  findings: TaxonomyQualityFindings,
  verdict: TaxonomyQualityVerdict,
): string[] {
  const out: string[] = [];
  out.push(`quality gate: ${verdict.verdict}`);
  out.push(
    `  scope          = ${
      findings.attributable_skill_ids === null
        ? "ALL skills accountable (no batch scope given)"
        : `${findings.attributable_skill_ids.length} skill id(s) attributable to this change`
    }`,
  );

  out.push(`  reuse categories:`);
  for (const [category, n] of Object.entries(findings.reuse.totals)) {
    out.push(`    ${category.padEnd(24)} = ${n}`);
  }
  out.push(`  convergence:`);
  for (const [status, n] of Object.entries(findings.convergence.totals)) {
    out.push(`    ${status.padEnd(24)} = ${n}`);
  }
  out.push(`  seniority flagged        = ${findings.seniority.length}`);

  // The per-group limitation table. This is the thing a single global reuse rate would have
  // destroyed: a NULL ratio means "there was nothing to reuse", and it must never render as 0.
  out.push(`  reuse opportunity by trade group (NULL ratio = nothing was available to reuse):`);
  for (const g of findings.reuse.by_trade_group) {
    out.push(
      `    ${g.trade_group.padEnd(24)} reused ${g.actual_reuse}/${g.available_candidate_skills} ` +
        `ratio=${g.reuse_opportunity_ratio === null ? "NULL" : g.reuse_opportunity_ratio} ` +
        `new=${g.new_skills} (${g.limitation})`,
    );
  }

  if (verdict.blocking.length > 0) {
    out.push(`  BLOCKING (${verdict.blocking.length}):`);
    for (const f of verdict.blocking) {
      out.push(`    ${f.code} ${f.subject} — ${f.reason}`);
      for (const e of f.evidence) out.push(`      ${e}`);
    }
  }
  const attributableAdvisory = verdict.advisory.filter((f) => isBlockingCode(f.code));
  if (attributableAdvisory.length > 0) {
    out.push(
      `  PRE-EXISTING (${attributableAdvisory.length}) — blocking-class findings NOT attributable to ` +
        `this change. Not blocked here; they still block a seed, where everything is accountable:`,
    );
    for (const f of attributableAdvisory) out.push(`    ${f.code} ${f.subject}`);
  }
  const questions = verdict.advisory.filter((f) => !isBlockingCode(f.code));
  if (questions.length > 0) {
    out.push(`  ADVISORY (${questions.length}) — questions for a human, never enforced:`);
    for (const f of questions) out.push(`    ${f.code} ${f.subject}`);
  }
  return out;
}

// ===========================================================================
// `pnpm db:report:taxonomy` — the analysis WITHOUT the teeth
// ===========================================================================

/**
 * Report on the committed corpus. Exits 0 by default even when the gate would block, because
 * this command exists to be run while fixing things and a report that aborts is a report you
 * stop running. `--gate` opts into the exit code, so CI can adopt it later without changing
 * what the plain command means.
 *
 * NO DATABASE, for the reason `db:verify:taxonomy` gives: this proves the FILES are coherent.
 * Enforcement of the same findings lives where persistence happens — `--ingest` and the seed.
 */
function main(): void {
  const script = "report:taxonomy";
  const corpus = loadTaxonomyCorpus();
  const problems = validateTaxonomyCorpus(corpus.skills, corpus.edges, {
    domains: corpus.domains,
  });

  // No `attributableSkillIds`: a report on the committed corpus holds all of it accountable,
  // which is the same posture the seed takes.
  const findings = analyzeTaxonomyQuality(corpus.skills, corpus.edges, {
    domains: corpus.domains,
    problems,
  });
  const verdict = taxonomyQualityVerdict(findings);

  console.log(`[${script}] corpus at data/taxonomy`);
  console.log(`  structural problems      = ${problems.length} (see db:verify:taxonomy)`);

  // ANNOUNCED BEFORE THE VERDICT, NOT AFTER IT. "PASS" over an empty corpus is the exact
  // shape of a silently-missing data directory, and a caveat printed below thirty lines of
  // zeroes is a caveat nobody reads. `db:verify:taxonomy` draws the same line for the same
  // reason.
  const empty = corpus.skills.length === 0 && corpus.edges.length === 0;
  if (empty) {
    console.log(
      `[${script}] corpus contains NO skills and NO edges — nothing was analysed. The verdict ` +
        `below is vacuous: a gate that had nothing to inspect did not pass anything. Every ` +
        `per-group "reused 0/N" line means "no edges exist", not "the generator failed to reuse".`,
    );
  }
  for (const line of formatTaxonomyQualityReport(findings, verdict)) console.log(`  ${line}`);

  if (!empty && verdict.verdict === "BLOCK" && process.argv.includes("--gate")) process.exit(1);
}

// Guarded so importing the gate (the ingest, the seed, the tests) does not run the CLI.
if (process.argv[1] && /taxonomy-quality-gate\.ts$/.test(process.argv[1])) {
  main();
}
