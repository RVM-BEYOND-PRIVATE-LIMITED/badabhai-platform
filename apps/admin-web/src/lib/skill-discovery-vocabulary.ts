/**
 * The skill-discovery review vocabulary — pure, no `"server-only"`.
 *
 * ── WHY THIS IS A SEPARATE FILE FROM `lib/skill-discovery.ts` ───────────────────────────
 * `lib/skill-discovery.ts` carries `import "server-only"` (it calls `adminFetch`), and that
 * poisons the WHOLE module for a client bundle — even a type-only import from it fails the
 * build. The decision screen's buttons, labels and the client-side form guard all need this
 * vocabulary from `"use client"` code, so it lives here instead — the same split
 * `lib/ai-trace-view.ts` (pure) draws against `lib/ai-traces.ts` (server-only fetch).
 *
 * ── MIRRORED, NOT IMPORTED ───────────────────────────────────────────────────────────────
 * Every constant below is copied by hand from `apps/api/src/admin/admin-skill-discovery.dto.ts`
 * (a sibling app; this portal takes no workspace dependency on it — CLAUDE.md invariant #9).
 * `lib/skill-discovery.test.ts` and `skill-discovery-vocabulary.test.ts` are what keep the copy
 * honest; a value the API can produce that this file has never heard of is a real drift risk,
 * which is why unknown values are rendered raw rather than dropped wherever that matters.
 */

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Status ladder
// ═══════════════════════════════════════════════════════════════════════════════════════════

export const SKILL_CANDIDATE_STATUSES = [
  "pending",
  "needs_review",
  "approved_create",
  "approved_map",
  "approved_merge",
  "rejected",
  "deferred",
] as const;
export type SkillCandidateStatus = (typeof SKILL_CANDIDATE_STATUSES)[number];

/**
 * Terminal statuses never leave — `canTransition` gives them no outbound edge. A candidate in
 * one of these renders as a RECORD with no decision controls, whatever capability the viewer
 * holds.
 */
export const SKILL_CANDIDATE_TERMINAL_STATUSES = [
  "approved_create",
  "approved_map",
  "approved_merge",
  "rejected",
] as const;

export function isTerminalSkillStatus(status: SkillCandidateStatus): boolean {
  return (SKILL_CANDIDATE_TERMINAL_STATUSES as readonly string[]).includes(status);
}

export const SKILL_CANDIDATE_STATUS_LABELS: Readonly<Record<SkillCandidateStatus, string>> = {
  pending: "Pending",
  needs_review: "Needs review",
  approved_create: "Approved — new skill",
  approved_map: "Approved — added as alias",
  approved_merge: "Approved — merged into skill",
  rejected: "Rejected",
  deferred: "On hold",
};

/** Explicit tone per status — never borrowed from `StatusPill`'s value-keyed map (which knows
 * none of these words) and never inferred, for the reason `creditReasonLabel`'s caller states:
 * borrowing a tone by value renders a different domain's word next to the wrong colour. */
export const SKILL_CANDIDATE_STATUS_TONE: Readonly<
  Record<SkillCandidateStatus, "ok" | "warn" | "bad" | "muted">
> = {
  pending: "warn",
  needs_review: "warn",
  approved_create: "ok",
  approved_map: "ok",
  approved_merge: "ok",
  rejected: "bad",
  deferred: "muted",
};

// ═══════════════════════════════════════════════════════════════════════════════════════════
// The machine's suggestion — a different axis from status
// ═══════════════════════════════════════════════════════════════════════════════════════════

export const SKILL_CANDIDATE_ACTIONS = ["map", "create", "merge", "reject", "review"] as const;
export type SkillCandidateAction = (typeof SKILL_CANDIDATE_ACTIONS)[number];

export const SKILL_CANDIDATE_ACTION_LABELS: Readonly<Record<SkillCandidateAction, string>> = {
  map: "Suggests: add as alias",
  create: "Suggests: create new skill",
  merge: "Suggests: merge into skill",
  reject: "Suggests: reject",
  review: "No suggestion — needs a human read",
};

