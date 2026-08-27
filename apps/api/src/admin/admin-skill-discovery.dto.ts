import { z } from "zod";
import { MATCH_SKILLS } from "@badabhai/taxonomy";
import type {
  SkillCandidateAction,
  SkillCandidateConfidenceBand,
  SkillCandidateEmbeddingStatus,
  SkillCandidateSourceType,
  SkillCandidateStatus,
} from "@badabhai/db";
import type { AdminCountBucket } from "./admin-dashboard.dto";
import type { AdminPage } from "./admin-entities.dto";

/**
 * Zod DTOs + response projections for the admin SKILL DISCOVERY REVIEW surface — the screen on
 * which a named human decides what a discovery run found (migration 0093, the six pure modules
 * in `packages/db/src/skill-discovery-*.ts`).
 *
 * FOUR ROUTES, and the file below is their entire contract:
 *
 *   GET  /admin/skill-discovery              the review QUEUE (keyset page + filters)
 *   GET  /admin/skill-discovery/:id          one candidate, in full, in plain language
 *   POST /admin/skill-discovery/:id/decision the ONE write — a recorded human decision
 *   GET  /admin/skill-discovery/metrics      the dashboard tiles
 *
 * ── THE ONE THING THIS SURFACE IS NOT ───────────────────────────────────────────────────
 * IT DOES NOT WRITE THE TAXONOMY. There is no request path here — none, by construction —
 * that creates a canonical `skill`, a `skill_alias`, or a `job_domain_skill` row. An approval
 * RECORDS A DECISION on `skill_candidate` and stops. The corpus write stays where it is, in the
 * offline guarded chain that already exists and already has a human in it:
 *
 *     approvedCandidateToCorpusSkill  (packages/db/src/skill-discovery-candidate.ts:542)
 *       -> validateTaxonomyCorpus     (structural)
 *       -> taxonomyQualityVerdict     (semantic)
 *       -> a human commit
 *       -> db:seed:domain-skills      (seeds as `provisional`)
 *       -> db:promote:skills          (C1..C5, RESOLVABLE_ABOVE_FLOOR, NO_REGRESSION,
 *                                      EVAL_COVERED, MATCH_VOCABULARY)
 *
 * That chain is the reason `resulting_skill_id` STAYS NULL on an `approved_create` row until the
 * corpus actually mints the skill and somebody backfills it — which makes the column the honest
 * answer to "did this approval ever ship?". An API that filled it in at decision time would
 * turn that honest answer into a lie, and would do it in the one place nobody re-reads.
 *
 * The shape of this file enforces that. There is NO field anywhere below that names a skill to
 * be created, no `commit` flag, no `promote` route, and the decision RESULT carries
 * {@link SKILL_DECISION_EFFECT_RECORDED_ONLY} as a LITERAL TYPE so a client cannot render
 * "skill created" without the type telling it otherwise.
 *
 * ── THE MATCH-SKILL WALL (`mskill_*`) ───────────────────────────────────────────────────
 * `mskill_*` is a CLOSED, CEO-ratified 18-member vocabulary that the deterministic match engine
 * consumes (`MATCH_SKILLS`, packages/taxonomy/src/match-skills.ts — 18 members, counted). It is
 * not a skill catalogue and nothing discovered may ever join it. The wall is already built at
 * four levels — index build (skill-discovery-match.ts:113 drops `kind === "match_skill"` and any
 * `mskill_` prefix), `validateCandidate`'s MATCH_IS_MATCH_SKILL / RESULTING_IS_MATCH_SKILL /
 * PROPOSED_LABEL_IS_MATCH_SKILL, and the two DB CHECKs `skill_candidate_not_match_skill_chk` and
 * `skill_candidate_match_not_match_skill_chk`.
 *
 * THIS FILE ADDS THE FIFTH AND EARLIEST LEVEL: {@link SkillCorpusSkillId} refuses an
 * `mskill_`-shaped or `MATCH_SKILLS`-member id AT THE PIPE, as a 400, before a transaction is
 * opened. Both halves of the test are kept — the prefix (matching the CHECK's `NOT LIKE
 * 'mskill\_%'`) AND set membership against `MATCH_SKILLS` — because those are two different
 * guarantees and `validateCandidate` deliberately uses the second: a match skill renamed out of
 * the prefix convention would slip a prefix-only test.
 *
 * ── NO NUMBER MOVES A STATUS ────────────────────────────────────────────────────────────
 * There is no threshold, no score gate, no confidence floor and no auto-approve anywhere on this
 * surface, and there is no field through which one could be introduced. `proposed_action` and
 * `confidence_band` are SUGGESTION columns the reviewer reads; `status` moves only on an explicit
 * decision from a named admin.
 *
 * Two consequences that look like omissions and are not:
 *
 *   * THE SIMILARITY SCORE IS NOT ON THE WIRE. `skill_candidate_match.score` is `real NOT NULL`
 *     and the repository reads it, but {@link AdminSkillRelatedSkill} has no `score` key. A 0..1
 *     number on a review screen re-imports exactly the thinking this surface exists to keep out:
 *     a UI that sorts by it, or an operator who learns that "0.9 is fine", has recreated a
 *     de-facto approval floor with no owner ruling behind it. What a reviewer needs instead is
 *     WHY — a relation, a strength, and a sentence — which is what that interface carries.
 *   * A REVIEWER IS NEVER SHOWN THE WORDS "COSINE", "EMBEDDING" OR "VECTOR". The relation codes
 *     are translated by {@link SKILL_MATCH_RELATION_LABELS} into plain English, including
 *     `vector_cosine`, which is the one relation in the vocabulary that has no lexical evidence
 *     behind it at all (skill-discovery-candidate.ts:184 admits it for a future semantic pass).
 *
 * ── PROVENANCE IS FROZEN, AND THAT IS STRUCTURAL HERE ───────────────────────────────────
 * `provenanceDigest` is a sha256 over 19 named fields in a DECLARED ORDER
 * (skill-discovery-candidate.ts:240); `PROVENANCE_DIGEST_MISMATCH` is the alarm that fires when
 * one of them moved. So the decision body below has no path to any of them — not one of the 19
 * appears as a request field on any branch of {@link AdminSkillDecisionSchema}, and every
 * `.strict()` turns an attempt into a 400 rather than a silently dropped key. On the response
 * side they are grouped into a nested {@link AdminSkillCandidateProvenance}, which is a small
 * shape trick with a real payoff: "the frozen fields" is a thing a reader can point at.
 *
 * The service must still call `assertProvenanceIntact(before, after)` and reject a non-empty
 * result, and must NEVER recompute a stored `provenance_digest` to "fix" a mismatch — that
 * launders the exact lineage lie the digest exists to expose.
 *
 * ── WHAT A DECISION MUST NAME, OR THE DATABASE REFUSES IT ───────────────────────────────
 * `skill_candidate_reviewed_chk` requires `reviewer_admin_id` AND `reviewed_at` AND
 * `review_reason` all NOT NULL for every human-decided status (schema/skill-discovery.ts:394),
 * and `validateCandidate` flags the same condition as DECISION_WITHOUT_REVIEWER with a
 * `.trim() === ""` test — so a blank reason is not a decision even though it satisfies NOT NULL.
 * Hence: `review_reason` is MANDATORY on every branch with a real minimum length, and the other
 * two are NEVER in the body. The reviewer is `@CurrentAdmin().id` from the session and the moment
 * is the server clock, because an actor a caller can type is not an actor.
 *
 * ── MIGRATION 0093 IS AUTHORED, NOT APPLIED ─────────────────────────────────────────────
 * The four tables are journalled (migrations/meta/_journal.json idx 93) and the migration header
 * records 0092 as the applied head. Whether the tables exist on any given cluster is a runtime
 * question this repo answers by hand (`--doctor`), not by "merged". Nothing in this file requires
 * them to exist: it is types and zod schemas only, so it compiles and its tests run against no
 * database at all.
 *
 * All four tables are RLS + FORCE + REVOKE ALL with ZERO policies, so a Supabase anon /
 * service_role client reads zero rows and reports no error. The repository must reach them
 * through the owner connection, exactly as the rest of the spine does. A silently-empty queue is
 * the failure mode to expect if that is got wrong, and an empty queue is indistinguishable from
 * "nothing to review" on the screen.
 *
 * ── WHAT THE SERVICE STILL OWES (stated here so it is not discovered late) ──────────────
 *   1. A ROW -> `SkillCandidateRecord` ASSEMBLER. Every safety function in packages/db —
 *      `validateCandidate`, `assertProvenanceIntact`, `reviewTier`, `prioritize`,
 *      `approvedCandidateToCorpusSkill` — takes the snake_case `SkillCandidateRecord` with its
 *      children inline and NO `updated_at`. The drizzle row is camelCase with `updatedAt` and no
 *      children. That assembler is the one genuinely new piece of logic this surface needs, and
 *      it must preserve `created_at` AS THE STORED STRING: round-tripping it through a `Date` and
 *      re-serializing changes the fractional-second precision, and every provenance digest check
 *      then fails.
 *   2. A BARREL EXPORT IN packages/db. `canTransition`, `statusForDecision`, `TERMINAL_STATUSES`,
 *      `reviewTier`, `MatchRelation`, `PhraseClass` and the rest are NOT re-exported from
 *      `packages/db/src/index.ts` today (it exports ./schema, ./client, ./credit-packs, ./crypto,
 *      ./current-profile, ./question-pack-resolver, ./rfs-vocabulary,
 *      ./occupation-retrieval-eval, ./question-pack-corpus — nothing else), and package.json
 *      exposes only "." and "./schema", so a deep import will not resolve at runtime either. The
 *      vocabularies below that CAN be pinned to an exported type are pinned; the four that
 *      cannot are mirrored with the mirror written on them. That is a stopgap, not a design.
 *   3. FIVE NEW `ADMIN_ACTION_CODES` and ONE NEW SUBJECT TYPE. The event is already registered —
 *      `admin.action_performed` v1 — and must be REUSED (`EVENT_NAMES` is pinned at 168 in
 *      event-schema.test.ts:3045, so a new event name is a test edit for nothing). Because the
 *      payload is VALUE-FREE — `AdminActionPerformedPayload` is `.strict()` over exactly four
 *      keys, so there is no leaf a value could occupy — the decision must be readable from the
 *      CODE alone: one code per decision
 *      kind, five kinds. `"skill_candidate"` must be appended to `SUBJECT_TYPES`
 *      (packages/event-schema/src/enums.ts) or the emit fails at `stage:"envelope"` before any
 *      insert; that is additive, needs no version bump and needs no migration (`subject_type` is
 *      plain `text` with no CHECK).
 *
 * ── ONE BLOCKING OWNER DECISION, NOT TAKEN HERE (CLAUDE.md §16) ─────────────────────────
 * The three READS sit on `read_entities`, the read floor all four roles hold and the capability
 * every admin read surface declares. THE WRITE HAS NO EXISTING CAPABILITY THAT FITS. The write
 * capabilities in `ADMIN_CAPABILITIES` are `suspend_payer`, `grant_credits`,
 * `force_close_posting`, `flag_worker`, `toggle_kill_switch`, `reveal_pii`, `manage_admins`,
 * `export` — every one of them is entity moderation, money, or identity. Authoring the platform's
 * skill taxonomy is none of those, and reusing (say) `flag_worker` would hand taxonomy authorship
 * to support staff as a side effect of a moderation grant.
 *
 * The recommendation is to MINT `review_skill_candidates` and grant it narrowly. It is not done
 * here because it is not a backend-only change: it breaks FOUR pinned literal lists —
 * `ADMIN_CAPABILITIES` + `ADMIN_CAPABILITY_MATRIX` (admin-capabilities.ts), the drift test's
 * transcribed `EXPECTED` matrix (admin-roles.guard.test.ts:151-188) plus the second literal
 * twelve-item list in admin-worker-journey.authz.test.ts:156-170, and `apps/admin-web`'s
 * `ADMIN_CAPABILITIES` + exhaustive `CAPABILITY_LABELS` — and that last pair is Frontend
 * Platform's file (CLAUDE.md §5/§6), so a backend-only PR would leave the console's label map
 * incomplete. It needs the owner ruling and a Frontend issue, in that order.
 */

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Vocabularies
// ═══════════════════════════════════════════════════════════════════════════════════════════

