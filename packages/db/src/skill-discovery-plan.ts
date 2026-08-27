/**
 * THE DISCOVERY PLAN — sources in, a census and a candidate set out. Pure, no I/O, ₹0.
 *
 * ===========================================================================
 * TWO OUTPUTS, AND THE DIFFERENCE BETWEEN THEM IS THE WHOLE WORKLOAD ARGUMENT
 * ===========================================================================
 *   {@link DiscoveryCensus}     EVERY source phrase, counted by what happened to it.
 *                               Nothing is omitted, so the coverage report can answer
 *                               "out of the 9,121 aliases, how many…" without rounding.
 *   {@link DiscoveryPlan.candidates}
 *                               only the clusters that need a HUMAN DECISION.
 *
 * The gap between those two numbers is the reduction this workstream exists to produce, and
 * it is MEASURED rather than promised: the census says how many phrases went in, the
 * candidate count says how many decisions come out, and both are printed side by side.
 *
 * WHY THE TWO ARE NOT THE SAME LIST. An `OCCUPATION_ONLY` phrase ("Magician", "Operator") is
 * decided by a deterministic rule over a lexicon derived from the catalogue itself. Emitting
 * it as a `pending` candidate proposing `reject` would put thousands of rows in front of a
 * reviewer to rubber-stamp a rule they cannot meaningfully disagree with one row at a time —
 * and burying the genuine findings underneath them. Those phrases are COUNTED, their rule is
 * NAMED, and the run's fingerprint makes the whole classification reproducible; `--include-
 * rejected` emits them as rows when somebody actually wants to audit the rule.
 *
 * ===========================================================================
 * SIMILARITY IS EVIDENCE, NOT AUTHORIZATION (Phase 4)
 * ===========================================================================
 * {@link proposeAction} may only reach `map` or `merge` on a match whose strength is
 * `strong` — a literal surface hit, a consonant-skeleton fold, or an equality/subset relation
 * over informative tokens. A `weak` match (`high_token_overlap`) is ATTACHED to the candidate
 * so the reviewer sees it, and can never be the reason the machine suggests a resolution.
 *
 * That rule is not decoration. This repository has measured what weak similarity produces:
 * `ducting_installation -> plumber`, `visual_defect_identification -> quality_inspector`,
 * `split_unit_installation -> fitter`. Each is a defensible-looking number attached to a
 * wrong answer, and each would have been auto-mapped by a threshold. `validateCandidate`
 * re-asserts the rule as `WEAK_MATCH_DROVE_ACTION` so a future edit here fails a test rather
 * than shipping.
 *
 * ===========================================================================
 * NO THRESHOLD MOVES A STATUS
 * ===========================================================================
 * Everything this module writes is `pending` or `needs_review`. There is no branch that can
 * produce an approval, and {@link assertDryRunSafe} is called on the finished set so that
 * "there is no such branch" is checked rather than believed.
 *
 * PRIVACY: source rows arrive already pseudonymized (worker language) and are additionally
 * refused by the classifier if they carry a digit, `@` or a URL.
 */
import {
  classifyPhrase,
  warrantsExtraction,
  type ClassifierRule,
  type PhraseClass,
  type PhraseVerdict,
} from "./skill-discovery-classify";
import { agentStem, type HeadLexicon } from "./skill-discovery-heads";
import {
  bestMatch,
  clusterPhrases,
  isAliasOpportunity,
  isAlreadyCovered,
  matchExistingSkills,
  weakCollisions,
  type ExistingSkillIndex,
  type ExistingSkillMatch,
  type PhraseCluster,
  type WeakCollision,
} from "./skill-discovery-match";
import {
  assertDryRunSafe,
  candidateId,
  sealCandidate,
  validateCandidate,
  type CandidateMatch,
  type CandidateSource,
  type SkillCandidateAction,
  type SkillCandidateConfidenceBand,
  type SkillCandidateRecord,
  type SkillCandidateSourceType,
  type SkillCandidateStatus,
} from "./skill-discovery-candidate";

// ===========================================================================
// Input
// ===========================================================================

/** One source row, as the plan needs it. The CLI builds these from the database. */
export interface DiscoverySourceRow {
  readonly source_type: SkillCandidateSourceType;
  readonly source_id: string;
  readonly original_text: string;
  /** The `jd_*` domain this phrase was observed under, when the source has one. */
  readonly job_domain_id: string | null;
}

