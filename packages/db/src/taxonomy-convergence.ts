/**
 * CONVERGENCE + SENIORITY detectors — did semantically equivalent candidates across related
 * domains land on ONE canonical skill, or fragment into several near-duplicates?
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE CHANGING ANYTHING HERE
 * ---------------------------------------------------------------------------
 * This detector exists to find BAD BEHAVIOUR. It must never force a predetermined taxonomy.
 *
 *   EXPECTED:  semantic equivalence  ->  convergence
 *   FORBIDDEN: same trade group      ->  same skill
 *
 * A genuinely distinct skill MUST be allowed to exist in a related domain. "Gas torch flame
 * setting" (a Welder-Gas skill) and "Welding machine program setting" (a Welder-Machine
 * skill) are two different things that a shop floor hires on separately, and a detector that
 * demanded they merge would be actively destroying the taxonomy it was meant to audit — the
 * employer picker for gas welding would then offer a machine-programming skill, and the
 * matcher would rank a machine operator into a torch job.
 *
 * So FRAGMENTED is reported ONLY when two skills reached by the same concept probe are
 * semantically equivalent BY EVIDENCE — identical normalized labels, a shared surface form,
 * or one label being a bounded strict token-subset of the other (see
 * `equivalenceEvidence`). Nothing in this file reads `trade_group`; a
 * {@link ConvergenceGroup} names DOMAIN IDS and the concepts to check, and that is a
 * structural guarantee, not a promise — the field is not an input.
 *
 * Where evidence is weak or absent but two skills answered the same probe, the finding is
 * NEEDS_REVIEW. That is not a failure. It says "a human has to look", which is the honest
 * answer when the machine cannot tell a synonym from a specialisation.
 *
 * ---------------------------------------------------------------------------
 * THE SENIORITY DETECTOR
 * ---------------------------------------------------------------------------
 * "Assistant Masonry" is not a skill. It is a rung on a ladder wearing a skill's clothes,
 * and it is one of the two most common ways a model pads a trade it does not know well (the
 * other being the over-generic single word the validator's stoplist already catches). Left
 * in, it seeds, it embeds, it appears on the employer's picker, and it tells an employer
 * nothing — every helper in the trade "has" it, so it separates no two candidates.
 *
 * The rule is deliberately narrow: a label is flagged only when its seniority word is
 * carrying the whole label — the word alone, or the word plus the domain's own name, or the
 * word plus generic filler. "Supervisor level scaffold inspection" keeps `scaffold` and is
 * NOT flagged, because there a real technical capability is merely being qualified.
 *
 * PRIVACY: trade vocabulary and published occupation ids only.
 */
import {
  type TaxonomyDomainRecord,
  type TaxonomyDomainSkillRecord,
  type TaxonomySkillRecord,
} from "./taxonomy-corpus";
import {
  equivalenceEvidence,
  isUninformativeToken,
  normalizedTokens,
  shippedSkillViews,
  surfaceOfCorpusSkill,
  surfaceOfShippedSkill,
  taxonomyTokens,
  type ShippedSkillView,
  type SkillSurface,
} from "./taxonomy-lexical";

// ===========================================================================
// Inputs
// ===========================================================================

/**
 * One concept to look for across a group's domains.
 *
 * `probes` is the CALLER'S vocabulary for the concept, not evidence. A skill matches when
 * every token of a probe appears in one of the skill's surface forms (its label or one of
 * its aliases), compared on RAW normalized tokens — no stoplist. That is deliberate: a probe
 * is an exact question ("which skills here are about Fanuc?"), and running it through the
 * informative-token filter would let a probe made entirely of generic words ("machine")
 * degenerate into a probe that matches everything.
 *
 * List the variants you mean. `["g-code", "gcode", "g code"]` is three probes because a
 * generated corpus will contain all three spellings and the detector does no morphology.
 */
export interface ConvergenceConcept {
  /** Report key. Free text. */
  concept: string;
  probes: readonly string[];
}

/**
 * A set of RELATED DOMAINS and the concepts to check across them.
 *
 * Domains are named by id. There is no `trade_group` field and there must never be one —
 * see the file header. Grouping is the caller's editorial judgement about which trades ought
 * to share vocabulary; the detector's judgement is only ever about whether two skills SAY
 * the same thing.
 */