/**
 * `Exhaustive<Union, Tuple>` is `Tuple` when the tuple covers the union EXACTLY, and `never`
 * otherwise — so annotating a tuple with it makes both drift directions a compile error:
 *
 *   * a FOREIGN member is caught by the constraint (`Tuple extends readonly [Union, ...Union[]]`)
 *   * a MISSING member is caught by the conditional — the annotated type collapses to `never`,
 *     and a tuple is not assignable to `never`.
 *
 * WHY NOT `as const satisfies readonly Union[]`, which is the shape used at
 * admin-actions.dto.ts:64 and :80. Because `satisfies` accepts any SUBSET: dropping a member, or
 * adding one to the db union and forgetting this file, still compiles — and the reader then
 * silently stops accepting a status that a writer can still produce, which on a REVIEW QUEUE
 * means a candidate that no filter can reach. admin-dashboard.dto.ts:585-595 records the same
 * finding and reaches for a `Record<Union, true>` for it; that form loses the literal tuple that
 * `z.enum` needs, so the conditional is the version that works here.
 *
 * It only works for a union this package can actually IMPORT. The four vocabularies below that
 * live in an unexported packages/db module say so on themselves.
 */
type Exhaustive<Union extends string, Tuple extends readonly [Union, ...Union[]]> = [
  Exclude<Union, Tuple[number]>,
] extends [never]
  ? Tuple
  : never;

const STATUS_TUPLE = [
  "pending",
  "needs_review",
  "approved_create",
  "approved_map",
  "approved_merge",
  "rejected",
  "deferred",
] as const;

/**
 * The status ladder, in ladder order, pinned to the db union.
 *
 * SEVEN MEMBERS AND NO NEW ONES. The vocabulary is shared with `skill_candidate_status_chk`, so
 * a value this reader accepts that no writer can produce is unrepresentable, and a status a
 * writer CAN produce that this reader rejects is a compile error.
 *
 * Read it as three groups, because the API treats them differently:
 *   `pending` / `needs_review`   MACHINE-WRITABLE. A discovery run may write these and only
 *                                these, and they may NOT carry a reviewer
 *                                (`skill_candidate_machine_status_chk`).
 *   `approved_create` / `approved_map` / `approved_merge` / `rejected`   TERMINAL. Never left.
 *   `deferred`                   A HUMAN DECISION THAT IS NOT TERMINAL — "somebody looked and
 *                                could not decide", which is a real answer and deliberately
 *                                re-openable, so queue metrics can tell it apart from "nobody
 *                                opened it".
 */
export const SKILL_CANDIDATE_STATUSES: Exhaustive<SkillCandidateStatus, typeof STATUS_TUPLE> =
  STATUS_TUPLE;
export const SkillCandidateStatusEnum = z.enum(SKILL_CANDIDATE_STATUSES);

const ACTION_TUPLE = ["map", "create", "merge", "reject", "review"] as const;

/**
 * The MACHINE'S SUGGESTION (`skill_candidate.proposed_action`), pinned to the db union and to
 * `skill_candidate_action_chk`.
 *
 * IT IS A SUGGESTION AND IT IS ON A DIFFERENT AXIS FROM `status` — which is why the two are
 * separate columns and separate filters, and why no code path maps one onto the other. A
 * `proposed_action: "map"` candidate is still `pending` until a human says otherwise, and the
 * pipeline may only ever SUGGEST `map`/`merge` off a STRONG match (`proposeAction`,
 * skill-discovery-plan.ts:264, enforced as WEAK_MATCH_DROVE_ACTION).
 */
export const SKILL_CANDIDATE_ACTIONS: Exhaustive<SkillCandidateAction, typeof ACTION_TUPLE> =
  ACTION_TUPLE;
export const SkillCandidateActionEnum = z.enum(SKILL_CANDIDATE_ACTIONS);

const BAND_TUPLE = ["high", "medium", "low"] as const;

/**
 * The confidence BAND, pinned to the db union and to `skill_candidate_band_chk`.
 *
 * A BAND, NOT A NUMBER, IS WHAT THE FILTER TAKES. The `confidence` column exists (nullable
 * `real`, CHECKed to 0..1) and is not filterable here on purpose: `?confidenceAbove=0.8` is a
 * threshold, and a threshold that selects a review queue is one product decision away from a
 * threshold that approves it. Three named buckets cannot be tuned into a floor.
 */
export const SKILL_CANDIDATE_CONFIDENCE_BANDS: Exhaustive<
  SkillCandidateConfidenceBand,
  typeof BAND_TUPLE
> = BAND_TUPLE;
export const SkillCandidateConfidenceBandEnum = z.enum(SKILL_CANDIDATE_CONFIDENCE_BANDS);

const SOURCE_TYPE_TUPLE = [
  "job_domain_alias",
  "job_domain_label",
  "unresolved_phrase",
  "worker_phrase",
  "job_text",
  "skill_alias",
] as const;

/**
 * Where a contributing phrase came from, pinned to the db union and to
 * `skill_candidate_source_type_chk`.
 *
 * `worker_phrase` IS THE ONLY MEMBER THAT CAN CARRY WORKER-DERIVED WORDS, and it is why the
 * privacy section of this file exists at all. See {@link AdminSkillCandidateSource}.
 */
export const SKILL_CANDIDATE_SOURCE_TYPES: Exhaustive<
  SkillCandidateSourceType,
  typeof SOURCE_TYPE_TUPLE
> = SOURCE_TYPE_TUPLE;
export const SkillCandidateSourceTypeEnum = z.enum(SKILL_CANDIDATE_SOURCE_TYPES);

const EMBEDDING_STATUS_TUPLE = ["reused", "needs_embedding", "not_required"] as const;

/**
 * Whether this candidate's phrase needed an embedding, pinned to the db union and to
 * `skill_candidate_embedding_status_chk`. Provenance, not a control: it records what the run did,
 * and `SKILL_CANONICALIZE_ENABLED` is not read anywhere on this surface.
 */
export const SKILL_CANDIDATE_EMBEDDING_STATUSES: Exhaustive<
  SkillCandidateEmbeddingStatus,
  typeof EMBEDDING_STATUS_TUPLE
> = EMBEDDING_STATUS_TUPLE;

/**
 * The REVIEW TIER — the queue's own grouping (`ReviewTier`,
 * packages/db/src/skill-discovery-plan.ts:756).
 *
 * MIRRORED, NOT IMPORTED, and no `Exhaustive` guard is available: `skill-discovery-plan.ts` is
 * not re-exported from `packages/db/src/index.ts` and the package exposes only "." and
 * "./schema", so there is no type here to pin against. Drift is therefore a REVIEW obligation
 * until item 2 of the header's owed list lands. Three members, from plan.ts:758-763:
 *
 *   `direct`     the phrase names work, or the taxonomy already has an opinion about it.
 *                Highest yield per reviewer-minute.
 *   `derived`    an occupation title with a modifier — a skill MAY be extractable, most will not
 *                be worth one. The long tail, measured at 78% of the corpus.
 *   `ambiguous`  shape gives no signal. Explicitly queued as a human's call.
 *
 * IT IS DERIVED, NOT STORED — see {@link SKILL_TIER_DERIVED_NOT_STORED}.
 */
export const ADMIN_SKILL_REVIEW_TIERS = ["direct", "derived", "ambiguous"] as const;
export const AdminSkillReviewTierEnum = z.enum(ADMIN_SKILL_REVIEW_TIERS);
export type AdminSkillReviewTier = (typeof ADMIN_SKILL_REVIEW_TIERS)[number];

/**
 * The classifier's SHAPE VERDICT (`PhraseClass`, skill-discovery-classify.ts:70). Mirrored for
 * the same reason as the tiers, with the same drift caveat.
 *
 * THERE IS NO `SKILL` MEMBER AND THAT ABSENCE IS THE ENFORCEMENT (classify.ts:65-69): nothing
 * the classifier can observe justifies asserting that a phrase IS a canonical skill — that
 * assertion needs an extracted label, a dedup pass against the shipped catalogue, and a human.
 * This surface IS the human; it must not be handed a verdict that pre-empts it.
 */
export const ADMIN_SKILL_PHRASE_CLASSES = [
  "REJECTED_NON_SKILL",
  "OCCUPATION_ONLY",
  "OCCUPATION_WITH_SKILL_EVIDENCE",
  "ACTIVITY_PHRASE",
  "AMBIGUOUS",
] as const;
export type AdminSkillPhraseClass = (typeof ADMIN_SKILL_PHRASE_CLASSES)[number];

/**
 * How a candidate phrase relates to an already-shipped skill — `MatchRelation`
 * (skill-discovery-match.ts:144, whose tail is `EquivalenceRelation` from
 * taxonomy-lexical.ts:236) plus `vector_cosine` (skill-discovery-candidate.ts:184).
 *
 * Mirrored, same caveat. `skill_candidate_match.relation` has NO DB CHECK — the vocabulary is
 * closed in TypeScript only — which is exactly why {@link AdminSkillRelatedSkill.relation} is
 * typed `string` on the wire and this union exists only to force a sentence per known member in
 * {@link SKILL_MATCH_RELATION_LABELS}.
 */
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

/** `skill_candidate_match_strength_chk` — two members, CHECK-backed, so this one is closed. */
export const ADMIN_SKILL_MATCH_STRENGTHS = ["strong", "weak"] as const;
export type AdminSkillMatchStrength = (typeof ADMIN_SKILL_MATCH_STRENGTHS)[number];

/**
 * THE TRANSLATION LAYER — one plain-English sentence per relation, and the whole reason a
 * reviewer never has to know what any of these codes mean.
 *
 * WRITTEN AS SENTENCES A NON-ENGINEER CAN ACT ON, not as glosses of the code names. "shares a
 * consonant skeleton" is a correct description of `skeleton_surface` and tells a reviewer
 * nothing; "the same phrase apart from spelling" tells them what to do about it.
 *
 * THE TWO DEMOTED RELATIONS SAY SO IN THE SENTENCE. `strict_token_subset` and
 * `high_token_overlap` are graded STRONG by taxonomy-lexical (which compares two curated skill
 * LABELS) and deliberately demoted to WEAK here (which compares an occupation TITLE against a
 * skill label). The measured reason is on record from the 2026-08-26 dry run: "customs
 * inspector" -> quality inspector, "bicycle mechanic" -> fitter, "battery servicing" -> plumber
 * were all reported STRONG under the inherited grading, and every one is an occupation sharing a
 * generic role word with a skill label. A reviewer reading "shares some of the same words" will
 * not mistake that for "these are the same thing"; a reviewer reading "strict token subset"
 * might.
 *
 * A `Record` over the union, so adding a relation without writing its sentence fails the build.
 * The lookup is still a PARTIAL one at runtime, because the column has no CHECK — see
 * {@link AdminSkillRelatedSkill.relation_label} for what an unrecognised code renders as.
 */
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

/**
 * The two strengths, as a reviewer-facing claim rather than a grade.
 *
 * "STRONG" DOES NOT MEAN "APPROVE IT". It means the machine was allowed to SUGGEST a resolution
 * off this evidence (`STRONG_MATCH_RELATIONS`, skill-discovery-match.ts:193); the decision is
 * still entirely the reviewer's, and `WEAK_MATCH_DROVE_ACTION` exists precisely because a weak
 * relation must never have been the reason for a suggestion. The sentences are worded to leave
 * the decision where it belongs.
 */
export const SKILL_MATCH_STRENGTH_LABELS: Readonly<Record<AdminSkillMatchStrength, string>> = {
  strong: "Looks like the same thing.",
  weak: "Possibly related — worth a look, not a match.",
};

/**
 * The classifier verdict in plain English. Same partial-lookup caveat as the relations, and for
 * a sharper reason: `skill_candidate.phrase_class` is `text NOT NULL` with NO CHECK
 * (schema/skill-discovery.ts:285), so the closed vocabulary lives only in TypeScript.
 */
export const SKILL_PHRASE_CLASS_LABELS: Readonly<Record<AdminSkillPhraseClass, string>> = {
  REJECTED_NON_SKILL: "Not vocabulary at all — leftover prose, or nothing usable once tidied.",
  OCCUPATION_ONLY: "A job title and nothing more. It names a role, not work.",
  OCCUPATION_WITH_SKILL_EVIDENCE: "A job title with a modifier that names actual work.",
  ACTIVITY_PHRASE: "Names an activity rather than a person. Skill-shaped.",
  AMBIGUOUS: "Its shape gives no honest signal either way.",
};

