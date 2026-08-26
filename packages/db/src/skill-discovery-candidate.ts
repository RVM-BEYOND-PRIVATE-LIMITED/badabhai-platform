/**
 * THE CANDIDATE — the staging record, its lifecycle, and the one door into production.
 *
 * ===========================================================================
 * WHAT A CANDIDATE IS
 * ===========================================================================
 * A candidate is a CLAIM that some cluster of phrases might be a skill, together with
 * everything needed to judge that claim later: which phrases, from which sources, under
 * which domains, what the deterministic layer decided, what the taxonomy already had, which
 * model (if any) proposed the wording, under which prompt, against which corpus, and when.
 *
 * It is NOT a skill, and this module's job is to make that structurally true rather than
 * merely stated. There is exactly one function anywhere that converts a candidate into
 * something a seeder will read — {@link approvedCandidateToCorpusSkill} — and it throws on
 * every status except `approved_create`. A speculative candidate has no path into
 * `skills.jsonl` at all: not a discouraged one, not a guarded one, none.
 *
 * ===========================================================================
 * PURE MIRROR OF THE TABLE, AND WHY THAT IS WORTH A FILE
 * ===========================================================================
 * The types here mirror `schema/skill-discovery.ts` exactly, and the rules here mirror its
 * CHECK constraints exactly. That duplication is deliberate and is the point: the database
 * refuses a bad row, but only once a connection exists, and the discovery pipeline builds
 * thousands of candidates in memory long before it writes one. Validating in a pure layer
 * means a malformed candidate fails in a unit test rather than as a constraint violation
 * halfway through a run, and `skill-discovery-schema-parity.test.ts` asserts the two
 * definitions have not drifted.
 *
 * ===========================================================================
 * PROVENANCE IS FROZEN
 * ===========================================================================
 * {@link PROVENANCE_FIELDS} record HOW THIS CANDIDATE CAME TO EXIST. They are digested at
 * construction and {@link assertProvenanceIntact} refuses any edit that moves one.
 *
 * The failure this prevents is quiet and permanent: a reviewer improves
 * `proposed_skill_name` and, in the same pass, `model` picks up whatever produced the latest
 * batch. The row then claims a lineage it does not have, and "which model, under which
 * prompt, against which corpus, said this?" is answered wrongly, with confidence, forever.
 *
 * A REVIEWER'S EDIT IS A NEW FACT, NOT A CORRECTION OF AN OLD ONE. Decisions land in the
 * review fields, which sit outside the digest — along with `proposed_skill_name` and
 * `proposed_description`, because improving the wording is the most valuable thing review
 * produces and freezing it would force reviewers to reject-and-recreate to fix a word.
 *
 * PURE. Node's `crypto` only. No database, no clock — `created_at` is injected, exactly as
 * `evidence-provenance.ts` injects `measuredAt`, so a run stamps deterministically.
 */
import { createHash } from "node:crypto";

import { MATCH_SKILLS } from "@badabhai/taxonomy";

import { taxonomySkillIdFor } from "./taxonomy-corpus";
import type { TaxonomySkillRecord } from "./taxonomy-corpus";
import type { ClassifierRule, PhraseClass } from "./skill-discovery-classify";
import type { MatchRelation } from "./skill-discovery-match";
import type {
  SkillCandidateAction,
  SkillCandidateConfidenceBand,
  SkillCandidateEmbeddingStatus,
  SkillCandidateSourceType,
  SkillCandidateStatus,
} from "./schema/skill-discovery";

export type {
  SkillCandidateAction,
  SkillCandidateConfidenceBand,
  SkillCandidateEmbeddingStatus,
  SkillCandidateSourceType,
  SkillCandidateStatus,
};

// ===========================================================================
// Closed vocabularies, as values
// ===========================================================================

/** The six source types, as a value. The report breaks down by these. */
export const CANDIDATE_SOURCE_TYPES: readonly SkillCandidateSourceType[] = [
  "job_domain_alias",
  "job_domain_label",
  "unresolved_phrase",
  "worker_phrase",
  "job_text",
  "skill_alias",
];

export const CANDIDATE_STATUSES: readonly SkillCandidateStatus[] = [
  "pending",
  "needs_review",
  "approved_create",
  "approved_map",
  "approved_merge",
  "rejected",
  "deferred",
];