export const SKILL_CANDIDATE_CONFIDENCE_BANDS = ["high", "medium", "low"] as const;
export type SkillCandidateConfidenceBand = (typeof SKILL_CANDIDATE_CONFIDENCE_BANDS)[number];

export const SKILL_CANDIDATE_SOURCE_TYPES = [
  "job_domain_alias",
  "job_domain_label",
  "unresolved_phrase",
  "worker_phrase",
  "job_text",
  "skill_alias",
] as const;
export type SkillCandidateSourceType = (typeof SKILL_CANDIDATE_SOURCE_TYPES)[number];

export const SKILL_CANDIDATE_SOURCE_TYPE_LABELS: Readonly<
  Record<SkillCandidateSourceType, string>
> = {
  job_domain_alias: "Occupation alias",
  job_domain_label: "Occupation title",
  unresolved_phrase: "Unresolved phrase",
  worker_phrase: "Worker's own words",
  job_text: "Job posting text",
  skill_alias: "Existing skill alias",
};

// ═══════════════════════════════════════════════════════════════════════════════════════════
// The reviewer's grouping — DERIVED, not a column (`review_tier`)
// ═══════════════════════════════════════════════════════════════════════════════════════════

export const ADMIN_SKILL_REVIEW_TIERS = ["direct", "derived", "ambiguous"] as const;
export type AdminSkillReviewTier = (typeof ADMIN_SKILL_REVIEW_TIERS)[number];

export const ADMIN_SKILL_REVIEW_TIER_LABELS: Readonly<Record<AdminSkillReviewTier, string>> = {
  direct: "Direct",
  derived: "Derived",
  ambiguous: "Ambiguous",
};

/**
 * WHY `derived` IS SEQUENCED BEHIND `direct` — the product rule this screen must keep visible,
 * never enforce as a hard block. Nothing on the API gates a read of `derived` candidates (both
 * sit on the same `read_entities` floor), and inventing a client-side block on top of that would
 * be exactly the "re-implement a permission rule client-side" failure mode — this is a WORKFLOW
 * nudge, not an authorization boundary, so the tab stays reachable behind one extra click.
 */
export const DERIVED_TIER_SEQUENCING_REASON =
  "Direct candidates are the highest yield per reviewer-minute and are worked through first. " +
  "Derived is the long tail — an occupation title with a modifier that may or may not name a " +
  "skill — and is sequenced behind it so the queue is not worked out of order.";

export const ADMIN_SKILL_PHRASE_CLASSES = [
  "REJECTED_NON_SKILL",
  "OCCUPATION_ONLY",
  "OCCUPATION_WITH_SKILL_EVIDENCE",
  "ACTIVITY_PHRASE",
  "AMBIGUOUS",
] as const;
export type AdminSkillPhraseClass = (typeof ADMIN_SKILL_PHRASE_CLASSES)[number];

export const SKILL_PHRASE_CLASS_LABELS: Readonly<Record<AdminSkillPhraseClass, string>> = {
  REJECTED_NON_SKILL: "Not vocabulary at all — leftover prose, or nothing usable once tidied.",
  OCCUPATION_ONLY: "A job title and nothing more. It names a role, not work.",
  OCCUPATION_WITH_SKILL_EVIDENCE: "A job title with a modifier that names actual work.",
  ACTIVITY_PHRASE: "Names an activity rather than a person. Skill-shaped.",
  AMBIGUOUS: "Its shape gives no honest signal either way.",
};

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Match evidence — NEVER a score. See `AdminSkillRelatedSkill`'s own header on the API side:
// there is no `score` key on the wire, by construction, and this file must never add one.
// ═══════════════════════════════════════════════════════════════════════════════════════════