export interface ConvergenceGroup {
  group: string;
  job_domain_ids: readonly string[];
  concepts: readonly ConvergenceConcept[];
}

export interface DetectConvergenceOptions {
  /**
   * The shipped vocabulary, so a concept reached by REUSING a shipped skill (which has no
   * corpus record — that is what a reuse looks like) is still visible to the detector.
   * Defaults to `SKILL_CORPUS` minus deprecated. Injectable for tests, same reason as
   * everywhere else in this layer.
   */
  shipped?: readonly ShippedSkillView[];
}

// ===========================================================================
// Output
// ===========================================================================

export type ConvergenceStatus =
  /** One skill id carries this concept across every domain that produced it. */
  | "CONVERGED"
  /** Two or more SEMANTICALLY EQUIVALENT skill ids carry it. This is the bug. */
  | "FRAGMENTED"
  /** No domain in the group produced the concept at all. */
  | "ABSENT"
  /** Two or more skills answered the probe and the machine cannot tell whether they are
   *  the same thing. A human rules. NOT a failure. */
  | "NEEDS_REVIEW";

export interface ConvergenceFinding {
  group: string;
  concept: string;
  status: ConvergenceStatus;
  /** Every skill id the probes reached, sorted. */
  skill_ids: string[];
  /** For FRAGMENTED: each equivalence class of 2+ ids. Empty otherwise. */
  fragmented_clusters: string[][];
  /** Group domains that emitted at least one matching skill. */
  domains_with_concept: string[];
  /**
   * Group domains that emitted none.
   *
   * REPORTED, NEVER PENALISED. A domain that simply did not produce a concept has not
   * fragmented anything — there is no second row to split it with. Silence is a coverage
   * question for the reviewer, not a convergence failure.
   */
  domains_without_concept: string[];
  evidence: string[];
  reason: string;
}

export interface ConvergenceReport {
  findings: ConvergenceFinding[];
  totals: Record<ConvergenceStatus, number>;
}

export const CONVERGENCE_STATUSES: readonly ConvergenceStatus[] = [
  "CONVERGED",
  "FRAGMENTED",
  "ABSENT",
  "NEEDS_REVIEW",
];

// ===========================================================================
// detectConvergence
// ===========================================================================

/** Every skill the corpus can talk about, keyed by id: corpus records first, then shipped. */
function surfaceIndex(
  skills: readonly TaxonomySkillRecord[],
  shipped: readonly ShippedSkillView[],
): Map<string, SkillSurface> {
  const index = new Map<string, SkillSurface>();
  for (const view of shipped) index.set(view.skill_id, surfaceOfShippedSkill(view));
  for (const s of skills) {
    if (typeof s.skill_id !== "string" || s.skill_id.length === 0) continue;
    // A corpus record wins over the shipped view of the same id: a `reuses_existing` record
    // exists precisely to add aliases, and those aliases are part of what the probes must
    // be able to reach.
    index.set(s.skill_id, surfaceOfCorpusSkill(s));
  }
  return index;
}

/** True when every token of `probe` appears in one of the skill's surface forms. */
function probeMatches(probe: string, surface: SkillSurface): boolean {
  const wanted = normalizedTokens(probe);
  if (wanted.length === 0) return false;
  return surface.surface_norms.some((form) => {
    const have = new Set(taxonomyTokens(form));
    return wanted.every((t) => have.has(t));
  });
}

/**
 * Detect, per concept, whether the group's domains converged on one canonical skill.
 *
 * PURE. `groups` is the only editorial input, and it carries domain ids — never a trade
 * group. See the header for why that distinction is the whole design.
 */