export const CANDIDATE_ACTIONS: readonly SkillCandidateAction[] = [
  "map",
  "create",
  "merge",
  "reject",
  "review",
];

/**
 * Statuses an automated writer may produce.
 *
 * Exported as a VALUE so the guardrail test asserts the set rather than re-deriving it from
 * prose, and so {@link assertDryRunSafe} has one thing to check against.
 */
export const MACHINE_WRITABLE_STATUSES: readonly SkillCandidateStatus[] = ["pending", "needs_review"];

/** Statuses that mean a named human made a decision. */
export const HUMAN_DECIDED_STATUSES: readonly SkillCandidateStatus[] = [
  "approved_create",
  "approved_map",
  "approved_merge",
  "rejected",
  "deferred",
];

/** Statuses that can never be left. See the schema docblock. */
export const TERMINAL_STATUSES: readonly SkillCandidateStatus[] = [
  "approved_create",
  "approved_map",
  "approved_merge",
  "rejected",
];

/** Legal transitions. An absent key, or an absent member, is a refusal. */
const TRANSITIONS: Readonly<Record<SkillCandidateStatus, readonly SkillCandidateStatus[]>> = {
  pending: ["needs_review", "rejected"],
  needs_review: ["approved_create", "approved_map", "approved_merge", "rejected", "deferred"],
  deferred: ["needs_review", "approved_create", "approved_map", "approved_merge", "rejected"],
  approved_create: [],
  approved_map: [],
  approved_merge: [],
  rejected: [],
};

/**
 * Is this transition legal?
 *
 * TERMINAL MEANS TERMINAL. An approved or rejected candidate carries a human decision made
 * against a specific `corpus_fingerprint`; re-opening it in place would silently re-scope
 * that decision to a corpus the human never saw. Re-deciding is a NEW candidate from a NEW
 * run, which the run fingerprint makes visible.
 */
export function canTransition(from: SkillCandidateStatus, to: SkillCandidateStatus): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

/** The status a decision produces. One place, so the API and the tests cannot disagree. */
export function statusForDecision(decision: "map" | "create" | "merge" | "reject" | "defer"): SkillCandidateStatus {
  switch (decision) {
    case "map":
      return "approved_map";
    case "create":
      return "approved_create";
    case "merge":
      return "approved_merge";
    case "reject":
      return "rejected";
    case "defer":
      return "deferred";
  }
}

// ===========================================================================
// The records
// ===========================================================================

/** One phrase that contributed to a candidate. Mirrors `skill_candidate_source`. */
export interface CandidateSource {
  readonly source_type: SkillCandidateSourceType;
  readonly source_id: string;
  readonly original_text: string;
  readonly normalized_text: string;
  readonly job_domain_id: string | null;
}

/** One competing existing-canonical match. Mirrors `skill_candidate_match`. */
export interface CandidateMatch {
  readonly skill_id: string;
  readonly relation: MatchRelation | "vector_cosine";
  readonly score: number;
  readonly strength: "strong" | "weak";
  readonly rank: number;
  readonly evidence_detail: string | null;
}

/** One candidate. Mirrors `skill_candidate`, plus its two child collections. */
export interface SkillCandidateRecord {
  readonly candidate_id: string;
  readonly run_id: string;

  readonly cluster_key: string;
  readonly normalized_phrase: string;

  readonly proposed_skill_name: string | null;
  readonly proposed_description: string | null;
  readonly phrase_class: PhraseClass;
  readonly classifier_rule: ClassifierRule;
  readonly occupation_heads: readonly string[];
  readonly evidence_tokens: readonly string[];
  readonly trade_family: string | null;

  readonly source_alias_count: number;
  readonly source_domain_count: number;

  readonly proposed_action: SkillCandidateAction;
  readonly confidence_band: SkillCandidateConfidenceBand;
  readonly confidence: number | null;
  readonly status: SkillCandidateStatus;
  readonly reviewer_admin_id: string | null;
  readonly reviewed_at: string | null;
  readonly review_reason: string | null;
  readonly resulting_skill_id: string | null;
  /**
   * The trades the REVIEWER said this skill belongs to. Empty until they decide.
   *
   * A REVIEW FIELD, not provenance, and therefore outside {@link PROVENANCE_FIELDS}: it records
   * a human's judgement taken at decision time, exactly like `review_reason`. The pipeline never
   * fills it — it cannot, because a phrase observed under an occupation says nothing about what
   * that trade requires. See the column docblock in `schema/skill-discovery.ts` for the
   * `SKILL_ORPHAN` finding that made this field necessary.
   */
  readonly approved_job_domain_ids: readonly string[];
  /** `required` or `preferred` for those trades. Defaults to the conservative `preferred`. */
  readonly approved_requirement: "required" | "preferred";