export const ADMIN_SKILL_MATCH_RELATIONS = [
  "exact_surface",
  "skeleton_surface",
  "normalized_label_equal",
  "surface_form_shared",
  "informative_tokens_equal",
  "strict_token_subset",
  "high_token_overlap",
  "vector_cosine",
] as const;
export type AdminSkillMatchRelation = (typeof ADMIN_SKILL_MATCH_RELATIONS)[number];

export const SKILL_MATCH_RELATION_LABELS: Readonly<Record<AdminSkillMatchRelation, string>> = {
  exact_surface: "The same phrase, letter for letter, as one this skill already answers to.",
  skeleton_surface: "The same phrase apart from spelling.",
  normalized_label_equal: "The same name once punctuation and spacing are tidied up.",
  surface_form_shared: "This phrase is already listed as another name for this skill.",
  informative_tokens_equal: "The same meaningful words, in a different order.",
  strict_token_subset: "Shares all of its meaningful words with this skill, which has more.",
  high_token_overlap: "Shares most of its meaningful words with this skill.",
  vector_cosine: "Reads as close in meaning, with no shared wording to point at.",
};

export const ADMIN_SKILL_MATCH_STRENGTHS = ["strong", "weak"] as const;
export type AdminSkillMatchStrength = (typeof ADMIN_SKILL_MATCH_STRENGTHS)[number];

export const SKILL_MATCH_STRENGTH_LABELS: Readonly<Record<AdminSkillMatchStrength, string>> = {
  strong: "Looks like the same thing.",
  weak: "Possibly related — worth a look, not a match.",
};

/**
 * A relation or a phrase-class code this build has never heard of. Both columns are `text` with
 * no DB CHECK on the API side, so an unrecognised value is a real possibility, not a bug — and
 * the API's own contract renders its own raw code in that case rather than a guessed sentence.
 * This is that same fallback, mirrored.
 */
export function relationLabel(relation: string): string {
  return (
    SKILL_MATCH_RELATION_LABELS[relation as AdminSkillMatchRelation] ??
    `Unrecognised relation: ${relation}`
  );
}