/**
 * A machine-readable marker, in the shape of {@link import("./admin-dashboard.dto")} 's
 * `AI_COST_CAVEAT_SINCE_0077` and for the same reason: the portal keys a caption off a stable
 * string, and prose that changes shape breaks a caption silently.
 *
 * WHAT IT SAYS. `review_tier` is NOT A COLUMN. It is computed by `reviewTier`
 * (skill-discovery-plan.ts:758) from exactly two facts — `phrase_class` and whether ANY match
 * has `strength = "strong"` — so it cannot be reconciled against a stored value, it changes if a
 * candidate is re-scored, and a client must not cache it as an attribute of the row. It ships on
 * the metrics response so a dashboard cannot present a derived breakdown as a stored one.
 *
 * It is also the one derivation on this surface most at risk of being reimplemented twice. The
 * service must derive it from those two facts at ONE call site, mirroring plan.ts:758-763; and
 * note the final line of that function is `return "derived"`, so an unrecognised `phrase_class`
 * (possible — no CHECK) lands silently in the LARGEST tier.
 */
export const SKILL_TIER_DERIVED_NOT_STORED = "review_tier_is_derived_not_stored" as const;

/**
 * What an approval DID, as a literal type on the response.
 *
 * A UI that renders "skill created" after a `create` approval is not a cosmetic bug — it tells a
 * reviewer the taxonomy changed when nothing outside `skill_candidate` moved, and the next
 * person to look for the skill will not find it. Carrying the effect as a LITERAL on
 * {@link AdminSkillDecisionResult} means a client that wants to claim otherwise has to fight the
 * type system to do it.
 */
export const SKILL_DECISION_EFFECT_RECORDED_ONLY = "decision_recorded_no_corpus_write" as const;

/**
 * What happens NEXT, as a stable code rather than prose — so the console can render the real
 * next step ("queued for the offline corpus chain") instead of implying completion.
 */
export const SKILL_DECISION_NEXT_STEP_OFFLINE_CORPUS_CHAIN =
  "awaiting_offline_corpus_chain" as const;

// ── the reviewer's five buttons ───────────────────────────────────────────────────────────

/**
 * THE REVIEWER-FACING DECISION VOCABULARY — the owner's buttons, in the owner's words.
 *
 *   `create`  [CREATE NEW SKILL]                  -> `approved_create`
 *   `alias`   [ADD AS ALIAS TO EXISTING SKILL]    -> `approved_map`
 *   `merge`   [MERGE CANDIDATES]                  -> `approved_merge`
 *   `reject`  [REJECT]                            -> `rejected`
 *   `hold`    [HOLD / NEED MORE EVIDENCE]         -> `deferred`
 *
 * WHY `alias` AND `hold` RATHER THAN THE LADDER'S OWN `map` AND `defer`. Because the button says
 * "add as alias" and the ladder says `approved_map`, and a route that accepted `map` would make
 * the API and the screen disagree about what the reviewer just did. The translation is one frozen
 * map ({@link SKILL_DECISION_TO_LIBRARY_DECISION}) with nothing else in it, and the STATUS is
 * still produced by `statusForDecision` in packages/db — never by a switch in this codebase.
 * `statusForDecision` is described in its own source as "the ONE place decision -> status lives"
 * (skill-discovery-candidate.ts:153); a second copy here would be exactly the drift that comment
 * exists to prevent.
 *
 * MERGE IS A DECISION KIND, NOT A SEPARATE ROUTE, and that is a considered choice. Everything
 * that makes this write safe is per-candidate and identical across all five kinds: the guarded
 * UPDATE, the `skill_candidate_reviewed_chk` triple, the terminal-status refusal, the
 * expected-status concurrency check, the single audited emit inside one transaction. A second
 * route would be a second copy of every one of those, and the copies drift — which is how one of
 * five decision paths ends up without the concurrency check.
 *
 * ⚠ AND MERGE MEANS SOMETHING NARROWER THAN THE BUTTON SAYS. "[MERGE CANDIDATES]" reads as
 * candidate-to-candidate, and migration 0093 CANNOT REPRESENT THAT: there is no
 * `merged_into_candidate_id` column, and `skill_candidate_resolution_chk` requires
 * `approved_map`/`approved_merge` to carry a `resulting_skill_id` — a SKILL. So `merge` here is
 * "this candidate is the same competency as this EXISTING SKILL", which is what the status
 * docblock says it is (schema/skill-discovery.ts:151). A genuine candidate-to-candidate merge is
 * a SCHEMA change and therefore an owner decision (CLAUDE.md §16); it is deliberately absent
 * rather than approximated, because approximating it would mean inventing a column's meaning.
 *
 * `[REVIEW CLUSTER]` IS NOT A DECISION AND IS NOT HERE. It is a navigation act, and the queue
 * already serves it: {@link AdminSkillDiscoveryQuerySchema} takes `runId` + `clusterKey`, and
 * every row carries both. A "review cluster" button is a link.
 *
 * THERE IS NO `reopen` KIND, deliberately. `deferred -> needs_review` IS a legal transition, but
 * no owner button asks for it, and it has a trap: a deferred row necessarily carries a
 * `reviewer_admin_id` (the reviewed CHECK), while `needs_review` FORBIDS one
 * (`skill_candidate_machine_status_chk`) — so a re-open must NULL the reviewer in the same
 * UPDATE or the database refuses the write. No reviewer is stranded by the omission:
 * `deferred -> approved_* | rejected` are all legal, so a held candidate can still be decided
 * directly.
 */
export const ADMIN_SKILL_REVIEW_DECISIONS = [
  "create",
  "alias",
  "merge",
  "reject",
  "hold",
] as const;
export type AdminSkillReviewDecision = (typeof ADMIN_SKILL_REVIEW_DECISIONS)[number];

/**
 * The decision word `statusForDecision` takes (skill-discovery-candidate.ts:153). Mirrored
 * because that module is not exported from the barrel; it is a parameter type, not a second
 * definition of anything.
 */
export type SkillCandidateLibraryDecision = "map" | "create" | "merge" | "reject" | "defer";

/**
 * The ONLY translation in this file: the reviewer's word -> the library's word. It carries no
 * statuses, because the status is `statusForDecision`'s answer and must stay its answer.
 *
 * A `Record` over the union so a sixth button cannot be added without translating it.
 */
export const SKILL_DECISION_TO_LIBRARY_DECISION: Readonly<
  Record<AdminSkillReviewDecision, SkillCandidateLibraryDecision>
> = {
  create: "create",
  alias: "map",
  merge: "merge",
  reject: "reject",
  hold: "defer",
};

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Shared field schemas
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** The 18 `mskill_*` ids, lower-cased — the set `validateCandidate` tests membership against. */
const MATCH_SKILL_IDS: ReadonlySet<string> = new Set(
  MATCH_SKILLS.map((s) => s.skillId.toLowerCase()),
);

/** The prefix the two DB CHECKs encode as `NOT LIKE 'mskill\_%'`. */
const MATCH_SKILL_PREFIX = "mskill_";

/**
 * A CORPUS skill id (`skill.skill_id`) — the target of an `alias` or a `merge` decision.
 *
 * NOT `.uuid()`, and that is not the id-filter convention slipping. `skill.skill_id` is a `text`
 * primary key holding `skill_<slug>` (`taxonomySkillIdFor`, packages/db/src/taxonomy-corpus.ts:462
 * — `skill_${slug}`, e.g. `skill_arc_welding`), so a uuid rule would reject every legal value.
 * The 22P02-at-BIND trap that makes `.uuid()` mandatory on a uuid column does not apply to a text
 * column; the anchored charset below is what stops junk instead.
 *
 * THE TWO `mskill_` REFUSALS ARE THE POINT. Both halves are kept because they are different
 * guarantees: the PREFIX test mirrors the DB CHECKs, and SET MEMBERSHIP against `MATCH_SKILLS`
 * mirrors what `validateCandidate` actually tests (RESULTING_IS_MATCH_SKILL), which would still
 * catch a match skill renamed out of the prefix convention. `skill_mskill_` is refused too,
 * because that is the shape `taxonomySkillIdFor` produces from a match-skill LABEL and is what
 * PROPOSED_LABEL_IS_MATCH_SKILL looks for.
 *
 * Refusing at the pipe rather than at the CHECK is worth the duplication: a 400 names the
 * problem, whereas a CHECK violation arrives as a 500 after a transaction was opened, and it
 * arrives on the one code path where a reviewer is mid-decision.
 */
export const SkillCorpusSkillId = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9_-]+$/,
    "A skill id may contain only letters, digits, underscores and hyphens.",
  )
  .refine((id) => !id.toLowerCase().startsWith(MATCH_SKILL_PREFIX), {
    message:
      "mskill_* is the closed match vocabulary and can never be a discovery target. See skill_candidate_not_match_skill_chk.",
  })
  .refine((id) => !id.toLowerCase().startsWith(`skill_${MATCH_SKILL_PREFIX}`), {
    message:
      "This is a match-skill label in corpus-id clothing. See PROPOSED_LABEL_IS_MATCH_SKILL.",
  })
  .refine((id) => !MATCH_SKILL_IDS.has(id.toLowerCase()), {
    message: "This id is a member of MATCH_SKILLS, the closed 18-member match vocabulary.",
  });

/**
 * A `jd_*` occupation-catalogue id, shape-checked only.
 *
 * SHAPE, NOT EXISTENCE, and the split is deliberate. Whether `jd_nco_7411_0100` is a real row is
 * a database question, and the service answers it against `job_domain` before recording any
 * decision — a well-formed id that does not exist would otherwise fail the `job_domain_skill` FK
 * halfway through a seed, weeks later, naming a constraint instead of a fix. What a pipe CAN do
 * cheaply is refuse a value that is not an id at all, so a typo becomes a 400 that names the
 * field rather than a 500 from a query.
 *
 * The `jd_` prefix is required because the repository carries THREE id spaces that all call
 * themselves "domain" (see the header of `packages/db/src/schema/occupation.ts`): `jd_*`
 * occupation domains, the 11 bare-slug `SKILL_DOMAINS`, and `dom_*`. A bare slug arriving here
 * would resolve to nothing and read as a missing row rather than a wrong id space.
 */
export const JobDomainId = z
  .string()
  .trim()
  .min(4)
  .max(64)
  .regex(
    /^jd_[a-z0-9_]+$/,
    "A job-domain id looks like `jd_nco_7411_0100` — lowercase, digits and underscores after the `jd_` prefix.",
  );

/**
 * Ceiling on how many trades one approval may name.
 *
 * A BOUND, not a business rule: it stops a single request from writing an unbounded number of
 * `job_domain_skill` edges. Twenty is far above anything a reviewer would legitimately tick on
 * one screen — the widest candidate in the measured corpus is attested in 37 domains, and
 * claiming a new skill belongs to all of them is a decision that deserves more than one click.
 */
/**
 * `job_domain_skill.default_requirement`, mirrored. CHECK-backed in 0093
 * (`skill_candidate_requirement_chk`), so a union is a claim the column can honour.
 */
export const ADMIN_SKILL_REQUIREMENTS = ["required", "preferred"] as const;
export type SkillRequirement = (typeof ADMIN_SKILL_REQUIREMENTS)[number];

export const ADMIN_SKILL_APPROVED_DOMAINS_MAX = 20;

/**
 * Minimum length of a review reason. NOT decoration.
 *
 * `skill_candidate_reviewed_chk` only demands NOT NULL, which `""` satisfies — but
 * `validateCandidate` flags `(review_reason ?? "").trim() === ""` as DECISION_WITHOUT_REVIEWER,
 * i.e. the pipeline's own validator does not consider a blank-reasoned row to be a decision at
 * all. So a row the database accepts can still be a row the corpus layer refuses, and the only
 * place to catch that cheaply is here.
 *
 * TWELVE, so that a single category word cannot pass. "duplicate" is nine characters and is a
 * LABEL, not a reason; the thing a reviewer six months from now needs is the sentence
 * ("'helper' is a seniority marker, not a competency"). The bound is deliberately low enough
 * that a real short sentence fits.
 */
export const ADMIN_SKILL_REVIEW_REASON_MIN = 12;

/**
 * Maximum length of a review reason, and of a proposed label/description.
 *
 * The columns are unbounded `text` on tables that are FORCE RLS with no size CHECK, so the only
 * bound that exists is this one. An unbounded decision body is a storage-amplification path into
 * the system of record, reachable by anyone holding the write capability.
 */
export const ADMIN_SKILL_REVIEW_REASON_MAX = 500;
export const ADMIN_SKILL_PROPOSED_LABEL_MAX = 120;
export const ADMIN_SKILL_PROPOSED_DESCRIPTION_MAX = 500;

/**
 * The mandatory reason, on every branch. `.trim()` before the length test, so whitespace cannot
 * buy the minimum.
 */
const reviewReason = z
  .string()
  .trim()
  .min(ADMIN_SKILL_REVIEW_REASON_MIN)
  .max(ADMIN_SKILL_REVIEW_REASON_MAX);