  readonly embedding_status: SkillCandidateEmbeddingStatus;
  readonly model: string | null;
  readonly prompt_version: string | null;
  readonly corpus_fingerprint: string;
  readonly provenance_digest: string;
  readonly created_at: string;

  // ── children, carried inline for the pure layer and the export files ─────
  readonly sources: readonly CandidateSource[];
  readonly matches: readonly CandidateMatch[];
}

/**
 * The frozen fields.
 *
 * DELIBERATELY EXCLUDED: `status`, `reviewer_admin_id`, `reviewed_at`, `review_reason`,
 * `resulting_skill_id` (the review outcome), and `proposed_skill_name` /
 * `proposed_description` (the proposal a reviewer is explicitly invited to correct).
 * `sources` and `matches` are excluded too — they are child collections with their own
 * natural keys, and digesting a list would make the digest depend on read order.
 */
export const PROVENANCE_FIELDS = [
  "candidate_id",
  "run_id",
  "cluster_key",
  "normalized_phrase",
  "phrase_class",
  "classifier_rule",
  "occupation_heads",
  "evidence_tokens",
  "trade_family",
  "source_alias_count",
  "source_domain_count",
  "proposed_action",
  "confidence_band",
  "confidence",
  "embedding_status",
  "model",
  "prompt_version",
  "corpus_fingerprint",
  "created_at",
] as const;

export type ProvenanceField = (typeof PROVENANCE_FIELDS)[number];

/**
 * Deterministic candidate id: the same cluster in the same run always mints the same uuid.
 *
 * v5-SHAPED FROM A SHA-1, the exact trick `deterministicAliasId` already uses, so the value
 * fits the `uuid` column without a lookup table and a re-run is idempotent under
 * `ON CONFLICT (candidate_id)`.
 */