export function phraseClassLabel(phraseClass: string): string {
  return (
    SKILL_PHRASE_CLASS_LABELS[phraseClass as AdminSkillPhraseClass] ??
    `Unrecognised classification: ${phraseClass}`
  );
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// The reviewer's five buttons
// ═══════════════════════════════════════════════════════════════════════════════════════════

export const ADMIN_SKILL_REVIEW_DECISIONS = ["create", "alias", "merge", "reject", "hold"] as const;
export type AdminSkillReviewDecision = (typeof ADMIN_SKILL_REVIEW_DECISIONS)[number];

export const ADMIN_SKILL_REVIEW_DECISION_LABELS: Readonly<
  Record<AdminSkillReviewDecision, string>
> = {
  create: "Create new skill",
  alias: "Add as alias",
  merge: "Merge into skill",
  reject: "Reject",
  hold: "Hold",
};

/** Minimum length of a review reason — mirrors `ADMIN_SKILL_REVIEW_REASON_MIN`. NOT decoration:
 * the API's own validator does not consider a shorter, or blank, reason a decision at all. */
export const ADMIN_SKILL_REVIEW_REASON_MIN = 12;
export const ADMIN_SKILL_REVIEW_REASON_MAX = 500;
export const ADMIN_SKILL_PROPOSED_LABEL_MAX = 120;
export const ADMIN_SKILL_PROPOSED_DESCRIPTION_MAX = 500;

/** Ceiling on how many trades one `create` approval may name. Mirrors `ADMIN_SKILL_APPROVED_DOMAINS_MAX`. */
export const ADMIN_SKILL_APPROVED_DOMAINS_MAX = 20;

export const ADMIN_SKILL_REQUIREMENTS = ["required", "preferred"] as const;
export type AdminSkillRequirement = (typeof ADMIN_SKILL_REQUIREMENTS)[number];

/**
 * The request body, discriminated by `decision` — the client-side mirror of
 * `AdminSkillDecisionSchema`'s union. Building the form against THIS type, rather than one flat
 * object with optional fields, is what makes "send `resulting_skill_id` on a `create`" a
 * TypeScript error in the form code, not just a 400 the server happens to catch.
 */
export type SkillDecisionRequest =
  | {
      decision: "create";
      expected_status: SkillCandidateStatus;
      review_reason: string;
      proposed_skill_name: string;
      proposed_description?: string;
      approved_job_domain_ids: string[];
      approved_requirement: AdminSkillRequirement;
    }
  | {
      decision: "alias";
      expected_status: SkillCandidateStatus;
      review_reason: string;
      resulting_skill_id: string;
    }
  | {
      decision: "merge";
      expected_status: SkillCandidateStatus;
      review_reason: string;
      resulting_skill_id: string;
    }
  | { decision: "reject"; expected_status: SkillCandidateStatus; review_reason: string }
  | { decision: "hold"; expected_status: SkillCandidateStatus; review_reason: string };

/**
 * Client-side UX guard ONLY — the server's `.strict()` discriminated union is the actual
 * authority and re-validates every one of these independently. This exists so a reviewer sees
 * "why is Submit disabled" in plain words instead of decoding a 400 (issue requirement #7/#8),
 * never to replace the server check.
 */
export function skillDecisionClientErrors(request: SkillDecisionRequest): string[] {
  const errors: string[] = [];
  const reason = request.review_reason.trim();
  if (reason.length < ADMIN_SKILL_REVIEW_REASON_MIN) {
    errors.push(`The reason needs at least ${ADMIN_SKILL_REVIEW_REASON_MIN} characters.`);
  }
  if (request.decision === "create") {
    if (request.proposed_skill_name.trim().length < 2) {
      errors.push("Name the new skill.");
    }
    if (request.approved_job_domain_ids.length < 1) {
      errors.push(
        "Tick at least one trade. A skill with no trade never reaches a worker's picker and " +
          "no posting can be built from it.",
      );
    }
  }
  if (
    (request.decision === "alias" || request.decision === "merge") &&
    request.resulting_skill_id.trim().length === 0
  ) {
    errors.push("Choose the existing skill this candidate resolves onto.");
  }
  return errors;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Decision result — literal types, mirrored so a client cannot claim more than was recorded
// ═══════════════════════════════════════════════════════════════════════════════════════════

export const SKILL_DECISION_EFFECT_RECORDED_ONLY = "decision_recorded_no_corpus_write" as const;
export const SKILL_DECISION_NEXT_STEP_OFFLINE_CORPUS_CHAIN =
  "awaiting_offline_corpus_chain" as const;

export const ADMIN_SKILL_DECISION_CONFLICTS = [
  "stale_expected_status",
  "already_decided",
  "illegal_transition",
] as const;
export type AdminSkillDecisionConflict = (typeof ADMIN_SKILL_DECISION_CONFLICTS)[number];

/** One plain sentence per conflict code — never a raw code shown to a reviewer. */
export const SKILL_DECISION_CONFLICT_LABELS: Readonly<Record<AdminSkillDecisionConflict, string>> =
  {
    stale_expected_status:
      "Somebody moved this candidate since you loaded it. Reload and look again — the other " +
      "decision might be the right one.",
    already_decided:
      "This candidate is terminal — a decision was already recorded on it, against the corpus " +
      "as it stood then. Re-deciding here is not possible; a re-scoped decision needs a new " +
      "candidate from a new run.",
    illegal_transition:
      "That move is not allowed from the candidate's current status. Reload to see it as it " +
      "stands now.",
  };

/** The full 409 body this surface can receive, narrowed from an unknown error payload. */
export interface SkillDecisionConflictInfo {
  conflict: AdminSkillDecisionConflict;
  current_status: SkillCandidateStatus;
  expected_status: SkillCandidateStatus;
}

function isSkillCandidateStatus(value: unknown): value is SkillCandidateStatus {
  return (
    typeof value === "string" && (SKILL_CANDIDATE_STATUSES as readonly string[]).includes(value)
  );
}

function isSkillDecisionConflict(value: unknown): value is AdminSkillDecisionConflict {
  return (
    typeof value === "string" &&
    (ADMIN_SKILL_DECISION_CONFLICTS as readonly string[]).includes(value)
  );
}

/**
 * Narrow the raw `error` object off a 409 (`AdminRequestError.body`) into a typed conflict, or
 * `null` when the shape does not match — which a caller must render as a GENERIC failure rather
 * than guess at a conflict that was never confirmed. Pure and hand-testable without a DOM, the
 * same discipline `applyCreditGrantOutcome` uses for the credit-grant key rotation.
 */
export function parseSkillDecisionConflict(body: unknown): SkillDecisionConflictInfo | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  if (
    isSkillDecisionConflict(record.conflict) &&
    isSkillCandidateStatus(record.current_status) &&
    isSkillCandidateStatus(record.expected_status)
  ) {
    return {
      conflict: record.conflict,
      current_status: record.current_status,
      expected_status: record.expected_status,
    };
  }
  return null;
}

/**
 * The outcome of ONE decision submission, as this screen may honestly render it. Constructed by
 * the Server Action (`skills/discovery/[id]/actions.ts`), consumed by the client panel.
 */
export type SkillDecisionOutcome =
  | { kind: "success"; changed: boolean; status: SkillCandidateStatus; already_decided: boolean }
  | { kind: "conflict"; info: SkillDecisionConflictInfo }
  | { kind: "error"; message: string };

// ═══════════════════════════════════════════════════════════════════════════════════════════
// The audit trail — action codes, in the reviewer's words
// ═══════════════════════════════════════════════════════════════════════════════════════════

/**
 * The five governed action codes `GET /admin/skill-discovery/:id/audit` can carry.
 *
 * ⚠ THEY ARE NAMED FOR THE STATUS RECORDED, NOT THE BUTTON PRESSED — `alias` on the wire becomes
 * `skill_candidate_approved_map` in the spine. That is deliberate on the API's side: the code is
 * then a total function of the status, so an auditor reconciling the event spine against a
 * candidate row needs no translation table. This console must not undo that by relabelling them
 * back into button words, so each label below says what was RECORDED.
 */
export const ADMIN_SKILL_AUDIT_ACTION_CODES = [
  "skill_candidate_approved_create",
  "skill_candidate_approved_map",
  "skill_candidate_approved_merge",
  "skill_candidate_rejected",
  "skill_candidate_deferred",
] as const;
export type AdminSkillAuditActionCode = (typeof ADMIN_SKILL_AUDIT_ACTION_CODES)[number];

export const ADMIN_SKILL_AUDIT_ACTION_LABELS: Readonly<Record<AdminSkillAuditActionCode, string>> =
  {
    skill_candidate_approved_create: "Approved as a new skill",
    skill_candidate_approved_map: "Approved as another name for an existing skill",
    skill_candidate_approved_merge: "Approved as the same competency as an existing skill",
    skill_candidate_rejected: "Rejected — not a skill",
    skill_candidate_deferred: "Held — not enough evidence to decide",
  };

/**
 * An unrecognised action code renders ITSELF, never a guessed sentence.
 *
 * An invented description of an audit entry is worse than an unfamiliar code: the entry is the
 * immutable record an auditor cites, and a label this build made up would be indistinguishable
 * from one the platform vouches for.
 */
export function auditActionLabel(code: string): string {
  return ADMIN_SKILL_AUDIT_ACTION_LABELS[code as AdminSkillAuditActionCode] ?? code;
}

/**
 * What the audit response is, and — the part that matters — what it is not.
 *
 * The spine half is immutable and value-free by construction: an entry says WHO did WHAT and
 * WHEN, and carries no reason, no label and no target. The reviewer's prose lives on the row and
 * is served once, so the two can never disagree.
 */
export const SKILL_AUDIT_SPINE_NOTE =
  "The entries below come from the platform's event spine, written on the same transaction as the decision itself — so an entry cannot have been edited afterwards. They record who acted and when, and carry no values: the reviewer's own words live on the record beside them, stored once rather than copied into both.";

/** How `required` / `preferred` read on a decision record. */
export const ADMIN_SKILL_REQUIREMENT_LABELS: Readonly<Record<AdminSkillRequirement, string>> = {
  required: "Required for those trades",
  preferred: "Preferred for those trades",
};

export function requirementLabel(requirement: string): string {
  return ADMIN_SKILL_REQUIREMENT_LABELS[requirement as AdminSkillRequirement] ?? requirement;
}

/**
 * Why the trades a `create` decision named are worth showing back.
 *
 * The corpus gate refuses a skill that reaches no trade, and the pipeline may not infer which
 * trades a skill belongs to — so a human names them, and that judgement is the half of an
 * approval nothing else can reconstruct. A record that omitted it would be only half auditable.
 */
export const SKILL_APPROVED_DOMAINS_NOTE =
  "The trades this reviewer named. A new skill that reaches no trade is on nobody's picker and no posting can be built from it, so the corpus gate refuses one — and the pipeline may not guess them, which is why a human names them here.";

/** The search route refuses a shorter term with a 400; the picker answers it locally. */
export const ADMIN_SKILLS_QUERY_MIN = 2;

/**
 * ONE CANONICAL SKILL as the MAP/MERGE picker renders it, and the result envelope around it.
 *
 * These live HERE rather than beside the Server Action for a build-time reason with teeth: a
 * `"use server"` module may export ONLY async functions, so a type exported from one is a build
 * error waiting to be discovered. They cannot live in `lib/skill-discovery.ts` either — that
 * module is `import "server-only"` and the picker is a client component. This module is the one
 * place both sides may import from.
 *
 * `mappable` IS THE FIELD THAT MATTERS. The route returns skills that match and says which may
 * actually be mapped onto, rather than filtering the rest out silently — a reviewer searching for
 * a skill they remember and getting nothing back cannot tell "no such skill" from "deprecated"
 * from "that is match vocabulary", and those need three different actions.
 */
export interface AdminCanonicalSkillView {
  skill_id: string;
  label_en: string;
  status: string;
  kind: string;
  mappable: boolean;
  not_mappable_reason: string | null;
}

export interface SkillSearchOutcome {
  skills: AdminCanonicalSkillView[];
  /** Echoed from the response, so a stale reply is not read as the answer to a newer keystroke. */
  q: string;
  truncated: boolean;
  /** Present only on a failed lookup. The decision form around it stays usable. */
  error?: string;
}

/**
 * THE CEILING ON THE AUDIT READ, AND WHY THE CONSOLE HAS TO KNOW ABOUT IT.
 *
 * `listAuditEvents` selects `LIMIT 200` and the response carries NO truncation flag — unlike
 * `/groups`, which counts first and refuses an over-broad filter with a 400 rather than returning
 * a partial answer that presents itself as a whole one. Here a candidate with 201 events and a
 * candidate with exactly 200 produce identical-looking responses.
 *
 * Unreachable in practice: the status ladder is terminal, so a candidate accrues two or three
 * events and no realistic path adds a two-hundredth. That is a reason to say so quietly, not a
 * reason to leave it unsaid — the failure mode is an auditor reading a truncated trail as a
 * complete one, which is the single thing an audit surface must never let happen.
 *
 * So the console asserts nothing it cannot see: at fewer than 200 entries the trail is complete
 * and the panel says nothing; AT the cap it says the cap was reached and that the response cannot
 * distinguish "exactly 200" from "cut at 200". And there is no "load the rest" affordance
 * anywhere, because there is no route behind one.
 */
export const SKILL_AUDIT_MAX_ENTRIES = 200;

export const SKILL_AUDIT_CAP_NOTE = `This trail is showing ${SKILL_AUDIT_MAX_ENTRIES} entries, which is the most the audit read returns. The response carries no marker for whether anything was left out, so this list cannot be treated as the complete history — read the event spine directly if the full sequence matters.`;

/**
 * HOW THE SERVER ORDERS THE BATCHES — stated on the screen, because it is not the obvious one.
 *
 * The order is `candidates` DESCENDING, tie-broken by group key in code-unit order. It is NOT
 * `undecided`, and the difference is visible to a reviewer: a batch of 35 that is entirely decided
 * outranks a batch of 10 that nobody has opened.
 *
 * ── THE CONSOLE DOES NOT RE-SORT ───────────────────────────────────────────────────────
 * Re-ordering here would put a second ordering rule in the browser, disagreeing with the one the
 * server publishes, over a list whose whole promise is that it is exhaustive and reproducible for
 * the applied filters. Two orders for one set is the same class of defect as two groupings for one
 * set, which this screen already deleted once.
 *
 * Whether the SERVER should order by `undecided` instead is a live product question (#1280,
 * correction 2) and an owner's call, not a thing to paper over in a render. Until it is answered,
 * the console does the two honest things: it says what the order actually is, and it marks the
 * batches with nothing left to decide so they can be skipped by eye.
 */
export const SKILL_GROUP_ORDER_NOTE =
  "Ordered by batch size, largest first — not by how much is left to review. A large batch that has already been decided will sit above a small one nobody has opened; the ones with nothing left to decide are marked so.";

/**
 * The grouping and tier markers the two read routes carry in band (`grouping_basis`, `tier_basis`).
 *
 * They are rendered rather than merely parsed. Each is the server stating that the thing above it
 * was DERIVED at read time and is stored nowhere — which is exactly the claim a reviewer would
 * otherwise have to take on trust from a UI that looks like it is listing records.
 */
export const SKILL_BASIS_MARKER_LABELS: Readonly<Record<string, string>> = {
  groups_are_derived_not_stored:
    "A batch is worked out fresh on every read. There is no group row in any table, no group id, and no decision is ever recorded against a batch.",
  review_tier_is_derived_not_stored:
    "A tier is worked out from the candidate's phrase class and whether it has a strong match. It is not a stored column and nothing decides on it.",
  /*
   * The audit read carries the same literal the decision write does, and it belongs on the trail
   * for a reason the decision panel's own copy cannot cover: somebody reading an approval WEEKS
   * later needs to know the taxonomy did not move when it was recorded. Without it, an entry
   * reading "Approved as a new skill" looks like the skill exists.
   */
  [SKILL_DECISION_EFFECT_RECORDED_ONLY]:
    "Recording a decision here does not change the taxonomy. Every entry above is a decision being written down; the skill corpus is only ever changed by the offline chain that runs afterwards.",
};

/**
 * An unrecognised marker renders ITSELF rather than a guessed sentence — same rule as
 * {@link auditActionLabel}, for the same reason: these markers exist so the surface cannot
 * paraphrase what the server said about its own answer.
 */
export function basisMarkerLabel(marker: string): string {
  return SKILL_BASIS_MARKER_LABELS[marker] ?? marker;
}

/**
 * WHY A MODEL NAME IS ON THIS SCREEN WHEN A SCORE NEVER IS.
 *
 * The rule this console enforces is *no similarity measurement* — no cosine figure, no vector, no
 * number a reviewer could turn into an approval floor. It is not "no machine word anywhere", and
 * conflating the two costs real auditability: `model` and `prompt_version` are facts about the RUN
 * that produced the phrase, both inside the frozen provenance digest, and hiding two of the
 * digest's fields leaves a reviewer looking at a partial record labelled as the complete one.
 *
 * Neither field ranks anything, orders anything, or gates anything. The similarity score is the
 * field that does, and it is absent from the wire by construction (#1280, correction 5).
 */
export const SKILL_PROVENANCE_RUN_NOTE =
  "How the run that produced this phrase was configured. These are facts about the run, recorded when it happened and frozen into the digest below — none of them measures how good a match anything is, and nothing here is a reason to approve or reject.";
