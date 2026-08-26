/**
 * @badabhai/db — Drizzle schema + client for BadaBhai's Supabase Postgres.
 *
 * - Schema/tables + row types: re-exported here and from "@badabhai/db/schema".
 * - Client: `createDbClient` (DI) / `getDb` (scripts).
 */
export * from "./schema";
export * from "./client";
export * from "./credit-packs";
export * from "./crypto";
// The one ordering that decides which `worker_profiles` row IS a worker's profile. Exported
// because the readers are spread across apps/api repositories AND the D2 backfill in this
// package — seven call sites that previously each had their own answer, one of them with no
// ORDER BY at all.
export * from "./current-profile";
// The family fallback chain. Its own header says it exists so "Phase 7's production
// QuestionPackService" can make this decision without a database — which requires that the
// service can actually IMPORT it. Unexported, the guarantee it offers (one decision, SQL-parity
// tested) is unreachable, and every consumer reimplements the chain instead.
export * from "./question-pack-resolver";
// The RFS vocabulary a `target_kind: "rfs"` question may write into. Exported because the
// orchestrator keys its capture-time normalizers on these same ids.
export * from "./rfs-vocabulary";
// The L0/L1 eval harness. Exported so `apps/api` can assert PARITY between the number this
// harness publishes and what `OccupationIndexService` actually does — see
// `occupation-retrieval-parity.test.ts`. Nothing on a request path imports it.
export * from "./occupation-retrieval-eval";
// The authored question-pack corpus reader + its validator. Exported for the SAME reason as the
// eval harness above and with the same caveat: nothing on a request path imports it. `apps/api`
// needs it to generate the reply-closure manifest — the enumeration of every string the engine can
// speak — from the real packs rather than from a fixture, and a manifest built from a fixture
// would pre-render audio for questions no worker is ever asked.
export * from "./question-pack-corpus";

// ── The skill-discovery review layer (migration 0093) ──────────────────────────────────────
//
// Exported because `apps/api`'s admin review surface is the ENFORCEMENT POINT for three rules
// that live only in TypeScript and nowhere in the database:
//
//   * `canTransition` — TERMINAL MEANS TERMINAL. No CHECK in 0093 stops an `approved_map` row
//     being UPDATEd back to `needs_review`; this table is the only thing that does. A service
//     that cannot import it has to restate the ladder, and a second copy of a transition table
//     is how "re-deciding" quietly starts re-scoping a decision to a corpus the human never saw.
//   * `statusForDecision` — the ONE place decision → status lives. Unexported, every caller
//     switches on its own strings and the API and the pipeline drift on what "merge" means.
//   * `assertProvenanceIntact` / `PROVENANCE_FIELDS` — the frozen-field list, in digest order.
//     A decision path that cannot call it can only *promise* it did not move provenance.
//
// A NAMED BLOCK, NOT `export *`, for two measured reasons: `skill-discovery-candidate.ts:64`
// re-exports five unions that `./schema` above already owns (a star would be TS2308), and
// `skill-discovery-plan.ts:805` re-exports `PhraseClass`/`ClassifierRule` from the classify
// module (a second star would collide with itself). Symbols are added here as consumers need
// them; nothing below is on a request path except the decision guards.
export {
  CANDIDATE_ACTIONS,
  CANDIDATE_SOURCE_TYPES,
  CANDIDATE_STATUSES,
  HUMAN_DECIDED_STATUSES,
  MACHINE_WRITABLE_STATUSES,
  PROVENANCE_FIELDS,
  TERMINAL_STATUSES,
  approvedCandidateToCorpusSkill,
  assertDryRunSafe,
  assertProvenanceIntact,
  canTransition,
  candidateAliasTexts,
  candidateId,
  provenanceDigest,
  sealCandidate,
  statusForDecision,
  validateCandidate,
} from "./skill-discovery-candidate";
export type {
  CandidateMatch,
  CandidateProblem,
  CandidateProblemCode,
  CandidateSource,
  ProvenanceField,
  SkillCandidateRecord,
} from "./skill-discovery-candidate";
export {
  prioritize,
  reviewPriority,
  reviewTier,
  reviewTierFrom,
  tierCounts,
} from "./skill-discovery-plan";
export type { ReviewTier } from "./skill-discovery-plan";
export { STRONG_MATCH_RELATIONS, isStrongRelation } from "./skill-discovery-match";
export type { MatchRelation } from "./skill-discovery-match";
export { CLASSIFIER_RULES } from "./skill-discovery-classify";
export type { ClassifierRule, PhraseClass } from "./skill-discovery-classify";