export function detectConvergence(
  skills: readonly TaxonomySkillRecord[],
  edges: readonly TaxonomyDomainSkillRecord[],
  groups: readonly ConvergenceGroup[],
  opts: DetectConvergenceOptions = {},
): ConvergenceReport {
  const index = surfaceIndex(skills, opts.shipped ?? shippedSkillViews());

  const findings: ConvergenceFinding[] = [];
  for (const group of groups) {
    const inGroup = new Set(group.job_domain_ids);
    /** skill_id -> the group domains that emitted it. */
    const emitters = new Map<string, Set<string>>();
    for (const e of edges) {
      if (!inGroup.has(e.job_domain_id)) continue;
      if (typeof e.skill_id !== "string" || e.skill_id.length === 0) continue;
      let bucket = emitters.get(e.skill_id);
      if (bucket === undefined) {
        bucket = new Set<string>();
        emitters.set(e.skill_id, bucket);
      }
      bucket.add(e.job_domain_id);
    }

    for (const concept of group.concepts) {
      findings.push(analyseConcept(group, concept, emitters, index));
    }
  }

  const totals = Object.fromEntries(CONVERGENCE_STATUSES.map((s) => [s, 0])) as Record<
    ConvergenceStatus,
    number
  >;
  for (const f of findings) totals[f.status] += 1;
  return { findings, totals };
}

function analyseConcept(
  group: ConvergenceGroup,
  concept: ConvergenceConcept,
  emitters: ReadonlyMap<string, ReadonlySet<string>>,
  index: ReadonlyMap<string, SkillSurface>,
): ConvergenceFinding {
  const matched: SkillSurface[] = [];
  const coveredDomains = new Set<string>();
  for (const [skillId, domains] of [...emitters.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const surface = index.get(skillId);
    if (surface === undefined) continue; // EDGE_UNKNOWN_SKILL — the validator's business.
    if (!concept.probes.some((p) => probeMatches(p, surface))) continue;
    matched.push(surface);
    for (const d of domains) coveredDomains.add(d);
  }

  const base = {
    group: group.group,
    concept: concept.concept,
    skill_ids: matched.map((m) => m.skill_id).sort(),
    domains_with_concept: [...coveredDomains].sort(),
    domains_without_concept: group.job_domain_ids.filter((d) => !coveredDomains.has(d)).sort(),
  };

  if (matched.length === 0) {
    return {
      ...base,
      status: "ABSENT",
      fragmented_clusters: [],
      evidence: [],
      reason: `no domain in this group emitted a skill matching ${concept.probes.map((p) => JSON.stringify(p)).join(" | ")}.`,
    };
  }
  if (matched.length === 1) {
    return {
      ...base,
      status: "CONVERGED",
      fragmented_clusters: [],
      evidence: [],
      reason:
        `one canonical skill (${base.skill_ids[0] as string}) carries this concept across ` +
        `${base.domains_with_concept.length} of ${group.job_domain_ids.length} domain(s). Domains that ` +
        `did not emit it have not fragmented anything.`,
    };
  }

  // ── 2+ matches: are they the SAME concept, by evidence? ───────────────────
  const parent = new Map<string, string>(matched.map((m) => [m.skill_id, m.skill_id]));
  const find = (x: string): string => {
    let root = x;
    for (;;) {
      const next = parent.get(root);
      if (next === undefined || next === root) break;
      root = next;
    }
    return root;
  };
  const strong: string[] = [];
  const weak: string[] = [];
  for (let i = 0; i < matched.length; i += 1) {
    for (let j = i + 1; j < matched.length; j += 1) {
      const a = matched[i] as SkillSurface;
      const b = matched[j] as SkillSurface;
      const evidence = equivalenceEvidence(a, b);
      if (evidence === null) continue;
      const line = `${evidence.strength.toUpperCase()}:${evidence.relation} ${evidence.detail}`;
      if (evidence.strength === "strong") {
        strong.push(line);
        const ra = find(a.skill_id);
        const rb = find(b.skill_id);
        if (ra !== rb) parent.set(ra, rb);
      } else {
        weak.push(line);
      }
    }
  }

  const byRoot = new Map<string, string[]>();
  for (const m of matched) {
    const root = find(m.skill_id);
    const bucket = byRoot.get(root);
    if (bucket === undefined) byRoot.set(root, [m.skill_id]);
    else bucket.push(m.skill_id);
  }
  const clusters = [...byRoot.values()]
    .filter((c) => c.length >= 2)
    .map((c) => [...c].sort())
    .sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));

  if (clusters.length > 0) {
    return {
      ...base,
      status: "FRAGMENTED",
      fragmented_clusters: clusters,
      evidence: [...strong, ...weak],
      reason:
        `${clusters.flat().length} semantically equivalent skills carry one concept across these ` +
        `domains. Half the workers who have it will match only the postings that happened to pick ` +
        `the same row.`,
    };
  }

  return {
    ...base,
    status: "NEEDS_REVIEW",
    fragmented_clusters: [],
    evidence: weak,
    reason:
      weak.length > 0
        ? `${matched.length} skills answered this probe and share some vocabulary, but no label ` +
          `contains another and none share an alias. Too weak to call fragmentation; a human rules.`
        : `${matched.length} skills answered this probe with NO evidence of equivalence. They are ` +
          `most likely genuinely distinct — which is allowed — or the probe is too broad. This is ` +
          `NOT a fragmentation finding.`,
  };
}