export interface DiscoveryPlanOptions {
  /**
   * Emit candidate rows for phrases the deterministic layer disposed of.
   *
   * OFF by default. On, the queue grows by the `REJECTED_NON_SKILL` + `OCCUPATION_ONLY`
   * population — useful precisely once, when somebody wants to audit the classifier's
   * verdicts as data rather than trust the rule.
   */
  readonly includeRejected?: boolean;
  /** How many competing existing-skill matches to attach. Default 5 — the brief's Phase 5. */
  readonly maxMatches?: number;
  /**
   * Minimum DISTINCT job domains a cluster must be attested in to enter the queue.
   *
   * Defaults to {@link DEFAULT_ATTESTATION_FLOOR} (1 — nothing dropped). Whatever a higher
   * floor excludes is reported as `census.below_attestation_floor`, never dropped silently.
   */
  readonly attestationFloor?: number;
}

export interface DiscoveryPlanInput {
  readonly runId: string;
  /** ISO-8601, injected. No clock is read inside this module. */
  readonly createdAt: string;
  /** Corpus digest + head-lexicon digest. See `skill-discovery-run.ts`. */
  readonly corpusFingerprint: string;
  readonly sources: readonly DiscoverySourceRow[];
  readonly lexicon: HeadLexicon;
  readonly index: ExistingSkillIndex;
  /** Resolve a domain to its trade family, for the report's breakdown. */
  readonly familyOf?: (jobDomainId: string) => string | null;
  readonly options?: DiscoveryPlanOptions;
}

// ===========================================================================
// Census
// ===========================================================================

/** What happened to one source phrase. Every phrase lands in exactly one bucket. */
export type Disposition =
  /** The classifier refused it: prose, forbidden characters, all-generic, too long. */
  | "rejected_non_skill"
  /** A job title with no modifier naming work. An occupation, not a skill. */
  | "occupation_only"
  /** Already a surface form of a shipped skill — the taxonomy covers this phrase. */
  | "covered_by_existing_skill"
  /** Strong equivalence to a shipped skill, but not yet one of its surface forms. */
  | "alias_opportunity"
  /** Skill-shaped and unmatched — a candidate NEW canonical skill. */
  | "new_skill_candidate"
  /** Shape and evidence both inconclusive. A reviewer's call. */
  | "ambiguous";

export const DISPOSITIONS: readonly Disposition[] = [
  "rejected_non_skill",
  "occupation_only",
  "covered_by_existing_skill",
  "alias_opportunity",
  "new_skill_candidate",
  "ambiguous",
];

export interface DiscoveryCensus {
  /** Source rows read, before any dedup. */
  readonly source_rows: number;
  readonly by_source_type: Readonly<Record<string, number>>;
  /** Distinct `normalizeOccupationText` outputs — the population everything else is over. */
  readonly normalized_unique: number;
  /** Distinct phrases per disposition. */
  readonly by_disposition: Readonly<Record<Disposition, number>>;
  /** Distinct phrases per classifier rule — the stable codes the report counts by. */
  readonly by_rule: Readonly<Record<string, number>>;
  /** Distinct phrases per shape class. */
  readonly by_phrase_class: Readonly<Record<string, number>>;
  /** Clusters formed over the phrases that reached clustering. */
  readonly clusters: number;
  /** Phrases that entered clustering (i.e. were not disposed of deterministically). */
  readonly clustered_phrases: number;
  /**
   * How many phrases the clustering ABSORBED — `clustered_phrases - clusters`.
   *
   * The dedup half of the reduction, reported separately from the classifier's half so the
   * two are not conflated into one flattering number.
   */
  readonly duplicates_absorbed: number;
  /** Candidate rows emitted — the number of human decisions this run produces. */
  readonly candidates: number;
  readonly candidates_by_action: Readonly<Record<SkillCandidateAction, number>>;
  readonly candidates_by_band: Readonly<Record<SkillCandidateConfidenceBand, number>>;
  /** Candidate counts per trade family, for the report's distribution table. */
  readonly candidates_by_family: Readonly<Record<string, number>>;
  /** Pairs the clusterer refused to merge on weak evidence. Escalated, never merged. */
  readonly weak_collisions: number;
  /**
   * Clusters excluded by the attestation floor.
   *
   * Reported so a queue cut is never invisible. Zero at the default floor of 1.
   */
  readonly below_attestation_floor: number;
  readonly attestation_floor: number;
  /** Clusters at each attestation breadth, so a floor can be chosen from evidence. */
  readonly clusters_by_attestation: Readonly<Record<string, number>>;
}

export interface DiscoveryPlan {
  readonly run_id: string;
  readonly census: DiscoveryCensus;
  readonly candidates: readonly SkillCandidateRecord[];
  readonly clusters: readonly PhraseCluster[];
  readonly weak_collisions: readonly WeakCollision[];
  /**
   * Every distinct phrase with its verdict and disposition.
   *
   * Carried so the report can show worked examples — including the ambiguous and unsafe
   * matches the brief's item 15 asks for — without re-running the classifier over 9,121 rows
   * and risking a different answer than the one the census counted.
   */
  readonly phrases: readonly PhraseOutcome[];
}