// ═══════════════════════════════════════════════════════════════════════════════════════════
// GET /admin/skill-discovery — the queue
// ═══════════════════════════════════════════════════════════════════════════════════════════

/**
 * Hard upper bound on a single queue page, and the default.
 *
 * 100/50, MATCHING THE FACELESS ENTITY AND FEEDBACK CEILINGS rather than the halved ai-trace
 * one. The halved ceiling exists on ai-traces because every row there names a stored
 * conversation, so a full walk of the list is an index of which worker spoke and when. A queue
 * row here is a NORMALIZED VOCABULARY PHRASE plus counts — there is no `worker_id` column on any
 * of the four tables to index against, by design — so the argument for halving does not reach it.
 */
export const ADMIN_SKILL_DISCOVERY_PAGE_MAX = 100;
export const ADMIN_SKILL_DISCOVERY_PAGE_DEFAULT = 50;

/** Bound on the free-text phrase prefix. Long enough for any real phrase (`MAX_PHRASE_TOKENS` is 8). */
export const ADMIN_SKILL_PHRASE_PREFIX_MAX = 80;

/**
 * The two page orders. BOTH ARE THE SAME KEYSET KEY — `(created_at, id)` — differing only in
 * direction, which is exactly why one cursor module serves both and no new one is written here.
 *
 * `newest` (default) is `DESC`, the shipped admin order. `oldest` is `ASC`, and it is the one an
 * operator actually working the backlog wants: the oldest undecided candidate is the one at risk
 * of never being decided, and a newest-first queue hides it further every time a run lands.
 *
 * A `priority` ORDER IS DELIBERATELY NOT OFFERED. `reviewPriority` (skill-discovery-plan.ts:777)
 * is `tier*1_000_000 + source_domain_count*1000 + source_alias_count*10 + band`, and its own
 * module says not to reimplement those weights in SQL because they will drift. Sorting a single
 * page by it in the service would be worse than not offering it: the client would see a
 * "priority queue" that is only priority-ordered WITHIN an arbitrary time slice, which is a
 * wrong answer wearing a right one's clothes. The honest substitute is already here — filter by
 * `tier` and `band`, then read newest-first — and it is honest because every one of those
 * filters is a real predicate over real columns.
 *
 * ⚠ THE CURSOR DOES NOT CARRY THE DIRECTION. `encodeEntityCursor` writes `{c, i}` and nothing
 * else (admin-entities.cursor.ts:27-29), so a token minted on a `newest` page and replayed with
 * `sort=oldest` silently pages the wrong way — the same rows again, ascending. The client MUST
 * carry `sort` on every page-turn alongside `cursor`. Folding the direction into the token is the
 * right fix and it belongs in a cursor module for this surface, which is out of scope for this
 * file; it is recorded here rather than left to be rediscovered from a paging bug.
 */
export const ADMIN_SKILL_DISCOVERY_SORTS = ["newest", "oldest"] as const;
export const AdminSkillDiscoverySortEnum = z.enum(ADMIN_SKILL_DISCOVERY_SORTS);
export type AdminSkillDiscoverySort = (typeof ADMIN_SKILL_DISCOVERY_SORTS)[number];
export const ADMIN_SKILL_DISCOVERY_SORT_DEFAULT: AdminSkillDiscoverySort = "newest";

/**
 * `?status=pending&status=needs_review` — one repeat per value, coerced to an array.
 *
 * A MULTI-VALUED STATUS FILTER IS NOT A CONVENIENCE HERE, IT IS THE DEFAULT VIEW. "Everything
 * not yet decided" is TWO statuses (`pending` and `needs_review`), and with a single-valued
 * filter the console would have to make two requests and paste the pages together — which breaks
 * keyset paging outright, since two cursors over two result sets cannot be merged into one
 * honest `nextCursor`.
 *
 * The idiom is `stringOrArray` from admin-events.dto.ts:49-53, piped into the enum so an unknown
 * status is a 400 rather than a silently ignored filter.
 *
 * THERE IS NO SERVER-SIDE DEFAULT STATUS. An absent filter means UNFILTERED, and the console
 * sends the two undecided statuses explicitly — so the URL says what the screen shows. A hidden
 * default is how a screen ends up claiming to show a queue while showing a filtered subset of it.
 */
const statusFilter = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v : [v]))
  .pipe(
    z
      .array(SkillCandidateStatusEnum)
      .min(1)
      .max(SKILL_CANDIDATE_STATUSES.length),
  );

/**
 * The queue query. `.strict()` for the reason every sibling is strict: silently dropping an
 * unknown filter is how a screen shows an unfiltered list while its URL claims otherwise — a
 * wrong answer that looks like a right one.
 *
 * ── WHICH FILTERS ARE INDEX-BACKED, AND WHICH ARE NOT ──────────────────────────────────
 * Migration 0093 ships `skill_candidate_queue_idx (status, confidence_band,
 * source_domain_count)`, `skill_candidate_run_id_idx`, `skill_candidate_family_idx
 * (trade_family)`, `skill_candidate_reviewer_idx`, `skill_candidate_resulting_skill_idx` and the
 * UNIQUE `skill_candidate_run_cluster_uq (run_id, cluster_key)`, and — added while wiring this
 * surface up, because the queue read is the only thing that needs them —
 * `skill_candidate_admin_keyset_idx (created_at DESC NULLS FIRST, candidate_id DESC NULLS FIRST)`
 * for the page order and `skill_candidate_norm_prefix_idx (normalized_phrase text_pattern_ops)`
 * for the anchored prefix.
 *
 * `.nullsFirst()` is load-bearing on the first and invisible in a diff: drizzle's bare `desc()`
 * in the repository renders `DESC NULLS FIRST`, and an index built `NULLS LAST` does not satisfy
 * it, so the planner keeps the index for the filter and adds a Sort anyway
 * (packages/db/src/schema/feedback.ts:95-104). `text_pattern_ops` is load-bearing on the second:
 * a btree on the collation-aware default cannot serve `LIKE 'welding%'` outside the C locale.
 *
 * Both went into 0093 itself rather than a follow-up, because it had never been applied — which
 * is the cheapest moment either will ever be.
 */
export const AdminSkillDiscoveryQuerySchema = z
  .object({
    cursor: z.string().min(1).max(256).optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(ADMIN_SKILL_DISCOVERY_PAGE_MAX)
      .optional()
      .default(ADMIN_SKILL_DISCOVERY_PAGE_DEFAULT),
    sort: AdminSkillDiscoverySortEnum.optional().default(ADMIN_SKILL_DISCOVERY_SORT_DEFAULT),

    /** One or many. See {@link statusFilter} — the undecided view is two values, not one. */
    status: statusFilter.optional(),

    /**
     * The reviewer's grouping. DERIVED, NOT A COLUMN — see {@link SKILL_TIER_DERIVED_NOT_STORED}.
     *
     * It is still an honest SQL filter, because `reviewTier` reads exactly two things and both
     * are queryable: `phrase_class`, and whether ANY child match has `strength = 'strong'`. The
     * repository must compose it from THOSE TWO FACTS — a `phrase_class IN (...)` shortcut would
     * be a second definition of `reviewTier` that silently disagrees with the first the moment
     * the strong-match half matters, which is on every `OCCUPATION_ONLY` candidate that happens
     * to have an exact surface hit.
     *
     * The strong-match half is an EXISTS subquery, not a join: a join against
     * `skill_candidate_match` multiplies a candidate by its match count and the page would then
     * carry duplicate rows and a `limit` that means nothing.
     */
    tier: AdminSkillReviewTierEnum.optional(),

    /** `skill_candidate_band_chk`-backed. A band, never a threshold — see the constant. */
    band: SkillCandidateConfidenceBandEnum.optional(),

    /** The machine's SUGGESTION, not a status. `skill_candidate_action_chk`-backed. */
    proposedAction: SkillCandidateActionEnum.optional(),

    /**
     * `trade_family` is `text` NULLABLE with no CHECK — the families come from the job-domain
     * layer at run time, so there is no closed tuple to pin an enum against. A bare bounded
     * string is the honest shape; `skill_candidate_family_idx` serves it.
     */
    tradeFamily: z.string().trim().min(1).max(64).optional(),

    /**
     * Narrow to candidates having AT LEAST ONE source of this type — an EXISTS over
     * `skill_candidate_source`, for the same no-row-multiplication reason as `tier`.
     *
     * It is the filter that makes the privacy posture INSPECTABLE rather than asserted:
     * `?sourceType=worker_phrase` is how a reviewer (or an auditor) finds exactly the candidates
     * that carry worker-derived wording. Being able to ask that question is the point.
     */
    sourceType: SkillCandidateSourceTypeEnum.optional(),

    /**
     * One discovery run. `skill_discovery_run.run_id` is a `text` PRIMARY KEY shaped
     * `sdr_<compact-iso>_<slug>` (`discoveryRunId`, skill-discovery-run.ts:64), NOT a uuid — so
     * `.uuid()` would reject every legal value, and there is no 22P02 trap to guard against on a
     * text column.
     */
    runId: z.string().trim().min(1).max(128).optional(),

    /**
     * One cluster within one run — the `[REVIEW CLUSTER]` affordance.
     *
     * `cluster_key` is unique only WITHIN a run (`skill_candidate_run_cluster_uq`), never
     * globally: the same phrase legitimately produces a candidate in run 1 and again in run 5
     * against a changed corpus, and BOTH must stay inspectable. So this filter is only
     * meaningful together with `runId`, and without it it returns the same cluster from every
     * run it ever appeared in — which is a legitimate question ("what did we decide last time?")
     * and is why it is not refused.
     */
    clusterKey: z.string().trim().min(1).max(200).optional(),

    /**
     * ANCHORED PREFIX MATCH ON `normalized_phrase`. NOT a substring search, and not full text.
     *
     * WHY A SEARCH IS PERMITTED AT ALL HERE, when `worker_feedback` refuses one outright
     * (admin-feedback.dto.ts:16-18) and `ai_call_traces` refuses one too. Because the corpus is
     * different in kind: `normalized_phrase` is a NORMALIZED VOCABULARY TERM ("arc welding"),
     * produced by the pipeline's own normalizer, and the reviewer's central question is "is this
     * phrase already in the queue?" — which cannot be answered by paging. It is not a person's
     * prose and it is not attributable: there is no `worker_id` column on any of the four tables.
     *
     * WHY IT IS ANCHORED ANYWAY. A leading-wildcard substring search over a corpus that includes
     * worker-derived wording is a discovery tool no matter how the column is described, and an
     * anchored prefix demands that the caller already knows how the phrase starts. It is also the
     * only shape an index can serve, and `skill_candidate_norm_prefix_idx` now serves it — which
     * is what makes the anchored rule honest rather than merely polite, since the anchored form
     * is also the fast one and nobody has a performance argument for widening it. An unanchored
     * search would be a scan of every candidate on every keystroke, indexes or not.
     *
     * `.trim().toLowerCase()` and nothing more. Full normalization (punctuation folding,
     * stoplisting) is the lexicon's job, and a half-normalizer here would silently fail to match
     * rows it looked like it should — so this does the part it can do honestly and leaves the
     * rest alone. The exact-vs-prefix behaviour is documented for the console because "search"
     * that quietly means "starts with" is its own small lie.
     */
    phrase: z.string().trim().toLowerCase().min(1).max(ADMIN_SKILL_PHRASE_PREFIX_MAX).optional(),

    /**
     * `created_at` range, inclusive. `z.coerce.date()`, the idiom at admin-events.dto.ts:65-66.
     *
     * Bounds the question "what did the run on Tuesday find", which is the normal way an operator
     * scopes a review session, and it is the only time filter here: `reviewed_at` is deliberately
     * NOT filterable, because "which decisions did admin X make last week" is an audit question
     * and the audit surface is the event spine, which already answers it by actor.
     */
    createdFrom: z.coerce.date().optional(),
    createdTo: z.coerce.date().optional(),
  })
  .strict();
export type AdminSkillDiscoveryQueryDto = z.infer<typeof AdminSkillDiscoveryQuerySchema>;

/**
 * The `:id` path param. `candidate_id` IS a uuid (`skill_candidate.candidate_id`,
 * `gen_random_uuid()` default though the writer must supply the deterministic
 * `candidateId(run_id, cluster_key)`), so the standard uuid param schema applies unchanged.
 */
export const AdminSkillDiscoveryParamsSchema = z.object({ id: z.string().uuid() }).strict();
export type AdminSkillDiscoveryParamsDto = z.infer<typeof AdminSkillDiscoveryParamsSchema>;