export function candidateId(runId: string, clusterKey: string): string {
  const h = createHash("sha1").update(`skill_candidate:${runId}:${clusterKey}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * The frozen digest.
 *
 * `JSON.stringify` over an explicitly ORDERED field list, never over the object — key order
 * in a literal is an implementation detail of whoever wrote the constructor, and a digest
 * that changes when someone reorders two fields is a digest nobody will trust for long.
 */
export function provenanceDigest(
  candidate: Omit<SkillCandidateRecord, "provenance_digest">,
): string {
  const payload = PROVENANCE_FIELDS.map((f) => JSON.stringify(candidate[f] ?? null)).join("");
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

/** Stamp the digest. The only supported constructor. */
export function sealCandidate(
  candidate: Omit<SkillCandidateRecord, "provenance_digest">,
): SkillCandidateRecord {
  return { ...candidate, provenance_digest: provenanceDigest(candidate) };
}

/**
 * Refuse an edit that moved a frozen field. Returns the fields that moved; empty means legal.
 *
 * Used by the admin decision path and asserted directly by the guardrail tests.
 */
export function assertProvenanceIntact(
  before: SkillCandidateRecord,
  after: SkillCandidateRecord,
): ProvenanceField[] {
  return PROVENANCE_FIELDS.filter(
    (f) => JSON.stringify(before[f] ?? null) !== JSON.stringify(after[f] ?? null),
  );
}

// ===========================================================================
// Validation
// ===========================================================================

const MATCH_SKILL_IDS: ReadonlySet<string> = new Set(MATCH_SKILLS.map((s) => s.skillId));

/** Stable problem codes. The manifest counts by these, so renaming one breaks comparison. */
export type CandidateProblemCode =
  | "STATUS_INVALID"
  | "ACTION_INVALID"
  | "SOURCE_TYPE_INVALID"
  | "NO_SOURCES"
  | "SOURCE_ID_EMPTY"
  | "SOURCE_TEXT_EMPTY"
  | "CLUSTER_KEY_EMPTY"
  | "SIMILARITY_RANGE"
  | "CONFIDENCE_RANGE"
  | "MATCH_RANK_INVALID"
  | "MATCH_DUPLICATE_SKILL"
  | "MATCH_IS_MATCH_SKILL"
  | "RESULTING_IS_MATCH_SKILL"
  | "PROPOSED_LABEL_IS_MATCH_SKILL"
  | "WEAK_MATCH_DROVE_ACTION"
  | "MODEL_PAIR"
  | "CORPUS_FINGERPRINT_EMPTY"
  | "CREATE_WITHOUT_LABEL"
  | "RESOLUTION_WITHOUT_SKILL"
  | "DECISION_WITHOUT_REVIEWER"
  | "MACHINE_STATUS_WITH_REVIEWER"
  | "SOURCE_COUNT_MISMATCH"
  | "DOMAIN_COUNT_MISMATCH"
  | "PROVENANCE_DIGEST_MISMATCH"
  | "CANDIDATE_ID_MISMATCH";

export interface CandidateProblem {
  readonly candidate_id: string;
  readonly code: CandidateProblemCode;
  readonly detail: string;
}

/**
 * Validate one candidate. Returns EVERY problem; never throws on the first.
 *
 * Inherited deliberately from `validateTaxonomyCorpus`: generation errors arrive in families
 * (one bad batch produces dozens of the same fault), and fixing them one exception per run is
 * miserable enough that people stop running the validator.
 *
 * THREE RULES CARRY THE SAFETY PROPERTIES AND THE REST IS HYGIENE:
 *
 *   `*_IS_MATCH_SKILL`        the Phase-12 wall. `mskill_*` is a closed, CEO-ratified
 *                             18-member vocabulary the deterministic match engine consumes.
 *                             A discovery candidate that could reference, resolve onto, or
 *                             mint one would make a mined phrase an author of ranking
 *                             vocabulary — CLAUDE.md §3 forbids it outright.
 *   `WEAK_MATCH_DROVE_ACTION` the Phase-4 wall. A `weak` match is a hint, and this repository
 *                             has already measured hints being wrong
 *                             (`ducting_installation -> plumber`). A hint may be SHOWN to a
 *                             reviewer; it may never be the reason `proposed_action` says
 *                             `map` or `merge`.
 *   `DECISION_WITHOUT_REVIEWER` / `MACHINE_STATUS_WITH_REVIEWER`
 *                             the audit wall, in both directions.
 */
export function validateCandidate(c: SkillCandidateRecord): CandidateProblem[] {
  const problems: CandidateProblem[] = [];
  const fail = (code: CandidateProblemCode, detail: string): void => {
    problems.push({ candidate_id: c.candidate_id, code, detail });
  };

  if (!CANDIDATE_STATUSES.includes(c.status)) fail("STATUS_INVALID", `status ${JSON.stringify(c.status)}`);
  if (!CANDIDATE_ACTIONS.includes(c.proposed_action)) {
    fail("ACTION_INVALID", `proposed_action ${JSON.stringify(c.proposed_action)}`);
  }
  if (c.cluster_key.trim() === "") fail("CLUSTER_KEY_EMPTY", "a candidate with no cluster key has no identity");

  // ── sources ──────────────────────────────────────────────────────────────
  if (c.sources.length === 0) {
    fail("NO_SOURCES", "a candidate with no source rows cannot answer 'which aliases caused this?'");
  }
  for (const s of c.sources) {
    if (!CANDIDATE_SOURCE_TYPES.includes(s.source_type)) {
      fail("SOURCE_TYPE_INVALID", `source_type ${JSON.stringify(s.source_type)}`);
    }
    if (s.source_id.trim() === "") fail("SOURCE_ID_EMPTY", "a source with no id cannot be traced back");
    if (s.original_text.trim() === "" || s.normalized_text.trim() === "") {
      fail("SOURCE_TEXT_EMPTY", `source ${s.source_type}:${s.source_id} carries no text`);
    }
  }
  if (c.source_alias_count !== c.sources.length) {
    fail(
      "SOURCE_COUNT_MISMATCH",
      `source_alias_count ${c.source_alias_count} != ${c.sources.length} source rows — the queue sorts on this number`,
    );
  }
  const domains = new Set(c.sources.map((s) => s.job_domain_id).filter((d): d is string => d !== null));
  if (c.source_domain_count !== domains.size) {
    fail("DOMAIN_COUNT_MISMATCH", `source_domain_count ${c.source_domain_count} != ${domains.size} distinct domains`);
  }

  // ── matches ──────────────────────────────────────────────────────────────
  const seenSkills = new Set<string>();
  for (const m of c.matches) {
    if (m.score < 0 || m.score > 1) fail("SIMILARITY_RANGE", `score ${m.score} for ${m.skill_id} is outside 0..1`);
    if (!Number.isInteger(m.rank) || m.rank < 1) fail("MATCH_RANK_INVALID", `rank ${m.rank} for ${m.skill_id}`);
    if (seenSkills.has(m.skill_id)) fail("MATCH_DUPLICATE_SKILL", `${m.skill_id} appears twice`);
    seenSkills.add(m.skill_id);
    if (MATCH_SKILL_IDS.has(m.skill_id)) {
      fail(
        "MATCH_IS_MATCH_SKILL",
        `${m.skill_id} is in the closed mskill_* vocabulary. Showing it as an option would tell a ` +
          "reviewer they may map a discovered phrase onto the match engine's ranking vocabulary",
      );
    }
  }

  // ── the weak-evidence wall ───────────────────────────────────────────────
  if (c.proposed_action === "map" || c.proposed_action === "merge") {
    const strong = c.matches.some((m) => m.strength === "strong");
    if (!strong) {
      fail(
        "WEAK_MATCH_DROVE_ACTION",
        `proposed_action '${c.proposed_action}' with no STRONG match. Similarity is evidence, not ` +
          "authorization — a weak match may be shown to a reviewer but may never suggest a resolution",
      );
    }
  }

  // ── ranges and pairs ─────────────────────────────────────────────────────
  if (c.confidence !== null && (c.confidence < 0 || c.confidence > 1)) {
    fail("CONFIDENCE_RANGE", `confidence ${c.confidence} is outside 0..1`);
  }
  if ((c.model === null) !== (c.prompt_version === null)) {
    fail(
      "MODEL_PAIR",
      "model and prompt_version are both-or-neither: a model without a prompt version is " +
        "unreproducible, a prompt version without a model attributes the output to nothing",
    );
  }
  if (c.corpus_fingerprint.trim() === "") {
    fail("CORPUS_FINGERPRINT_EMPTY", "a candidate that cannot say which corpus it measured against is stale by default");
  }

  // ── the match-skill wall on the two resolution paths ─────────────────────
  if (c.resulting_skill_id !== null && MATCH_SKILL_IDS.has(c.resulting_skill_id)) {
    fail("RESULTING_IS_MATCH_SKILL", `${c.resulting_skill_id} is in the closed mskill_* vocabulary`);
  }
  if (c.proposed_skill_name !== null) {
    const minted = taxonomySkillIdFor(c.proposed_skill_name);
    if (minted.startsWith("skill_mskill_") || MATCH_SKILL_IDS.has(minted)) {
      fail(
        "PROPOSED_LABEL_IS_MATCH_SKILL",
        `${JSON.stringify(c.proposed_skill_name)} mints ${minted}, colliding with the matchable vocabulary`,
      );
    }
  }

  // ── decision integrity ───────────────────────────────────────────────────
  if (c.status === "approved_create" && (c.proposed_skill_name ?? "").trim() === "") {
    fail("CREATE_WITHOUT_LABEL", "approved as a new skill with no label to mint an id from");
  }
  if ((c.status === "approved_map" || c.status === "approved_merge") && c.resulting_skill_id === null) {
    fail("RESOLUTION_WITHOUT_SKILL", `${c.status} onto nothing is not a decision`);
  }
  if (HUMAN_DECIDED_STATUSES.includes(c.status)) {
    if ((c.reviewer_admin_id ?? "").trim() === "" || c.reviewed_at === null || (c.review_reason ?? "").trim() === "") {
      fail(
        "DECISION_WITHOUT_REVIEWER",
        `status ${c.status} is a human decision and must name the human, the moment and the reason`,
      );
    }
  }
  if (MACHINE_WRITABLE_STATUSES.includes(c.status) && c.reviewer_admin_id !== null) {
    fail("MACHINE_STATUS_WITH_REVIEWER", `status ${c.status} carries a reviewer, claiming a decision nobody made`);
  }

  // ── identity ─────────────────────────────────────────────────────────────
  if (provenanceDigest(c) !== c.provenance_digest) {
    fail("PROVENANCE_DIGEST_MISMATCH", "a provenance field moved after the candidate was sealed");
  }
  if (candidateId(c.run_id, c.cluster_key) !== c.candidate_id) {
    fail("CANDIDATE_ID_MISMATCH", "candidate_id is not the deterministic id of its own (run, cluster)");
  }

  return problems;
}

// ===========================================================================
// The dry-run guard
// ===========================================================================

/**
 * The Phase-14 hard guard: A DRY RUN CANNOT PRODUCE AN APPROVED CANDIDATE.
 *
 * WHY A FUNCTION AND NOT A CODE REVIEW. Every other protection in this file is a rule about
 * a row. This is a rule about a RUN: the pipeline builds candidates from measurements, and
 * there is no code path in it that sets a human status — but "there is no such code path" is
 * exactly the kind of claim that stops being true six months later, silently, in a diff that
 * looked like a refactor. So the batch writer calls this on everything it is about to emit,
 * and it throws rather than filters: a run that somehow produced an approval has a bug whose
 * blast radius is the production taxonomy, and continuing with the good rows would hide it.
 */
export function assertDryRunSafe(candidates: readonly SkillCandidateRecord[]): void {
  const offenders = candidates.filter((c) => !MACHINE_WRITABLE_STATUSES.includes(c.status));
  if (offenders.length === 0) return;
  throw new Error(
    `assertDryRunSafe: ${offenders.length} candidate(s) carry a human-decided status in a pipeline run ` +
      `(${offenders.slice(0, 5).map((c) => `${c.cluster_key}=${c.status}`).join(", ")}). ` +
      "A discovery run may only ever write 'pending' or 'needs_review'. Refusing the whole run.",
  );
}

// ===========================================================================
// The ONE door into the production corpus
// ===========================================================================

/**
 * Turn an APPROVED candidate into the corpus record `seed-domain-skills.ts` understands.
 *
 * THROWS on anything that is not `approved_create`, and that is the enforcement the whole
 * file builds toward: this is the only converter that exists, so there is no path from a
 * speculative candidate into `data/taxonomy/skills.jsonl`.
 *
 * It does not shorten the existing path, it only makes the first step typed. The output
 * still faces `validateTaxonomyCorpus` (structural) and `taxonomyQualityVerdict` (semantic),
 * and still needs a human commit before `db:seed:domain-skills` will look at it. The skill
 * then seeds as `provisional` and reaches `active` only through `db:promote:skills`'s
 * C1..C5 gates.
 *
 * `kind` is not settable and there is no parameter for it: a discovered skill is an
 * ATTRIBUTE. `TaxonomySkillRecord` has no `kind` field precisely because the seeder writes
 * `attribute` unconditionally, and `SKILL_CORPUS` does not grow.
 */
export function approvedCandidateToCorpusSkill(c: SkillCandidateRecord): TaxonomySkillRecord {
  if (c.status !== "approved_create") {
    throw new Error(
      `approvedCandidateToCorpusSkill: candidate ${c.candidate_id} has status '${c.status}'. ` +
        "Only an explicitly human-approved new canonical skill may enter the corpus.",
    );
  }
  const label = (c.proposed_skill_name ?? "").trim();
  if (label === "") {
    throw new Error(`approvedCandidateToCorpusSkill: candidate ${c.candidate_id} has no proposed label`);
  }

  // Aliases are the cluster's OTHER surface forms — the phrases that made this one concept.
  // Deduped on normalized text and never including the canonical label itself, which is what
  // `ALIAS_DUPLICATE_WITHIN_SKILL` would otherwise reject downstream.
  const seen = new Set<string>([label.toLowerCase()]);
  const aliases: { text: string; lang: "en" | "hi" }[] = [];
  for (const source of c.sources) {
    const text = source.original_text.trim();
    const key = text.toLowerCase();
    if (text === "" || seen.has(key)) continue;
    seen.add(key);
    aliases.push({ text, lang: "en" });
  }

  return {
    kind: "skill",
    skill_id: taxonomySkillIdFor(label),
    label_en: label,
    label_hi: null,
    aliases,
  };
}