/** One distinct normalized phrase and everything decided about it. */
export interface PhraseOutcome {
  readonly normalized: string;
  /** The first original spelling seen for this normal form. Display only. */
  readonly original: string;
  readonly occurrences: number;
  readonly verdict: PhraseVerdict;
  readonly disposition: Disposition;
  readonly matches: readonly ExistingSkillMatch[];
  readonly job_domain_ids: readonly string[];
  readonly sources: readonly DiscoverySourceRow[];
}

// ===========================================================================
// Disposition, action, band
// ===========================================================================

/**
 * Where one phrase lands. Order encodes precedence.
 *
 * `covered_by_existing_skill` OUTRANKS the shape classes, and that is the important one: a
 * phrase that is already a `skill_alias` surface form is covered no matter what its head
 * noun looks like, and asking a reviewer about it would be asking them to re-decide
 * something the taxonomy already says.
 *
 * `rejected_non_skill` and `occupation_only` outrank `alias_opportunity`, because a prose
 * fragment that happens to share tokens with a shipped skill is still a prose fragment.
 */
export function disposition(
  verdict: PhraseVerdict,
  matches: readonly ExistingSkillMatch[],
): Disposition {
  const best = bestMatch(matches);
  if (isAlreadyCovered(best)) return "covered_by_existing_skill";
  if (verdict.phraseClass === "REJECTED_NON_SKILL") return "rejected_non_skill";
  if (verdict.phraseClass === "OCCUPATION_ONLY") return "occupation_only";
  if (isAliasOpportunity(best)) return "alias_opportunity";
  if (verdict.phraseClass === "AMBIGUOUS") return "ambiguous";
  return "new_skill_candidate";
}

/**
 * What the pipeline SUGGESTS a reviewer do. A suggestion, and nothing more.
 *
 * THE ONE HARD RULE: `map` and `merge` require a STRONG match. A weak one is shown and never
 * acted on — see the module header for the three measured false matches that rule exists for.
 */
export function proposeAction(d: Disposition, matches: readonly ExistingSkillMatch[]): SkillCandidateAction {
  const strong = matches.find((m) => m.strength === "strong");
  switch (d) {
    case "rejected_non_skill":
    case "occupation_only":
      return "reject";
    case "covered_by_existing_skill":
      // Already a surface form. There is nothing to create; the only coherent suggestion is
      // to attach the cluster's OTHER spellings to the skill that already answers to this one.
      return strong === undefined ? "review" : "map";
    case "alias_opportunity":
      return strong === undefined ? "review" : "map";
    case "new_skill_candidate":
      return "create";
    case "ambiguous":
      return "review";
  }
}

/**
 * How sure the pipeline is ABOUT ITS OWN SUGGESTION — not about the phrase, and not about
 * whether the skill is worth having.
 *
 * Stating that narrowly is what keeps the band honest. "High" on a `reject` means "the
 * deterministic rule that fired is one a reviewer will almost always agree with", not "this
 * phrase is definitely worthless".
 *
 *   high    a literal surface hit, or a rule with no judgement in it (forbidden characters,
 *           nothing left after normalization, prose by the shared `isProse` rule).
 *   medium  a strong-but-inferred match, or an occupation head with no modifier — defensible,
 *           and wrong often enough that a reviewer should see it.
 *   low     everything else, and every `review`.
 */
export function confidenceBand(
  d: Disposition,
  verdict: PhraseVerdict,
  matches: readonly ExistingSkillMatch[],
): SkillCandidateConfidenceBand {
  const best = bestMatch(matches);
  if (best !== null && best.relation === "exact_surface") return "high";

  const MECHANICAL: readonly ClassifierRule[] = [
    "FORBIDDEN_CHARS",
    "NORMALIZES_EMPTY",
    "PROSE_FRAGMENT",
    "TOO_LONG",
    "ALL_TOKENS_GENERIC",
  ];
  if (d === "rejected_non_skill" && MECHANICAL.includes(verdict.rule)) return "high";

  if (d === "ambiguous") return "low";
  if (best !== null && best.strength === "strong") return "medium";
  if (d === "occupation_only") return "medium";
  return "low";
}

/**
 * The numeric confidence, or `null`.
 *
 * NULL FOR EVERY DETERMINISTIC-ONLY VERDICT, deliberately. A rule that fired is not a
 * probability, and dressing "the head noun is in the lexicon" as `0.85` invents a calibration
 * nobody measured — which is exactly the kind of number that later gets thresholded on.
 *
 * A number appears only where a real score drove the suggestion: the match evidence. When the
 * extraction model runs it supplies its own, and that one is the model's claim, recorded as
 * provenance alongside the model id and prompt version that produced it.
 */