// ═══════════════════════════════════════════════════════════════════════════════════════════
// POST /admin/skill-discovery/:id/decision — the one write
// ═══════════════════════════════════════════════════════════════════════════════════════════

/**
 * The fields every decision carries, whatever the kind.
 *
 * `expected_status` IS THE OPTIMISTIC-CONCURRENCY TOKEN, and it is a complete one for THIS
 * ladder. Two reviewers open the same candidate; both decide. The second write must fail loudly
 * rather than overwrite the first, and the guarded UPDATE's `WHERE status = <expected>` does
 * exactly that — because EVERY legal transition changes `status`, and there is no legal
 * self-transition anywhere in the table (`canTransition('deferred','deferred')` is false, as is
 * every other diagonal). So "the status the reviewer was looking at" is sufficient to detect that
 * somebody else moved first.
 *
 * WHY NOT AN `updated_at` / ETAG TOKEN, which is the reflex. Because it is a measured trap on
 * this stack: `updated_at` is `timestamptz`, Postgres keeps MICROSECONDS and a JS `Date` keeps
 * milliseconds, so a token minted from a row's timestamp and bound back as a `Date` does not
 * equal the row it came from. That is migration 0083's finding, reproduced in
 * admin-keyset-params.test.ts:227-257 ("six rows seeded inside one millisecond, page size 2 -> 2
 * returned, 4 skipped"). A concurrency token that never matches turns every decision into a 409;
 * a concurrency token that matches by luck is worse.
 *
 * IT IS ALSO THE FIELD THAT MAKES THE LADDER'S ONE AWKWARD EDGE VISIBLE.
 * `canTransition('pending', 'deferred')` is FALSE — `pending` may only go to `needs_review` or
 * `rejected` — so a `hold` on a `pending` candidate is a TWO-STEP: `pending -> needs_review`,
 * then `needs_review -> deferred`. Writing `deferred` straight onto a `pending` row passes every
 * DB CHECK (the reviewer triple is satisfied) and violates the code ladder silently, which is
 * the worst combination available. The service must run the two steps inside the one
 * transaction; `expected_status` is what tells it which case it is in without a re-read racing
 * the write.
 *
 * `review_reason` is MANDATORY here rather than per-branch, because there is no decision on this
 * surface that does not need one — including `reject`, which is the one a future reviewer is most
 * likely to want explained.
 *
 * NEITHER THE REVIEWER NOR THE MOMENT IS IN THE BODY. `reviewer_admin_id` is
 * `@CurrentAdmin().id` from the session and `reviewed_at` is the server clock. An actor a caller
 * can type is not an actor, and this row is the audit trail for a taxonomy decision that outlives
 * everyone in it.
 */
const decisionBase = {
  expected_status: SkillCandidateStatusEnum,
  review_reason: reviewReason,
};

/**
 * THE DECISION BODY — a discriminated union, one member per button, every member `.strict()`.
 *
 * A UNION RATHER THAN ONE FLAT OBJECT WITH OPTIONAL FIELDS, because the database's conditional
 * CHECKs become UNREPRESENTABLE STATES instead of runtime errors:
 *
 *   `skill_candidate_create_label_chk`   `approved_create` requires `proposed_skill_name`
 *                                        -> the `create` member REQUIRES it.
 *   `skill_candidate_resolution_chk`     `approved_map`/`approved_merge` require
 *                                        `resulting_skill_id`
 *                                        -> the `alias` and `merge` members REQUIRE it.
 *
 * And the mirror image, which is the half a flat object would have got wrong:
 *
 *   `create` DOES NOT ACCEPT `resulting_skill_id`. `.strict()` makes sending one a 400. This is
 *   invariant 6 expressed as a type: `resulting_skill_id` stays NULL on an approved_create row
 *   until the offline chain actually mints the skill and somebody backfills it, and a request
 *   field for it would be the exact shortcut this whole surface exists to refuse.
 *
 *   `reject` and `hold` accept NEITHER a target nor a label. A rejection that names a resulting
 *   skill is not a rejection, and the row would fail `validateCandidate` on the next pass.
 *
 *   `alias` and `merge` do not accept `proposed_skill_name`. The label matters only when
 *   something new is being proposed; on a mapping it would be a second name for a skill that
 *   already has one, recorded nowhere the corpus reads.
 *
 * `proposed_skill_name` IS EDITABLE AND THAT IS DELIBERATE — it is one of the two fields
 * `PROVENANCE_FIELDS` deliberately EXCLUDES (skill-discovery-candidate.ts:233), precisely because
 * it is the proposal a reviewer is invited to correct. Correcting it is a NEW FACT in the review
 * columns, not a change to what the run observed, which is why the digest does not cover it.
 *
 * THE ONE CHECK THIS UNION CANNOT MAKE. `PROPOSED_LABEL_IS_MATCH_SKILL` tests
 * `taxonomySkillIdFor(label)` against `MATCH_SKILLS` — i.e. it refuses a LABEL that would
 * canonicalize onto a match skill ("CNC Turner"). That needs the corpus id function, so it is the
 * service's call to `validateCandidate` on the assembled record, and the DTO says so rather than
 * half-implementing it with a substring guess.
 */
export const AdminSkillDecisionSchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal("create"),
      ...decisionBase,
      /** The canonical label for the NEW skill. Bounded; the corpus id is derived from it later. */
      proposed_skill_name: z.string().trim().min(2).max(ADMIN_SKILL_PROPOSED_LABEL_MAX),
      /** Optional. Reviewer-authored, editable, and outside the provenance digest. */
      proposed_description: z
        .string()
        .trim()
        .min(1)
        .max(ADMIN_SKILL_PROPOSED_DESCRIPTION_MAX)
        .optional(),
      /**
       * WHICH TRADES THE NEW SKILL BELONGS TO. REQUIRED, minimum one, and it is the field the
       * whole `create` branch turns on.
       *
       * `validateTaxonomyCorpus` refuses a skill with zero `job_domain_skill` edges —
       * `SKILL_ORPHAN`, whose own message is the argument: *"Nothing reaches this skill: it is
       * not on any trade's picker and no posting can be built from it. It seeds, it embeds, and
       * it is invisible."* The first version of the export path emitted no edges, on the
       * defensible-sounding grounds that a discovery pipeline must not INFER what a trade
       * requires — and every batch it produced was permanently BLOCKED.
       *
       * The resolution is neither to infer the edge nor to weaken the gate. It is to ask the
       * human who is already looking at the answer: the review screen shows this candidate's
       * SOURCE OCCUPATIONS, and the reviewer accepts them, trims them, or names others. That is
       * precisely the judgement `job_domain_skill.source = 'curated'` already represents.
       *
       * `.min(1)` mirrors `skill_candidate_create_domain_chk`, so an orphan is a 400 here rather
       * than a constraint violation in the repository. The SERVICE still resolves every id
       * against `job_domain` — a well-formed `jd_*` that does not exist would otherwise fail the
       * edge FK halfway through a seed, weeks later, naming a constraint instead of a fix.
       *
       * ONLY ON `create`. An `alias` or `merge` lands on a skill that already has its own edges,
       * and `.strict()` makes sending this field on those branches a 400 — the same discipline
       * that keeps `resulting_skill_id` off `create`.
       */
      approved_job_domain_ids: z
        .array(JobDomainId)
        .min(1, "a new skill must name at least one trade, or nothing will ever reach it")
        .max(ADMIN_SKILL_APPROVED_DOMAINS_MAX),
      /**
       * `required` or `preferred` for those trades. Optional, defaulting to `preferred`.
       *
       * The DEFAULT is the conservative one and matches `job_domain_skill.default_requirement`'s
       * own: `required` is a strong claim about hiring, and a newly discovered skill has no
       * evidence behind it yet. A reviewer who knows better says so; the default never
       * overstates on their behalf.
       */
      approved_requirement: z.enum(["required", "preferred"]).default("preferred"),
    })
    .strict(),
  z
    .object({
      decision: z.literal("alias"),
      ...decisionBase,
      /** The EXISTING skill this phrase is another name for. Never an `mskill_*`. */
      resulting_skill_id: SkillCorpusSkillId,
    })
    .strict(),
  z
    .object({
      decision: z.literal("merge"),
      ...decisionBase,
      /**
       * The EXISTING skill this candidate is the SAME COMPETENCY as. A skill, not a candidate —
       * see the note on {@link ADMIN_SKILL_REVIEW_DECISIONS} for why 0093 cannot express the
       * candidate-to-candidate reading of the button.
       */
      resulting_skill_id: SkillCorpusSkillId,
    })
    .strict(),
  z.object({ decision: z.literal("reject"), ...decisionBase }).strict(),
  z.object({ decision: z.literal("hold"), ...decisionBase }).strict(),
]);
export type AdminSkillDecisionDto = z.infer<typeof AdminSkillDecisionSchema>;

/**
 * Why a decision was refused as a CONFLICT (409) rather than a validation failure (400) or a
 * missing row (404). A CLOSED CODE, because the console has to say three different true things
 * and prose cannot be switched on.
 *
 *   `stale_expected_status`  Somebody moved this candidate since you loaded it. Reload and look
 *                            again — the other decision might be the right one.
 *   `already_decided`        This candidate is TERMINAL and terminal means terminal. The
 *                            decision was recorded against a specific `corpus_fingerprint`, and
 *                            re-opening the row in place would silently re-scope it to a corpus
 *                            the human never saw. Re-deciding is a NEW candidate in a NEW run.
 *   `illegal_transition`     `canTransition` refused the move — e.g. `pending -> approved_map`,
 *                            which skips the human-review rung entirely. The database would NOT
 *                            have caught this one; `canTransition` is the only enforcement, which
 *                            makes the API the enforcement point.
 */
export const ADMIN_SKILL_DECISION_CONFLICTS = [
  "stale_expected_status",
  "already_decided",
  "illegal_transition",
] as const;
export type AdminSkillDecisionConflict = (typeof ADMIN_SKILL_DECISION_CONFLICTS)[number];

/**
 * The 409 body. Carries the CURRENT status so the console can re-render without a second
 * request, and carries no reason text: the first decision's `review_reason` belongs to the
 * reviewer who wrote it, and the loser of a race does not need it to recover.
 */
export interface AdminSkillDecisionConflictBody {
  candidate_id: string;
  conflict: AdminSkillDecisionConflict;
  /** The status the row is in NOW. What the caller expected is echoed back beside it. */
  current_status: SkillCandidateStatus;
  expected_status: SkillCandidateStatus;
}

/**
 * The decision RESULT. Extends {@link import("./admin-actions.dto").AdminActionResult} — the
 * shape every governed admin action already answers with, and the shape `apps/admin-web`'s Server
 * Actions already validate (`z.object({ target_id, changed })`). Reusing it is why a skill
 * decision needs no new client-side result contract.
 *
 * `changed: false` IS A SUCCESSFUL NO-OP, exactly as on every other governed action, and it is
 * how idempotency is expressed rather than by duplicating work:
 *
 *   * the SAME decision resubmitted on an ALREADY-TERMINAL row whose status already equals what
 *     this decision would produce -> `changed: false`, `already_decided: true`, HTTP 200. Nothing
 *     is written, no event is emitted, and — critically — the FIRST reviewer's `reviewer_admin_id`
 *     / `reviewed_at` / `review_reason` are NOT overwritten. A retry must not silently reassign
 *     authorship of a decision.
 *   * a DIFFERENT decision on an already-terminal row -> 409 `already_decided`. That is not a
 *     retry, it is a disagreement, and it is not this route's job to resolve one.
 *   * a concurrent racer that got there first -> the guarded WHERE matches no row, so the
 *     transaction rolls back to `changed: false` with no event. The pre-transaction terminal read
 *     short-circuits the common case without opening a transaction at all; the WHERE guard is
 *     what closes the TOCTOU the pre-read leaves open. Both layers are needed —
 *     admin-actions.repository.ts:41-44 says the guard must be IN THE WHERE for exactly this.
 *
 * `corpus_effect` and `next_step` are LITERAL TYPES, not strings. See
 * {@link SKILL_DECISION_EFFECT_RECORDED_ONLY}.
 */