// ===========================================================================
// Seniority detector
// ===========================================================================

/**
 * Level words, not capabilities. Hinglish included because a Hindi-first corpus will use it:
 * `sahayak` (assistant) and `madadgar` (helper) are what a supervisor actually says.
 *
 * `in-charge` and `incharge` are both listed because the normalizer keeps `-` inside a word,
 * so the hyphenated spelling survives as one surface token, while the tokenizer splits on it
 * for comparison — the pair below covers both readings. See `seniorityTokensOf`.
 */
export const SENIORITY_WORDS: readonly string[] = [
  "assistant",
  "helper",
  "senior",
  "junior",
  "trainee",
  "apprentice",
  "supervisor",
  "in-charge",
  "incharge",
  "sahayak",
  "madadgar",
];

const SENIORITY_SET: ReadonlySet<string> = new Set(SENIORITY_WORDS);

/**
 * How much of a leading stem two tokens must share before one is treated as the other's
 * morphological variant — `mason` / `masonry`, `stone` / `stonework`.
 *
 * FIVE, and only for tokens of at least five characters. Four would fold `weld` into
 * `welder`, which matters: "Trainee Welding Position Control" would then lose `welding` to
 * the domain name and be wrongly flagged as a pure seniority label. Five is short enough to
 * catch the `-ry`/`-work` suffixes that actually occur and long enough that it cannot eat a
 * technical term.
 */
export const MIN_DOMAIN_STEM_MATCH = 5;

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i += 1;
  return i;
}

/**
 * Tokens of a normalized label, with an adjacent `in charge` re-joined.
 *
 * The tokenizer splits on `-` (it has to, for overlap measures), which would turn the single
 * concept `in-charge` into the tokens `in` and `charge` — the first meaningless, the second
 * a plausible technical word. Re-joining restores the concept before anything is classified.
 */
function seniorityTokensOf(labelEn: string): string[] {
  const raw = normalizedTokens(labelEn);
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === "in" && raw[i + 1] === "charge") {
      out.push("in-charge");
      i += 1;
      continue;
    }
    out.push(raw[i] as string);
  }
  return out;
}

/** The breakdown behind a seniority verdict. Exported so the NOT-flagged direction is testable. */
export interface SeniorityBreakdown {
  label_en: string;
  /** Level words found. */
  seniority_tokens: string[];
  /** Tokens that are the domain's own name (or a morphological variant of it). */
  domain_name_tokens: string[];
  /** Tokens in `GENERIC_SKILL_STOPLIST` — filler that adds nothing either. */
  generic_tokens: string[];
  /** What is LEFT. A non-empty residue is a real technical capability being qualified. */
  residual_tokens: string[];
  /** True iff a level word is present AND nothing technical survives it. */
  flagged: boolean;
}

/**
 * Decide whether a label is a seniority rung rather than a capability.
 *
 * BOTH HALVES OF THE RULE MATTER. A level word must be present — otherwise a label made
 * entirely of generic filler ("machine work") would be flagged here, and that is the
 * validator's SKILL_LABEL_OVER_GENERIC, reported under the code a reviewer already knows.
 * And nothing technical may survive — otherwise "Supervisor level scaffold inspection", a
 * perfectly real skill, is condemned for the adjective in front of it.
 */