export function confidenceValue(
  action: SkillCandidateAction,
  matches: readonly ExistingSkillMatch[],
): number | null {
  if (action !== "map" && action !== "merge") return null;
  const strong = matches.find((m) => m.strength === "strong");
  return strong?.score ?? null;
}

/**
 * The status a discovery run writes.
 *
 * Both values are in `MACHINE_WRITABLE_STATUSES`. `needs_review` is used where the pipeline
 * has explicitly declined to suggest anything — the brief's rule that ambiguity becomes a
 * queue item rather than a stopping point.
 */
export function initialStatus(action: SkillCandidateAction): SkillCandidateStatus {
  return action === "review" ? "needs_review" : "pending";
}

// ===========================================================================
// The discovery key — WHAT a cluster is keyed on
// ===========================================================================

/**
 * The string a phrase is CLUSTERED by, which is not always the phrase itself.
 *
 * ── THE DEFECT THIS FIXES, MEASURED ──
 *
 * Clustering on the full normalized phrase keeps `"strip mill operator"`,
 * `"strip mill foreman"` and `"strip mill attendant"` apart: they share no strong lexical
 * relation, because their most distinctive tokens are three DIFFERENT occupation heads. Three
 * separate candidates then arrive at review, each proposing the same underlying work, and a
 * reviewer has to notice that themselves — three times.
 *
 * The first full dry run (2026-08-26) produced 4,791 candidates from 7,504 decidable phrases
 * on exactly that basis. The occupation head is the token doing the splitting, and it is also
 * the one token we have already established is IDENTITY rather than work.
 *
 * ── SO THE KEY IS THE WORK, NOT THE TITLE ──
 *
 *   OCCUPATION_WITH_SKILL_EVIDENCE   the evidence tokens PLUS the action stem of each
 *                                    occupation head, sorted. `"operator, strip mill"` and
 *                                    `"strip mill operator"` -> `"mill operat strip"`. One
 *                                    candidate, both sources, every original spelling preserved
 *                                    on `skill_candidate_source`.
 *
 *                                    THE HEAD STEM IS IN THE KEY AND THE HEAD IS NOT. An agent
 *                                    noun is a person AND an action; dropping it entirely (the
 *                                    first design) collapsed "wood turner", "wood sawyer" and
 *                                    "wood driller" onto the single key `"wood"` — 35 phrases
 *                                    and five trades under one proposal. See `agentStem`.
 *   everything else                  the normalized phrase. An ACTIVITY_PHRASE already names
 *                                    work rather than a person, and an `alias_opportunity`
 *                                    must keep its exact wording — the whole point of it is
 *                                    that a specific SPELLING should be attached to a skill.
 *
 * SORTED, so word order cannot split a cluster: `"mill strip"` from `"Strip Mill Operator"`
 * and from `"Operator, Mill Strip"` are one key. This is the same normalization-then-set move
 * `informative_tokens_equal` already makes in `taxonomy-lexical.ts`.
 *
 * THE KEY IS NOT THE LABEL. `skill_candidate` deliberately carries `cluster_key` and
 * `normalized_phrase` as two columns: this is the identifier, and the representative phrase is
 * what a human reads. A model proposes the actual wording later, and a reviewer corrects it.
 */
export function discoveryKey(outcome: PhraseOutcome): string {
  if (outcome.verdict.phraseClass === "OCCUPATION_WITH_SKILL_EVIDENCE") {
    const evidence = outcome.verdict.evidenceTokens;
    if (evidence.length > 0) {
      const stems = outcome.verdict.occupationHeads.map((h) => agentStem(h));
      return [...new Set([...evidence, ...stems])].sort().join(" ");
    }
  }
  return outcome.normalized;
}

/**
 * How widely a cluster is attested, and the floor a queue can be cut at.
 *
 * NOT A THRESHOLD ON CORRECTNESS. A key attested in one domain is not less likely to be a real
 * skill; it is less likely to be worth a reviewer's next hour, because a concept that appears
 * in a single NCO unit group is usually one trade's local vocabulary rather than a
 * cross-cutting competency. The floor is therefore a QUEUE control, it defaults to 1 (nothing
 * dropped), and whatever it excludes is COUNTED AND REPORTED rather than silently trimmed —
 * a report that says "4,791 candidates" while a flag quietly kept 700 is worse than no report.
 */
export const DEFAULT_ATTESTATION_FLOOR = 1;

// ===========================================================================
// The plan
// ===========================================================================