export interface AdminSkillDecisionResult {
  /** The opaque candidate id the decision addressed (the path param). */
  target_id: string;
  /** True when the row changed; false on an idempotent no-op. */
  changed: boolean;
  /** The status the row is in after this request — `statusForDecision`'s answer, never ours. */
  status: SkillCandidateStatus;
  /** True when the row was already terminal in exactly this state before the request. */
  already_decided: boolean;
  /** Always the literal. The taxonomy did not change; a decision was recorded. */
  corpus_effect: typeof SKILL_DECISION_EFFECT_RECORDED_ONLY;
  /**
   * Always the literal, for an approval. It names the offline chain the reviewer's decision now
   * waits on, so a console can say "queued for the corpus chain" instead of "done".
   */
  next_step: typeof SKILL_DECISION_NEXT_STEP_OFFLINE_CORPUS_CHAIN;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Response projections
// ═══════════════════════════════════════════════════════════════════════════════════════════

/**
 * WHICH COLUMNS GET A UNION TYPE AND WHICH GET `string` — the rule this file follows, and it is
 * the house rule, not a preference.
 *
 * A CHECK-BACKED column is typed as its union, because the database cannot hold anything else. A
 * plain `text` column typed only in TypeScript is typed `string`, because a bad write, a manual
 * `UPDATE` or an older deploy can put a value there that no member matches, and a precise type
 * over an imprecise column is a claim the data cannot honour. It is why
 * {@link import("./admin-entities.dto").AdminWorkerListItem} carries `status: string` while this
 * file's `status` is a union — `workers.status` has no CHECK and `skill_candidate.status` does.
 *
 * So, from migration 0093: `status`, `proposed_action`, `confidence_band`, `embedding_status`,
 * `source_type` and match `strength` are UNIONS (CHECK-backed). `phrase_class`,
 * `classifier_rule`, `trade_family` and match `relation` are `string` — all four are `text` with
 * no CHECK, closed in TypeScript only.
 */

/**
 * One existing skill this candidate might already be — SIMILARITY AS EVIDENCE, never as a score.
 *
 * A REVIEWER READS FOUR THINGS AND NONE OF THEM IS A NUMBER: which skill, how it relates, how
 * strongly, and one sentence saying why. There is no `score` key on this interface even though
 * `skill_candidate_match.score` is `real NOT NULL` and the repository reads it — see the header
 * for why. `AdminSkillCandidateMatchRow` is where the score lives, and it never leaves the
 * service.
 *
 * ⚠ The guarantee is "the wire type has no such key", which makes an explicit projection the only
 * way to build this object — it is NOT proof against a spread, since TypeScript does not
 * excess-property-check spread members. The mapper must name each field. That caveat is written
 * down because the equivalent claim at admin-feedback.dto.ts:147-153 reads absolute and this one
 * cannot.
 */
export interface AdminSkillRelatedSkill {
  /** The corpus skill id. Never an `mskill_*` — `skill_candidate_match_not_match_skill_chk`. */
  skill_id: string;
  /**
   * The skill's human label (`skill.label_en`, `text NOT NULL`). Non-null because the match row
   * carries an FK to `skill.skill_id`, so the row it names exists.
   *
   * IT IS NOT OPTIONAL FURNITURE. A review screen that offers `skill_arc_welding` as a mapping
   * target is asking a reviewer to approve an identifier; the label is what makes the question
   * answerable.
   */
  skill_label: string;
  /**
   * The relation code. `string`, not the union — `relation` has no DB CHECK
   * (schema/skill-discovery.ts:519), so the vocabulary is closed in TypeScript only and typing it
   * precisely here would be a claim the column cannot keep.
   */
  relation: string;
  /**
   * The relation as one plain-English sentence — {@link SKILL_MATCH_RELATION_LABELS}.
   *
   * An UNRECOGNISED relation renders its own raw code, never a guessed sentence: an invented
   * explanation of evidence a reviewer is about to act on is worse than an unfamiliar code, which
   * at least reads as "ask somebody".
   */
  relation_label: string;
  /** CHECK-backed, so the union is honest. */
  strength: AdminSkillMatchStrength;
  /** The strength as a claim — {@link SKILL_MATCH_STRENGTH_LABELS}. */
  strength_label: string;
  /**
   * The evidence line the pipeline recorded (`evidence_detail`), NEVER null on the wire.
   *
   * The column is nullable. When it is null the service substitutes the relation's own sentence,
   * because that IS the reason — whereas a blank cell reads as "no reason was found", which is a
   * strictly stronger and false claim.
   */
  evidence: string;
  /**
   * The pipeline's own ordering, 1..n contiguous (`skill_candidate_match_rank_chk` requires an
   * integer >= 1; `MATCH_RANK_INVALID` re-checks it).
   *
   * RANK SURVIVES WHERE SCORE DOES NOT because it is an ORDER, not a measurement. "Best first" is
   * what a reviewer needs to read the list in a sensible sequence; "0.87" is a number they will
   * start comparing against a remembered cutoff.
   */
  rank: number;
}

/**
 * One phrase that contributed to this candidate — the "source occupations" a reviewer needs to
 * judge whether the cluster is one concept.
 *
 * ── THE PRIVACY POSTURE OF `original_text`, WHICH IS THE ONLY SENSITIVE FIELD HERE ──────
 * For `source_type = "worker_phrase"` this is text that originated with a worker, so it gets the
 * same scrutiny `worker_feedback.message` got. It is served, and the posture is STRONGER than
 * feedback's, on three counts that are properties of the schema rather than promises:
 *
 *   1. IT CANNOT BE ATTRIBUTED. There is no `worker_id` column on ANY of the four tables in
 *      migration 0093 — deliberately, so this never becomes a per-worker DSAR surface. A response
 *      here cannot be joined back to a person because the join column does not exist.
 *   2. IT IS PSEUDONYMIZED UPSTREAM by contract for that source type.
 *   3. THE CLASSIFIER REFUSES THE SHAPES THAT CARRY IDENTIFIERS. `hasForbiddenAliasChars` /
 *      FORBIDDEN_CHARS is checked FIRST, before every taxonomy question, and rejects any phrase
 *      containing a digit, an `@` or a URL. So a phone number, an email or a link cannot be a
 *      candidate source in the first place.
 *
 * AND THE REVIEWER CANNOT DO THE JOB WITHOUT IT: these strings ARE the alias set a `create`
 * approval would eventually mint (see {@link AdminSkillDiscoveryDetail.suggested_aliases}).
 * Hiding them would mean approving aliases nobody was shown.
 *
 * WHAT STAYS REFUSED: a substring or full-text SEARCH over this column. `phrase` searches
 * `normalized_phrase` on the candidate and is anchored; nothing on this surface searches
 * `original_text`, in any form, ever. And it must never be echoed into a log, an event payload or
 * an audit record — `admin.action_performed` is value-free by construction:
 * `AdminActionPerformedPayload` is `.strict()` over `admin_id`, `action_code`, `target_type` and
 * `target_id` (payloads.ts:2292-2299), so a phrase has nowhere to go and an extra key is a
 * validation error rather than a silently stripped field. `FORBIDDEN_VALUE_FRAGMENTS` in
 * `admin-skill-discovery.service.test.ts` re-checks the emitted payload against a fixture list;
 * it is a second opinion in the tests, NOT a runtime scanner.
 */
export interface AdminSkillCandidateSource {
  /** CHECK-backed. `worker_phrase` is the one member that carries worker-derived wording. */
  source_type: SkillCandidateSourceType;
  /**
   * `text`, deliberately NOT a typed FK: the six source types span four id spaces
   * (schema/skill-discovery.ts:466). Opaque to this surface.
   */
  source_id: string;
  /** As it was written. See the privacy note above. */
  original_text: string;
  /** As the pipeline normalized it — what clustering and matching actually operated on. */
  normalized_text: string;
  /** The job domain it was attested in, when it came from one. */
  job_domain_id: string | null;
}

/**
 * How many sources of each type back this candidate — the "source counts" a reviewer uses to
 * judge attestation without reading every row.
 *
 * DENSIFIED: every member of `SKILL_CANDIDATE_SOURCE_TYPES` is emitted, zeros included, for the
 * reason admin-dashboard.dto.ts:482-487 states — an absent bucket and a zero bucket are the same
 * JSON and mean different things to a reader.
 *
 * NO `other` BUCKET, unlike the dashboard's densified enums. That bucket exists there because
 * four of those five columns are unchecked `text`; `skill_candidate_source.source_type` HAS a
 * CHECK, so an `other` row could never be non-zero and would be furniture claiming to be a guard.
 */
export type AdminSkillSourceTypeBuckets = AdminCountBucket<SkillCandidateSourceType>[];

/**
 * THE FROZEN FIELDS, grouped so that "frozen" is something a reader can point at.
 *
 * Every field here is one of the 19 `PROVENANCE_FIELDS` (or is derived from them), the digest is
 * taken over those 19 in a DECLARED ORDER, and `PROVENANCE_DIGEST_MISMATCH` is the alarm when one
 * moves. Grouping them buys two things beyond tidiness: a reviewer sees at a glance which part of
 * the screen is a record rather than a proposal, and the decision body has no field that could
 * address any of them.
 *
 * `provenance_digest` IS SERVED. It is not a secret and it is the only way a reader can tell that
 * a row's lineage still checks out. It must never be recomputed on an update path to make a
 * mismatch go away — that launders the lie it exists to expose.
 */
export interface AdminSkillCandidateProvenance {
  /** The run that produced this candidate. `text`, `sdr_<compact-iso>_<slug>`. */
  run_id: string;
  /** Unique within the run only, never globally — the same phrase recurs across runs. */
  cluster_key: string;
  /** The classifier's rule code. `text`, no CHECK, so `string`. */
  classifier_rule: string;
  /** The shape verdict. `text`, no CHECK, so `string`. See {@link SKILL_PHRASE_CLASS_LABELS}. */
  phrase_class: string;
  /** The occupation heads the classifier found. */
  occupation_heads: string[];
  /** The tokens it treated as evidence of work. */
  evidence_tokens: string[];
  /** CHECK-backed. */
  embedding_status: SkillCandidateEmbeddingStatus;
  /**
   * Both null or both set — `skill_candidate_model_pair_chk` is both-or-neither. Null means no
   * model was involved in this candidate at all, which is the ordinary case for a purely lexical
   * run.
   */
  model: string | null;
  prompt_version: string | null;
  /**
   * The corpus the decision is being made AGAINST. This is why terminal means terminal: a
   * decision recorded against this fingerprint cannot be re-scoped to a corpus the human never
   * saw.
   */
  corpus_fingerprint: string;
  /** sha256 over the 19 fields in declared order, hex, 32 chars. */
  provenance_digest: string;
}

/**
 * ONE QUEUE ROW. This interface is the ENTIRE list contract: a field absent here is a field the
 * queue cannot show, because the repository selects exactly these columns.
 *
 * Row fields are snake_case; only the page envelope key `nextCursor` is camelCase — the shipped
 * admin convention (admin-entities.dto.ts:194-200).
 */
export interface AdminSkillDiscoveryListItem {
  /** `candidate_id` — a uuid, deterministic in `(run_id, cluster_key)`. */
  id: string;
  run_id: string;
  cluster_key: string;
  /** The phrase itself, normalized. The thing being decided about. */
  normalized_phrase: string;
  /** The label the run proposed, if it proposed one. Editable by a `create` decision. */
  proposed_skill_name: string | null;
  /** `text`, no CHECK. See {@link SKILL_PHRASE_CLASS_LABELS} for the reviewer-facing sentence. */
  phrase_class: string;
  /** `text` NULLABLE, no CHECK — the families come from the job-domain layer at run time. */
  trade_family: string | null;
  /** Count of contributing source rows. `SOURCE_COUNT_MISMATCH` if it ever disagrees. */
  source_alias_count: number;
  /** Count of DISTINCT non-null job domains across those sources. Breadth of attestation. */
  source_domain_count: number;
  /** CHECK-backed. The machine's SUGGESTION, on a different axis from `status`. */
  proposed_action: SkillCandidateAction;
  /** CHECK-backed. A band, never a threshold. */
  confidence_band: SkillCandidateConfidenceBand;
  /** CHECK-backed. Moves only on an explicit human decision. */
  status: SkillCandidateStatus;
  /**
   * DERIVED, NOT STORED — {@link SKILL_TIER_DERIVED_NOT_STORED}. On the list because it is the
   * queue's headline grouping and a reviewer picks their next candidate by it.
   */
  review_tier: AdminSkillReviewTier;
  /**
   * The second of the two facts `reviewTier` reads, served alongside the tier it produced.
   *
   * IT IS HERE SO A SCREEN CAN SAY *WHY* WITHOUT A SECOND REQUEST. "direct, because the taxonomy
   * already has an opinion about this phrase" is actionable; a bare tier badge is a label the
   * reviewer has to trust.
   */
  has_strong_match: boolean;
  /** How many existing skills this phrase plausibly already is. Zero is common and meaningful. */
  related_skill_count: number;
  /**
   * The reviewing admin's opaque id, or null while undecided. NEVER a name and never an email —
   * `admin_users.name_enc` is `AdminIdentityRepository`'s alone, and nothing here goes near it.
   */
  reviewer_admin_id: string | null;
  reviewed_at: Date | null;
  /**
   * The skill an `approved_map` / `approved_merge` resolved onto.
   *
   * NULL ON AN `approved_create` ROW, AND THAT IS THE FEATURE. It stays null until the offline
   * corpus chain actually mints the skill and somebody backfills it, which makes this column the
   * honest answer to "did this approval ever ship?".
   */
  resulting_skill_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * ONE CANDIDATE IN FULL — the review screen.
 *
 * Extends the list row, per the admin convention, and adds exactly the things a decision needs
 * that a queue row does not: the sources, the related skills, the proposal's description, the
 * alias set an approval would mint, the reviewer's own words, and the frozen provenance block.
 */
export interface AdminSkillDiscoveryDetail extends AdminSkillDiscoveryListItem {
  /** The reviewer-facing sentence for {@link AdminSkillDiscoveryListItem.phrase_class}. */
  phrase_class_label: string;
  /** The proposed description, if the run proposed one. Editable by a `create` decision. */
  proposed_description: string | null;
  /**
   * WHY THIS CANDIDATE LOOKS THE WAY IT DOES, in one composed sentence.
   *
   * COMPOSED FROM STORED COLUMNS, NEVER FROM A MODEL. There is no `rationale` column in migration
   * 0093 — the run does not persist `PhraseVerdict.rationale` — so this is a rendering of
   * `classifier_rule`, `phrase_class`, `occupation_heads`, `evidence_tokens` and the two
   * attestation counts, and of nothing else. It is a restatement of provenance, not a new fact,
   * which is why it is safe to put in front of a reviewer who is about to act on it. An LLM
   * sentence here would be a machine explaining a decision it is not allowed to make
   * (CLAUDE.md §3).
   */
  rationale: string;
  /** Every contributing phrase, ordered by source type then id for a stable read. */
  sources: AdminSkillCandidateSource[];
  /** Densified counts over the six source types — zeros included. */
  source_type_counts: AdminSkillSourceTypeBuckets;
  /**
   * The existing skills this phrase plausibly already is, BEST FIRST by `rank`.
   *
   * The list, not a winner. Two shipped skills answering to one phrase is precisely the
   * `ALIAS_AMBIGUOUS` condition that makes canonicalization a coin flip, and collapsing it to a
   * single suggestion is how the coin gets flipped for the reviewer.
   */
  related_skills: AdminSkillRelatedSkill[];
  /**
   * THE ALIASES A `create` APPROVAL WOULD ACTUALLY MINT — the cluster's OTHER source
   * `original_text`s, trimmed, deduped case-insensitively, EXCLUDING the canonical label itself.
   *
   * IT IS COMPUTED BY THE SAME RULE `approvedCandidateToCorpusSkill` USES
   * (skill-discovery-candidate.ts:542), and it must stay that way, because the alternative is a
   * reviewer approving an alias set they were never shown — and the exclusion of the canonical
   * label is not cosmetic: including it produces ALIAS_DUPLICATE_WITHIN_SKILL downstream, which
   * surfaces as a corpus validation failure long after the decision, with nobody left to ask.
   *
   * IT IS A PREVIEW, NOT A COMMITMENT. Nothing on this route writes a `skill_alias` row.
   */
  suggested_aliases: string[];
  /** The reviewer's own words, once decided. Admin-authored text, not worker text. */
  review_reason: string | null;
  /**
   * THE TRADES A `create` APPROVAL NAMED. Empty until one is recorded.
   *
   * SERVED BECAUSE A DECISION IS NOT ONLY A VERDICT. The reviewer chose a specific set of job
   * domains, and that choice is what the offline chain turns into `job_domain_skill` edges with
   * `source = 'curated'`. A detail screen that showed the decision but not the trades would let
   * somebody re-open a decided candidate and see WHAT was approved without seeing WHAT FOR —
   * and this is precisely the field a second reviewer would want to check, since a wrong trade
   * produces a skill on the wrong picker rather than an obviously broken one.
   *
   * It is also what makes the record self-describing at audit time. The decision, the reason,
   * the reviewer, the moment and the scope all read from one response.
   *
   * ⚠ NOT a request field on this route. It is set by the `create` decision and never edited
   * afterwards; a terminal candidate cannot be re-decided.
   */
  approved_job_domain_ids: string[];
  /**
   * `required` or `preferred` for those trades — the reviewer's strength claim, or the
   * conservative default when they did not make one.
   *
   * CHECK-backed (`skill_candidate_requirement_chk`), so the union is honest.
   */
  approved_requirement: SkillRequirement;
  /** The frozen block. See {@link AdminSkillCandidateProvenance}. */
  provenance: AdminSkillCandidateProvenance;
}

/** A queue page. Imported, never redefined — admin-entities.dto.ts:201-204. */
export type AdminSkillDiscoveryPage = AdminPage<AdminSkillDiscoveryListItem>;

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Repository row types — what the DATABASE holds, which is not what the wire carries
// ═══════════════════════════════════════════════════════════════════════════════════════════

/**
 * ONE MATCH AS THE DATABASE HOLDS IT — {@link AdminSkillRelatedSkill} with the SCORE, and with
 * the nullable evidence column instead of the always-present sentence.
 *
 * THE SPLIT IS THE ENTIRE MECHANISM BY WHICH THE SCORE STAYS OFF THE SCREEN. The wire type has
 * no `score` key, so building a response means naming fields, and naming fields means somebody
 * has to type `score:` on a type that does not have it. It is the same device as
 * `AdminFeedbackRow`'s `attachment_paths` (admin-feedback.dto.ts:154-157), with the honest caveat
 * recorded on {@link AdminSkillRelatedSkill}: a spread would defeat it, so the mapper must
 * project explicitly.
 *
 * Translation — `relation_label`, `strength_label`, the `evidence` fallback — is the service's
 * job, not the repository's, for the same architecture reason feedback's url signing is
 * (CLAUDE.md §4): the repository does database access and the label maps are not in the database.
 */
export interface AdminSkillCandidateMatchRow
  extends Omit<AdminSkillRelatedSkill, "relation_label" | "strength_label" | "evidence"> {
  /** 0..1, CHECKed. Read for ordering and for nothing else. NEVER leaves the service. */
  score: number;
  /** Nullable, unlike the wire's `evidence`. Null means the run recorded no line. */
  evidence_detail: string | null;
}

/**
 * ONE QUEUE ROW AS THE DATABASE HOLDS IT — the list item minus the three DERIVED fields.
 *
 * `review_tier` and `has_strong_match` are absent because a tier is NOT A COLUMN, and
 * `related_skill_count` is absent because it is an aggregate over the child table. Making that
 * structural rather than conventional means a repository cannot accidentally invent a tier: the
 * type it returns has nowhere to put one.
 */
export type AdminSkillDiscoveryRow = Omit<
  AdminSkillDiscoveryListItem,
  "review_tier" | "has_strong_match" | "related_skill_count"
>;

/**
 * The minimum a tier derivation needs, and therefore the exact projection the service should ask
 * for when it derives one.
 *
 * `reviewTier` (skill-discovery-plan.ts:758-763) reads TWO THINGS: `phrase_class`, and whether
 * any match is strong. Naming that pair as a type keeps the derivation from quietly growing a
 * third input in one call site and not the other — which is how two "tiers" start disagreeing.
 */
export interface AdminSkillCandidateTierFacts {
  candidate_id: string;
  phrase_class: string;
  has_strong_match: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// GET /admin/skill-discovery/metrics — the dashboard tiles
// ═══════════════════════════════════════════════════════════════════════════════════════════

/**
 * The metrics query. Optionally scoped to ONE RUN, which is how "what did Tuesday's run find"
 * gets answered without paging the queue.
 *
 * THERE IS NO `windowDays`, unlike every other admin summary on this codebase, and the omission
 * is the decision. A spend dashboard is a rate and a window is meaningful; a REVIEW QUEUE is a
 * BACKLOG, and a 30-day window on a backlog hides the oldest undecided candidates — which are
 * precisely the rows the tile exists to make visible. `oldest_awaiting_created_at` answers the
 * age question honestly instead.
 */
export const AdminSkillDiscoveryMetricsQuerySchema = z
  .object({ runId: z.string().trim().min(1).max(128).optional() })
  .strict();
export type AdminSkillDiscoveryMetricsQueryDto = z.infer<
  typeof AdminSkillDiscoveryMetricsQuerySchema
>;

/**
 * THE DASHBOARD TILES.
 *
 * EVERY BREAKDOWN IS DENSIFIED — every enum member emitted, zeros included — for the reason
 * admin-dashboard.dto.ts:482-487 gives: an absent bucket and a zero bucket are the same JSON and
 * mean different things to a reader. "rejected: 0" is a fact worth rendering.
 *
 * AND NONE OF THEM CARRIES AN `other` BUCKET, which is a deliberate departure from the dashboard.
 * That bucket exists there because four of its five enums are unchecked `text` columns where a
 * bad write can land a value no member matches, and dropping such a row would silently break
 * `total === count(*)`. Here `status`, `confidence_band` and `proposed_action` are ALL CHECK-backed
 * (`skill_candidate_status_chk`, `_band_chk`, `_action_chk`), so an `other` row could never be
 * non-zero — and a permanently-zero bucket that looks like a corruption detector is worse than no
 * detector, because it will be trusted.
 *
 * `by_tier` IS THE ONE BREAKDOWN THAT IS NOT A GROUP BY OVER A COLUMN — it is derived, and the
 * response says so in band via {@link SKILL_TIER_DERIVED_NOT_STORED}, so a dashboard cannot
 * present it as a stored figure. The three tiers are exhaustive by construction (`reviewTier`
 * returns one of three, with `derived` as its final fallback), which is also why an unrecognised
 * `phrase_class` inflates `derived` rather than showing up anywhere as an anomaly. That is a real
 * blind spot and it is written here rather than left implicit.
 *
 * `total` IS SUMMED FROM `by_status`, not counted separately, so the headline cannot disagree with
 * its own breakdown.
 */
export interface AdminSkillDiscoveryMetrics {
  /** The run this is scoped to, or null for the whole table. Echoed so a tile can caption itself. */
  run_id: string | null;
  /** Every candidate in scope. Summed from `by_status`. */
  total: number;
  /**
   * `pending` + `needs_review` — the queue's real size.
   *
   * TWO STATUSES, NOT ONE, AND THE BREAKDOWN IS SERVED BESIDE IT. A single "pending" tile
   * conflates "the run has not routed it yet" with "it is queued for a human", and the ladder
   * distinguishes them because `MACHINE_WRITABLE_STATUSES` is exactly this pair. `deferred` is
   * deliberately NOT counted here: somebody looked and could not decide, which is a different
   * fact from nobody having looked, and merging the two is how "we have 400 to review" becomes
   * unfalsifiable.
   */
  awaiting_decision: number;
  /**
   * Candidates a human looked at and declined to decide. Its own tile because it is the one
   * number that means "this queue needs more than reviewer-hours" — more evidence, or a ruling.
   */
  deferred: number;
  /** All seven statuses, zeros included. */
  by_status: AdminCountBucket<SkillCandidateStatus>[];
  /** All three bands, zeros included. */
  by_band: AdminCountBucket<SkillCandidateConfidenceBand>[];
  /** All five suggested actions, zeros included. A suggestion breakdown, not a status one. */
  by_proposed_action: AdminCountBucket<SkillCandidateAction>[];
  /** All three tiers. Derived — see the header and the marker below. */
  by_tier: AdminCountBucket<AdminSkillReviewTier>[];
  /**
   * The `created_at` of the OLDEST candidate still awaiting a decision, or null when none is.
   * The one figure that says whether the queue is being worked or is just being added to.
   */
  oldest_awaiting_created_at: Date | null;
  /** Always the literal. `by_tier` is computed, not stored, and cannot be reconciled. */
  tier_basis: typeof SKILL_TIER_DERIVED_NOT_STORED;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// GET /admin/skill-discovery/groups — the review BATCHES
// ═══════════════════════════════════════════════════════════════════════════════════════════

/**
 * The grouping query. THE SAME FILTERS AS THE QUEUE, minus the two that make no sense on a set.
 *
 * ── WHAT IS MISSING AND WHY ────────────────────────────────────────────────────────────
 * NO `cursor` and NO `limit`. A group's contract is that it is EXHAUSTIVE for the applied
 * filters — a reviewer opening a batch of 12 must find twelve rows — and a page cannot promise
 * that. Worse, the anchor each candidate is batched on is chosen from a token count taken across
 * the WHOLE input set, so grouping a page would hand the same candidate a different batch on
 * every page-turn. The endpoint groups the filtered set or refuses; see
 * {@link ADMIN_SKILL_GROUPS_MAX_CANDIDATES}.
 *
 * NO `sort` either: groups come back biggest-first, because a group of 35 saves 35 decisions and
 * that is the whole ordering criterion.
 */
export const AdminSkillDiscoveryGroupsQuerySchema = z
  .object({
    status: statusFilter.optional(),
    tier: AdminSkillReviewTierEnum.optional(),
    band: SkillCandidateConfidenceBandEnum.optional(),
    proposedAction: SkillCandidateActionEnum.optional(),
    tradeFamily: z.string().trim().min(1).max(64).optional(),
    sourceType: SkillCandidateSourceTypeEnum.optional(),
    runId: z.string().trim().min(1).max(128).optional(),
    clusterKey: z.string().trim().min(1).max(200).optional(),
    phrase: z.string().trim().toLowerCase().min(1).max(ADMIN_SKILL_PHRASE_PREFIX_MAX).optional(),
    createdFrom: z.coerce.date().optional(),
    createdTo: z.coerce.date().optional(),
  })
  .strict();
export type AdminSkillDiscoveryGroupsQueryDto = z.infer<
  typeof AdminSkillDiscoveryGroupsQuerySchema
>;

/**
 * The largest candidate population this route will group in one response.
 *
 * WHY A CAP RATHER THAN A PAGE. Grouping must see the whole set (the anchor is global to it), so
 * the only two honest answers to "your filter matches everything" are *group it all* or *refuse
 * and say how much*. Silently truncating is the third option and it is the one that produces a
 * response claiming to be exhaustive while it is not.
 *
 * 20,000 is deliberately well above the real population — the full table is 6,673 candidates and
 * the largest sensible filter (`tier=derived`) is 6,074 — so no legitimate console request meets
 * it. It exists to stop the route becoming a full-table read on a table that will grow with every
 * run, not to shape normal use.
 */
export const ADMIN_SKILL_GROUPS_MAX_CANDIDATES = 20_000;

/**
 * ONE REVIEW BATCH — candidates a reviewer can work through together.
 *
 * ── A GROUP IS A LENS, NOT A TAXONOMY OBJECT ──────────────────────────────────────────
 * It has no id in any table, it is recomputed on every read, and it is persisted nowhere. There
 * is no group-level decision and there must never be one: every member gets its own decision,
 * its own reason and its own audit row. A console offering "decide all in this batch" must issue
 * N individual calls.
 *
 * That is not a limitation to be engineered away. A batch is a claim that these candidates are
 * worth judging TOGETHER; it is not a claim that they are the same thing. The moment a group
 * could be decided as a unit, a single wrong judgement would create thirty-five wrong rows with
 * one reason attached to all of them.
 *
 * ── NO SCORE, HERE EITHER ──────────────────────────────────────────────────────────────
 * `source_rows` and `source_domains` are ATTESTATION — how much evidence sits behind the batch —
 * and they are counts of rows, not measurements of similarity. There is no cosine on this
 * response and no field that could carry one.
 */
export interface AdminSkillReviewGroup {
  /** `<tier>|<family>|<anchor>` — derivable from the members, stable across identical requests. */
  key: string;
  tier: AdminSkillReviewTier;
  /** `text` NULLABLE with no CHECK, so `string | null`. */
  trade_family: string | null;
  /** The shared evidence token this batch is built on, or null for a family-only batch. */
  anchor: string | null;
  /** A short header a reviewer can read. Display only; never parsed. */
  label: string;
  /** Members, ascending by id — sorted so identical requests render identically. */
  candidate_ids: string[];
  /** How big the batch is. */
  candidates: number;
  /**
   * How much of it is still WORK — `pending` + `needs_review`.
   *
   * `deferred` counts as decided: somebody looked and could not settle it, which is a different
   * fact from nobody having looked.
   */
  undecided: number;
  /** Source rows behind the batch, summed. Evidence weight, never a threshold. */
  source_rows: number;
  /** DISTINCT job domains behind the batch — a union across members, never a sum of counts. */
  source_domains: number;
  /** The pipeline's suggestion when every member agrees; null when they do not. */
  unanimous_action: string | null;
}

/**
 * The grouped view of one filtered population.
 *
 * `total_candidates` and `total_undecided` are summed FROM the groups, so the headline cannot
 * disagree with its own breakdown — the same discipline `AdminSkillDiscoveryMetrics.total` uses.
 */
export interface AdminSkillDiscoveryGroups {
  groups: AdminSkillReviewGroup[];
  /** How many batches the filtered population reduces to. The review-screen count. */
  total_groups: number;
  /** Candidates grouped. Summed from `groups`, never counted separately. */
  total_candidates: number;
  /** Of those, how many still await a human. */
  total_undecided: number;
  /** Always the literal — `tier` is derived, not stored. */
  tier_basis: typeof SKILL_TIER_DERIVED_NOT_STORED;
  /** Always the literal. A group is recomputed per read and has no row anywhere. */
  grouping_basis: typeof SKILL_GROUPS_ARE_DERIVED;
}

/**
 * The in-band marker saying a group is not a stored object.
 *
 * The `AI_COST_CAVEAT_SINCE_0077` device: a consumer that wants to store a group id, or reconcile
 * these counts against a table, learns from the response itself that there is nothing to
 * reconcile against.
 */
export const SKILL_GROUPS_ARE_DERIVED = "groups_are_derived_not_stored" as const;

// ═══════════════════════════════════════════════════════════════════════════════════════════
// GET /admin/skill-discovery/:id/audit — what happened to this candidate
// ═══════════════════════════════════════════════════════════════════════════════════════════

/**
 * ONE AUDIT ENTRY. Read-only, and assembled from rows that already exist — this route creates
 * nothing and stores nothing of its own.
 *
 * ── WHERE THE ENTRIES COME FROM ────────────────────────────────────────────────────────
 * The EVENT SPINE (`events`, `subject_type = 'skill_candidate'`), which is the immutable record.
 * A decision writes one value-free `admin.action_performed` on the same transaction as the row,
 * so the spine is the thing that cannot have been edited afterwards.
 *
 * ── WHY IT CARRIES NO VALUES ───────────────────────────────────────────────────────────
 * Because the spine carries none. `admin.action_performed` is value-free by construction: the
 * WHAT is an `action_code`, never the old/new values, and `AdminActionPerformedPayload` is
 * `.strict()` over four keys, so there is no leaf a value could occupy. So an entry says WHO did
 * WHAT and WHEN, and the reason and the label live on the candidate row where the detail read
 * already serves them.
 *
 * That split is deliberate rather than awkward. The reason is admin-authored prose that can be
 * long; the spine is a fixed-shape audit trail meant to survive being queried in bulk years
 * later. Putting the prose on both would create two copies of one fact that could disagree.
 */
export interface AdminSkillCandidateAuditEntry {
  /** The spine row's own id — stable, and what an auditor cites. */
  event_id: string;
  /** When it happened, from the spine. Not the row's `updated_at`. */
  occurred_at: Date;
  /**
   * The action code — one of the five `skill_candidate_*` codes.
   *
   * Each is named for the SoR STATUS it records rather than the wire word the console sent, so
   * reconciling this against `skill_candidate.status` needs no translation table.
   */
  action_code: string;
  /** The admin who acted. An opaque id — never a name, never an email. */
  admin_id: string | null;
}

/**
 * THE AUDIT READ. The spine entries plus the decision as the row currently records it.
 *
 * BOTH HALVES, because either alone is misleading. The spine says what happened and cannot have
 * been edited; the row says what the candidate NOW is. An auditor needs to see that they agree —
 * and if they ever do not, that is the finding.
 */
export interface AdminSkillCandidateAudit {
  candidate_id: string;
  /** Oldest first — an audit trail reads forwards. */
  entries: AdminSkillCandidateAuditEntry[];
  /**
   * The decision as the SoR holds it right now. ALWAYS PRESENT — an undecided candidate has
   * a `current` whose fields are null (`status` is `pending`, nobody's id, no reason), not
   * an absent `current`. A nullable block would make "nothing has happened yet" and "the
   * row is gone" the same response, and the second is a 404.
   */
  current: {
    status: SkillCandidateStatus;
    reviewer_admin_id: string | null;
    reviewed_at: Date | null;
    review_reason: string | null;
    resulting_skill_id: string | null;
    approved_job_domain_ids: string[];
    approved_requirement: SkillRequirement;
  };
  /**
   * Always the literal. A decision is RECORDED here; the corpus is written by the offline chain,
   * so no entry in this list means a skill was created.
   */
  corpus_effect: typeof SKILL_DECISION_EFFECT_RECORDED_ONLY;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// GET /admin/skills — the MAP picker's lookup
// ═══════════════════════════════════════════════════════════════════════════════════════════

/**
 * The canonical-skill search behind the MAP/MERGE picker.
 *
 * ── WHY A NEW ROUTE AND NOT THE EXISTING SKILLS CONTROLLER ─────────────────────────────
 * `apps/api/src/skills/skills.controller.ts` is `@Controller("internal/skills")` behind
 * `SkillsInternalGuard` — the SERVICE-TO-SERVICE path. An admin console must not authenticate as
 * a service: the guard it passes would be the wrong guard, the request would carry no admin
 * identity, and nothing about the call would appear under the admin's session. Reusing it would
 * also widen an internal surface to a browser, which is how an internal route quietly becomes a
 * public one.
 *
 * ── IT SEARCHES. IT CANNOT CREATE. ─────────────────────────────────────────────────────
 * There is no POST here and no write anywhere behind it. The route exists so a reviewer can find
 * the skill they mean instead of typing an id, and typing an id is exactly what it removes: the
 * decision route validates `resulting_skill_id` against `skill` regardless, so this makes the
 * picker usable without becoming the authority on what is mappable.
 */
export const ADMIN_SKILLS_QUERY_MIN = 2;
export const ADMIN_SKILLS_QUERY_MAX = 80;
export const ADMIN_SKILLS_PAGE_MAX = 50;
export const ADMIN_SKILLS_PAGE_DEFAULT = 20;

export const AdminSkillsQuerySchema = z
  .object({
    /**
     * The search term. A MINIMUM of two characters, because a one-character prefix over the whole
     * corpus is a listing rather than a search.
     *
     * Matched as a case-insensitive CONTAINS over the label — not anchored, unlike the candidate
     * queue's `phrase`. The difference is the corpus: `skill.label_en` is 165 rows of published,
     * curated vocabulary with no worker-derived text in it, so there is no discovery surface to
     * protect, and a reviewer looking for "arc welding" should find it by typing "weld".
     */
    q: z.string().trim().min(ADMIN_SKILLS_QUERY_MIN).max(ADMIN_SKILLS_QUERY_MAX),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(ADMIN_SKILLS_PAGE_MAX)
      .optional()
      .default(ADMIN_SKILLS_PAGE_DEFAULT),
  })
  .strict();
export type AdminSkillsQueryDto = z.infer<typeof AdminSkillsQuerySchema>;

/**
 * ONE CANONICAL SKILL, as the picker needs it.
 *
 * `mappable` IS THE POINT OF THIS SHAPE. The route returns skills that MATCH the search and says
 * which of them may actually be mapped onto, rather than filtering the others out silently — a
 * reviewer searching for a skill they remember and getting nothing cannot tell "no such skill"
 * from "deprecated" from "it is a match skill", and those need different actions. The reason is
 * served with it.
 *
 * The eligibility rule is the SAME one `assertMappableTarget` enforces on the decision route, so
 * the picker cannot offer something the write would then refuse.
 */
export interface AdminCanonicalSkill {
  /** `skill_<slug>` — a text PK, never a uuid. */
  skill_id: string;
  label_en: string;
  /** CHECK-backed. */
  status: string;
  /** CHECK-backed. `match_skill` is the closed 18-member vocabulary. */
  kind: string;
  /** Whether a MAP/MERGE decision may resolve onto this one. */
  mappable: boolean;
  /** Why not, when `mappable` is false. Null when it is true. */
  not_mappable_reason: string | null;
}

export interface AdminCanonicalSkillSearch {
  skills: AdminCanonicalSkill[];
  /** Echoed so a stale response cannot be read as the answer to a newer keystroke. */
  q: string;
  /** True when the result was cut at `limit` — the console then asks for a longer term. */
  truncated: boolean;
}