export function classifySeniorityLabel(
  labelEn: string,
  domainLabels: readonly string[],
): SeniorityBreakdown {
  const domainTokens = new Set<string>();
  for (const label of domainLabels) for (const t of normalizedTokens(label)) domainTokens.add(t);

  const seniority: string[] = [];
  const domainName: string[] = [];
  const generic: string[] = [];
  const residual: string[] = [];

  for (const token of seniorityTokensOf(labelEn)) {
    if (SENIORITY_SET.has(token)) {
      seniority.push(token);
      continue;
    }
    const isDomainName = [...domainTokens].some(
      (d) =>
        d === token ||
        (d.length >= MIN_DOMAIN_STEM_MATCH &&
          token.length >= MIN_DOMAIN_STEM_MATCH &&
          commonPrefixLength(d, token) >= MIN_DOMAIN_STEM_MATCH),
    );
    if (isDomainName) {
      domainName.push(token);
      continue;
    }
    if (isUninformativeToken(token)) {
      generic.push(token);
      continue;
    }
    residual.push(token);
  }

  return {
    label_en: labelEn,
    seniority_tokens: seniority,
    domain_name_tokens: domainName,
    generic_tokens: generic,
    residual_tokens: residual,
    flagged: seniority.length > 0 && residual.length === 0,
  };
}

export interface SeniorityFinding extends SeniorityBreakdown {
  skill_id: string;
  /** The domains this skill is attached to — the labels the check ran against. */
  job_domain_ids: string[];
  reason: string;
}

export interface DetectSeniorityOptions {
  /**
   * The domains in scope. REQUIRED, and in an options object for the reason the validator
   * gives: without them the "level word plus the domain's own name" half of the rule
   * silently does nothing, and a detector that quietly half-works is worse than one that
   * is obviously absent.
   */
  domains: readonly TaxonomyDomainRecord[];
}

/**
 * Every skill whose label is a seniority rung rather than a capability.
 *
 * Runs over the corpus RECORDS — the skills this batch minted. A reuse decision carries no
 * record because the shipped row already exists and was reviewed by a human when it shipped;
 * re-litigating `SKILL_CORPUS` here would produce findings nobody in this pipeline can act
 * on. Returns only the flags: the report is about bad behaviour, and a list that also
 * contains every healthy skill is a list nobody reads.
 */
export function detectSeniorityLabels(
  skills: readonly TaxonomySkillRecord[],
  edges: readonly TaxonomyDomainSkillRecord[],
  opts: DetectSeniorityOptions,
): SeniorityFinding[] {
  const domainLabel = new Map<string, string>();
  for (const d of opts.domains) {
    if (typeof d.job_domain_id !== "string") continue;
    domainLabel.set(d.job_domain_id, typeof d.label_en === "string" ? d.label_en : "");
  }

  const domainsOfSkill = new Map<string, Set<string>>();
  for (const e of edges) {
    if (typeof e.skill_id !== "string" || e.skill_id.length === 0) continue;
    let bucket = domainsOfSkill.get(e.skill_id);
    if (bucket === undefined) {
      bucket = new Set<string>();
      domainsOfSkill.set(e.skill_id, bucket);
    }
    bucket.add(e.job_domain_id);
  }

  const findings: SeniorityFinding[] = [];
  for (const s of skills) {
    if (typeof s.skill_id !== "string" || typeof s.label_en !== "string") continue;
    const domainIds = [...(domainsOfSkill.get(s.skill_id) ?? [])].sort();
    const labels = domainIds.map((id) => domainLabel.get(id) ?? "").filter((l) => l.length > 0);
    const breakdown = classifySeniorityLabel(s.label_en, labels);
    if (!breakdown.flagged) continue;
    findings.push({
      ...breakdown,
      skill_id: s.skill_id,
      job_domain_ids: domainIds,
      reason:
        `${JSON.stringify(s.label_en)} is a seniority/level word` +
        (breakdown.domain_name_tokens.length > 0 ? ` plus this domain's own name` : ``) +
        (breakdown.generic_tokens.length > 0 ? ` plus generic filler` : ``) +
        `, with no technical capability left in it. Every worker at that rung "has" it, so it ` +
        `separates no two candidates on the employer's picker.`,
    });
  }
  return findings.sort((a, b) => a.skill_id.localeCompare(b.skill_id));
}