function bump(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function record<T extends string>(map: Map<string, number>, keys: readonly T[]): Record<T, number> {
  const out = {} as Record<T, number>;
  for (const k of keys) out[k] = map.get(k) ?? 0;
  for (const [k, v] of map) if (!(k in out)) (out as Record<string, number>)[k] = v;
  return out;
}

/**
 * Build the plan.
 *
 * FOUR PASSES, in this order, and the order is the cost argument:
 *   1. normalize + dedup       — collapses 9,121 rows onto their distinct normal forms.
 *   2. classify                — free; disposes of prose, residue and bare occupation titles.
 *   3. match existing skills   — free; two exact-equality probes then a bounded evidence scan.
 *   4. cluster the survivors   — quadratic, and only ever over what survived steps 2 and 3.
 *
 * Step 4 is why steps 2 and 3 come first. Clustering the raw population would be ~38M pair
 * comparisons; clustering the survivors is a fraction of that, and the reduction is reported
 * rather than assumed.
 */
export function buildDiscoveryPlan(input: DiscoveryPlanInput): DiscoveryPlan {
  const maxMatches = input.options?.maxMatches ?? 5;
  const includeRejected = input.options?.includeRejected ?? false;
  const attestationFloor = input.options?.attestationFloor ?? DEFAULT_ATTESTATION_FLOOR;

  // ── pass 1: normalize + dedup ───────────────────────────────────────────
  const bySourceType = new Map<string, number>();
  const grouped = new Map<string, { original: string; sources: DiscoverySourceRow[] }>();
  for (const row of input.sources) {
    bump(bySourceType, row.source_type);
    const verdict = classifyPhrase(row.original_text, input.lexicon);
    const key = verdict.normalized;
    const existing = grouped.get(key);
    if (existing === undefined) grouped.set(key, { original: row.original_text, sources: [row] });
    else existing.sources.push(row);
  }

  // ── passes 2 + 3: classify and match, once per distinct phrase ──────────
  const byDisposition = new Map<string, number>();
  const byRule = new Map<string, number>();
  const byClass = new Map<string, number>();
  const outcomes: PhraseOutcome[] = [];

  for (const [normalized, group] of grouped) {
    const verdict = classifyPhrase(group.original, input.lexicon);
    const matches = matchExistingSkills(normalized, input.index, maxMatches);
    const d = disposition(verdict, matches);
    bump(byDisposition, d);
    bump(byRule, verdict.rule);
    bump(byClass, verdict.phraseClass);
    outcomes.push({
      normalized,
      original: group.original,
      occurrences: group.sources.length,
      verdict,
      disposition: d,
      matches,
      job_domain_ids: [
        ...new Set(group.sources.map((s) => s.job_domain_id).filter((x): x is string => x !== null)),
      ].sort(),
      sources: group.sources,
    });
  }

  // ── pass 4: cluster only what needs a decision ──────────────────────────
  //
  // Keyed on `discoveryKey`, not on the phrase — see that function for the measured reason.
  // Several phrases share one key by construction ("strip mill operator"/"strip mill foreman"),
  // so the counts fed to the clusterer are SUMMED per key and every contributing outcome is
  // kept on `byKey` so no source is lost.
  const decidable = outcomes.filter((o) => includeRejected || needsDecision(o));
  const byKey = new Map<string, PhraseOutcome[]>();
  const counts = new Map<string, number>();
  for (const o of decidable) {
    const key = discoveryKey(o);
    const bucket = byKey.get(key);
    if (bucket === undefined) byKey.set(key, [o]);
    else bucket.push(o);
    counts.set(key, (counts.get(key) ?? 0) + o.occurrences);
  }
  const clusters = clusterPhrases(counts);
  const collisions = weakCollisions(clusters);

  // ── emit candidates, one per cluster ────────────────────────────────────
  const byAction = new Map<string, number>();
  const byBand = new Map<string, number>();
  const byFamily = new Map<string, number>();
  const candidates: SkillCandidateRecord[] = [];

  const attestationCounts = new Map<string, number>();
  let belowFloor = 0;

  for (const cluster of clusters) {
    const members = cluster.members.flatMap((m) => byKey.get(m.normalized) ?? []);
    if (members.length === 0) continue;

    // The cluster's representative outcome drives the verdict fields; every member
    // contributes sources, so nothing the clustering absorbed is lost. The representative is
    // the most-attested phrase under the canonical key, ties broken alphabetically — a total
    // order, so the same input always produces the same representative and a re-run is diffable.
    const lead =
      [...(byKey.get(cluster.canonical) ?? members)].sort(
        (a, b) => b.occurrences - a.occurrences || a.normalized.localeCompare(b.normalized),
      )[0] ?? (members[0] as PhraseOutcome);

    // The competing-match list is the UNION across members, best score per skill kept —
    // a spelling variant that matched something the representative did not is exactly the
    // evidence a reviewer needs, and dropping it would make the cluster hide it.
    const merged = new Map<string, ExistingSkillMatch>();
    for (const member of members) {
      for (const m of member.matches) {
        const prev = merged.get(m.skillId);
        if (prev === undefined || m.score > prev.score) merged.set(m.skillId, m);
      }
    }
    const matches = [...merged.values()]
      .sort((a, b) => b.score - a.score || a.skillId.localeCompare(b.skillId))
      .slice(0, maxMatches);

    const d = disposition(lead.verdict, matches);
    const action = proposeAction(d, matches);
    const band = confidenceBand(d, lead.verdict, matches);

    const sources: CandidateSource[] = [];
    const seenSource = new Set<string>();
    for (const member of members) {
      for (const s of member.sources) {
        const key = `${s.source_type}\u0001${s.source_id}`;
        if (seenSource.has(key)) continue;
        seenSource.add(key);
        sources.push({
          source_type: s.source_type,
          source_id: s.source_id,
          original_text: s.original_text,
          normalized_text: member.normalized,
          job_domain_id: s.job_domain_id,
        });
      }
    }

    const domains = [...new Set(sources.map((s) => s.job_domain_id).filter((x): x is string => x !== null))];
    const family = resolveFamily(domains, input.familyOf);

    // The attestation histogram is built over EVERY cluster, including the ones the floor
    // excludes — a distribution that only counted survivors could not be used to choose a floor.
    bump(attestationCounts, String(domains.length));
    if (domains.length < attestationFloor) {
      belowFloor += 1;
      continue;
    }

    const candidateMatches: CandidateMatch[] = matches.map((m, i) => ({
      skill_id: m.skillId,
      relation: m.relation,
      score: m.score,
      strength: m.strength,
      rank: i + 1,
      evidence_detail: m.detail,
    }));

    const id = candidateId(input.runId, cluster.key);
    candidates.push(
      sealCandidate({
        candidate_id: id,
        run_id: input.runId,
        cluster_key: cluster.key,
        normalized_phrase: cluster.canonical,
        // The DETERMINISTIC layer never proposes a label — inventing wording is a judgement
        // it has no basis for. The extraction stage fills this; a reviewer may correct it.
        proposed_skill_name: null,
        proposed_description: null,
        phrase_class: lead.verdict.phraseClass,
        classifier_rule: lead.verdict.rule,
        occupation_heads: lead.verdict.occupationHeads,
        evidence_tokens: lead.verdict.evidenceTokens,
        trade_family: family,
        source_alias_count: sources.length,
        source_domain_count: domains.length,
        proposed_action: action,
        confidence_band: band,
        confidence: confidenceValue(action, matches),
        status: initialStatus(action),
        reviewer_admin_id: null,
        reviewed_at: null,
        review_reason: null,
        resulting_skill_id: null,
        // EMPTY, and the pipeline can never fill it. Which trades a discovered skill belongs to
        // is a judgement about what work a trade requires; all this run observed is where a
        // phrase appeared. The reviewer names them on the review screen — see the
        // `approvedJobDomainIds` docblock in `schema/skill-discovery.ts`.
        approved_job_domain_ids: [],
        approved_requirement: "preferred",
        // Every source phrase in this run comes from a table whose vectors are already paid
        // for; the CLI overrides this when a source without a stored vector is included.
        embedding_status: "not_required",
        model: null,
        prompt_version: null,
        corpus_fingerprint: input.corpusFingerprint,
        created_at: input.createdAt,
        sources,
        matches: candidateMatches,
      }),
    );

    bump(byAction, action);
    bump(byBand, band);
    if (family !== null) bump(byFamily, family);
  }

  // The Phase-14 hard guard. Throws rather than filters: a run that produced an approval has
  // a bug whose blast radius is the production taxonomy, and continuing would hide it.
  assertDryRunSafe(candidates);

  // AND THE FULL VALIDATOR, ON EVERY EMITTED ROW.
  //
  // Not belt-and-braces — it caught a real defect the first time it was wired in. The dry run
  // of 2026-08-26 emitted seven candidates whose competing-match list contained `mskill_*` ids,
  // because the existing-skill index was built over the whole `skill` table. Nothing else in
  // the pipeline would have noticed until a reviewer was shown the option.
  //
  // THROWS on the first bad batch rather than filtering, for the same reason `assertDryRunSafe`
  // does: a candidate set that violates its own contract is not partially usable, and emitting
  // the good rows would turn a loud bug into a quiet one.
  const problems = candidates.flatMap((c) => validateCandidate(c));
  if (problems.length > 0) {
    const sample = problems
      .slice(0, 8)
      .map((p) => `${p.candidate_id.slice(0, 8)}: ${p.code} — ${p.detail}`)
      .join("\n  ");
    throw new Error(
      `buildDiscoveryPlan: ${problems.length} candidate validation problem(s) across ` +
        `${candidates.length} candidates. Refusing the whole run.\n  ${sample}`,
    );
  }

  const census: DiscoveryCensus = {
    source_rows: input.sources.length,
    by_source_type: record(bySourceType, []),
    normalized_unique: grouped.size,
    by_disposition: record(byDisposition, DISPOSITIONS) as Record<Disposition, number>,
    by_rule: record(byRule, []),
    by_phrase_class: record(byClass, []),
    clusters: clusters.length,
    clustered_phrases: decidable.length,
    duplicates_absorbed: decidable.length - clusters.length,
    below_attestation_floor: belowFloor,
    attestation_floor: attestationFloor,
    clusters_by_attestation: record(attestationCounts, []),
    candidates: candidates.length,
    candidates_by_action: record(byAction, ["map", "create", "merge", "reject", "review"]) as Record<
      SkillCandidateAction,
      number
    >,
    candidates_by_band: record(byBand, ["high", "medium", "low"]) as Record<
      SkillCandidateConfidenceBand,
      number
    >,
    candidates_by_family: record(byFamily, []),
    weak_collisions: collisions.length,
  };

  return {
    run_id: input.runId,
    census,
    candidates,
    clusters,
    weak_collisions: collisions,
    phrases: outcomes,
  };
}

/**
 * Does this phrase need a human decision?
 *
 * `covered_by_existing_skill` is EXCLUDED — the taxonomy already answers it, and re-asking is
 * how a review queue fills with confirmations. `alias_opportunity` is INCLUDED even though
 * the machine is fairly sure, because attaching an alias to a skill is still a permanent
 * taxonomy edit and `ALIAS_AMBIGUOUS` is a real failure mode.
 */
export function needsDecision(o: PhraseOutcome): boolean {
  if (o.disposition === "covered_by_existing_skill") return false;
  if (o.disposition === "rejected_non_skill" || o.disposition === "occupation_only") return false;
  return warrantsExtraction(o.verdict) || o.disposition === "alias_opportunity";
}

/**
 * The dominant trade family across a cluster's domains, or `null`.
 *
 * MODE, NOT FIRST: a cluster attested in eleven welding domains and one catering domain is a
 * welding candidate, and taking the first domain id alphabetically would sometimes say
 * otherwise. Ties break alphabetically so the answer is stable across runs.
 */
export function resolveFamily(
  domains: readonly string[],
  familyOf?: (jobDomainId: string) => string | null,
): string | null {
  if (familyOf === undefined || domains.length === 0) return null;
  const counts = new Map<string, number>();
  for (const d of domains) {
    const family = familyOf(d);
    if (family !== null) bump(counts, family);
  }
  if (counts.size === 0) return null;
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

/**
 * WHICH TIER OF THE QUEUE A CANDIDATE BELONGS TO.
 *
 * The measurement this exists to expose, from the full dry run of 2026-08-26 over 8,818
 * distinct phrases:
 *
 *     OCCUPATION_WITH_SKILL_EVIDENCE   6,904   78.3%
 *     OCCUPATION_ONLY                    861    9.8%
 *     REJECTED_NON_SKILL                 543    6.2%
 *     AMBIGUOUS                          476    5.4%
 *     ACTIVITY_PHRASE                     34    0.4%
 *
 * Read plainly: `job_domain_alias` is a catalogue of OCCUPATION TITLES, and only a third of a
 * percent of it names an activity directly. The overwhelming majority of candidates are
 * occupation titles from which a skill might be *derived* — "Dyer, Leather" implying leather
 * dyeing — and whether any given one is worth a canonical skill is a judgement about the
 * ontology, not something a token rule can settle.
 *
 * So the queue is TIERED rather than trimmed, and the tiers say what they are:
 *
 *   `direct`     the phrase names work, or the taxonomy already has an opinion about it
 *                (ACTIVITY_PHRASE, alias_opportunity, covered). Highest yield per minute.
 *   `derived`    an occupation title with a modifier. A skill may be extractable; most will
 *                not be worth one. This is the long tail and it is 78% of the corpus.
 *   `ambiguous`  shape gives no signal. A reviewer's call, and explicitly queued as one.
 *
 * Nothing is dropped by tiering. `census.clusters_by_attestation` plus `--attestation-floor`
 * are how a queue actually gets cut, and whatever a floor excludes is counted and reported.
 */
export type ReviewTier = "direct" | "derived" | "ambiguous";

/**
 * THE TIER RULE ITSELF, over the TWO FACTS it actually reads — and the only copy of it.
 *
 * WHY THIS EXISTS SEPARATELY FROM {@link reviewTier}, which is the obvious question. Because the
 * rule has two callers with two different shapes of the same information, and the alternative to
 * naming the rule once was to restate it:
 *
 *   * the PIPELINE holds a whole `SkillCandidateRecord`, matches and all, and asks
 *     {@link reviewTier};
 *   * the ADMIN REVIEW QUEUE holds a page of stored columns plus one aggregated boolean per row
 *     (`exists (... strength = 'strong')`, computed in SQL because a join would multiply the page
 *     by each candidate's match count), and the metrics tile holds nothing but
 *     `(phrase_class, with_strong_match, without_strong_match)` counts.
 *
 * The second caller CANNOT construct a record — there are no match rows on a queue page, by
 * design — so without this signature it would have had to write `if (phrase_class === ...)` a
 * second time, in SQL and in TypeScript, three call sites deep. That is how two "tiers" start
 * disagreeing: not by anyone changing the rule, but by someone changing it in one of the copies.
 *
 * ⚠ THE BRANCH ORDER IS THE SUBTLE PART AND IT IS LOAD-BEARING. `hasStrongMatch` is tested
 * BEFORE `AMBIGUOUS`, so an AMBIGUOUS candidate WITH a strong match is `direct`, not `ambiguous`
 * — the taxonomy already has an opinion about the phrase, which is exactly the "highest yield per
 * minute" case the `direct` tier is for. A `phrase_class IN (...)` shortcut that dropped the
 * strong-match term would put one candidate under two different tier filters and nothing would
 * say so.
 *
 * `phraseClass` is typed `string`, not the union: `skill_candidate.phrase_class` is `text` with
 * NO CHECK, so an unrecognised value is representable in the database — and it lands in
 * `derived` here, via the same final fallthrough, rather than throwing on a read path.
 */
export function reviewTierFrom(phraseClass: string, hasStrongMatch: boolean): ReviewTier {
  if (phraseClass === "ACTIVITY_PHRASE") return "direct";
  if (hasStrongMatch) return "direct";
  if (phraseClass === "AMBIGUOUS") return "ambiguous";
  return "derived";
}

/**
 * The tier of one whole candidate. Delegates to {@link reviewTierFrom} — a DELEGATION, not a
 * second implementation, so the pipeline and the admin queue cannot answer differently.
 */
export function reviewTier(c: SkillCandidateRecord): ReviewTier {
  return reviewTierFrom(
    c.phrase_class,
    c.matches.some((m) => m.strength === "strong"),
  );
}

/**
 * The review queue's ordering — the Phase-11 prioritization.
 *
 * SORTS, NEVER APPROVES. Every factor here makes a candidate more worth a reviewer's TIME;
 * none of them makes it more likely to be right, and nothing in this pipeline reads this
 * function to decide anything.
 *
 * TIER LEADS, because it is the only factor that separates "this phrase names work" from
 * "this phrase names a job that involves work". Then breadth of DOMAIN attestation, ahead of
 * raw alias count: a concept seen once in each of twelve trades is cross-cutting, while twelve
 * spellings inside one NCO unit group is usually one scrape artefact wearing twelve hats.
 */
export function reviewPriority(c: SkillCandidateRecord): number {
  const tierWeight: Record<ReviewTier, number> = { direct: 2, derived: 1, ambiguous: 0 };
  const bandWeight: Record<SkillCandidateConfidenceBand, number> = { high: 2, medium: 1, low: 0 };
  return (
    tierWeight[reviewTier(c)] * 1_000_000 +
    c.source_domain_count * 1000 +
    c.source_alias_count * 10 +
    bandWeight[c.confidence_band]
  );
}

/** Candidate counts per tier — the report's headline breakdown of the queue. */
export function tierCounts(
  candidates: readonly SkillCandidateRecord[],
): Record<ReviewTier, number> {
  const out: Record<ReviewTier, number> = { direct: 0, derived: 0, ambiguous: 0 };
  for (const c of candidates) out[reviewTier(c)] += 1;
  return out;
}

/** The queue, highest priority first. Ties broken on `cluster_key` for a stable order. */
export function prioritize(candidates: readonly SkillCandidateRecord[]): SkillCandidateRecord[] {
  return [...candidates].sort(
    (a, b) => reviewPriority(b) - reviewPriority(a) || a.cluster_key.localeCompare(b.cluster_key),
  );
}

/** Re-export so a caller building a report has one import for the vocabulary. */
export type { PhraseClass, ClassifierRule };
