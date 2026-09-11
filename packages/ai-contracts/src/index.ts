/**
 * @badabhai/ai-contracts — the request/response contracts between the NestJS API
 * and the FastAPI AI service.
 *
 * IMPORTANT: these contracts are mirrored as Pydantic models in
 * `apps/ai-service/app/contracts.py`. Keep the two in sync.
 *
 * PRIVACY: by design these contracts never carry raw worker identity (no phone,
 * full name, address, or employer name). Profiling/extraction inputs are passed
 * through the pseudonymization gateway before any LLM call. Resume generation
 * receives only the structured profile — the backend re-attaches the worker's
 * real name when assembling the final artifact, so the name never reaches the
 * AI service.
 *
 * ONE EXCEPTION, NARROW AND SIGNED: `resume-import.ts`. `ResumeEmploymentSchema`
 * carries an employer name, authorised by ruling D5 of
 * `docs/decisions/0041-resume-import-and-prefill.md` §3 (amended 2026-09-10) and
 * ONLY there — a worker's UPLOADED résumé reaches the model unmasked behind
 * `RESUME_PARSE_RAW_TEXT_ENABLED`. That file states the override in full and names
 * what it does NOT move: a PAN, an Aadhaar number, a phone or an email must still
 * never reach a stored value, an event, a log or the sheet, and the far side's
 * certifier enforces that independently of the flag. Every other contract in this
 * package is unchanged — an employer name a worker TYPES still goes straight to
 * Postgres and never through this service.
 */

// PUBLIC SURFACE — this file is a pure barrel. Every name is re-exported
// explicitly (never `export *`) so the package boundary stays auditable and
// module-internal helpers cannot leak into it.

export {
  ResumeLineSchema,
  ResumeParseInputSchema,
  ResumeEmploymentSchema,
  ResumeParseOutputSchema,
} from "./resume-import";
export type {
  ResumeLine,
  ResumeParseInput,
  ResumeEmployment,
  ResumeParseOutput,
} from "./resume-import";

export {
  ConversationMessageSchema,
  AICallMetadataSchema,
  PseudonymizationMetaSchema,
  PseudonymizationInputSchema,
  PseudonymizationOutputSchema,
} from "./common";
export type {
  ConversationMessage,
  AICallMetadata,
  PseudonymizationMeta,
  PseudonymizationInput,
  PseudonymizationOutput,
} from "./common";

export { JOB_DOMAIN_MATCH_STATUSES, JobDomainMatchSchema } from "./occupation";
export type { JobDomainMatchStatus, JobDomainMatch } from "./occupation";

export {
  ConversationStateSchema,
  ProfilingTurnInputSchema,
  ProfilingOpeningInputSchema,
  ProfilingOpeningOutputSchema,
  ProfilingTurnOutputSchema,
} from "./conversation";
export type {
  ConversationState,
  ProfilingTurnInput,
  ProfilingOpeningInput,
  ProfilingOpeningOutput,
  ProfilingTurnOutput,
} from "./conversation";

export {
  ExperienceSchema,
  SalaryExpectationSchema,
  LocationPreferenceSchema,
  AvailabilitySchema,
  DraftProfileSchema,
  ResumeProfileSchema,
  // Guards the container against the ai-service's empty-but-healthy 200s. Exported because BOTH
  // sides of storage ask it: the extraction processor before writing the container, and the
  // résumé mapper before reading one. See the doc comment on the function.
  resumeProfileCarriesValues,
  WorkerProfileDraftSchema,
  ProfileExtractionInputSchema,
  ProfileExtractionOutputSchema,
  ResumeGenerationInputSchema,
  ResumeGenerationOutputSchema,
} from "./profile";
export type {
  DraftProfile,
  ResumeProfile,
  ResumeProfileValues,
  WorkerProfileDraft,
  ProfileExtractionInput,
  ProfileExtractionOutput,
  ResumeGenerationInput,
  ResumeGenerationOutput,
} from "./profile";

export {
  JobPostingChatStateSchema,
  JobPostingDraftSchema,
  JobPostingChatOpeningInputSchema,
  JobPostingChatOpeningOutputSchema,
  JobPostingChatTurnInputSchema,
  JobPostingChatTurnOutputSchema,
} from "./job-posting";
export type {
  JobPostingChatState,
  JobPostingDraft,
  JobPostingChatOpeningInput,
  JobPostingChatOpeningOutput,
  JobPostingChatTurnInput,
  JobPostingChatTurnOutput,
} from "./job-posting";

export {
  SkillCanonicalizationInputSchema,
  SkillCanonicalizationSchema,
  SkillAliasEmbedItemSchema,
  SkillAliasEmbedInputSchema,
  SkillAliasEmbedResultSchema,
  SkillAliasEmbedOutputSchema,
  GrowthPhraseSchema,
  GrowthAnchorSchema,
  GrowthClusterInputSchema,
  GrowthProposalSchema,
  GrowthClusterOutputSchema,
  RetagCrosswalkEntrySchema,
  RetagRowSchema,
  RetagPlanInputSchema,
  RetagResolvedEntrySchema,
  RetagChangeSchema,
  RetagPlanOutputSchema,
} from "./skills";
export type {
  SkillCanonicalizationInput,
  SkillCanonicalization,
  SkillAliasEmbedItem,
  SkillAliasEmbedInput,
  SkillAliasEmbedResult,
  SkillAliasEmbedOutput,
  GrowthPhrase,
  GrowthAnchor,
  GrowthClusterInput,
  GrowthProposal,
  GrowthClusterOutput,
  RetagCrosswalkEntry,
  RetagRow,
  RetagPlanInput,
  RetagResolvedEntry,
  RetagChange,
  RetagPlanOutput,
} from "./skills";

export { TranscriptionInputSchema, TranscriptionOutputSchema } from "./voice";
export type { TranscriptionInput, TranscriptionOutput } from "./voice";

// Occupation Intelligence Engine (Phase 0 contract freeze). NOTE:
// `PredicateObjectShapeForParity` is deliberately NOT exported — it exists for the
// parity test only, because `z.lazy` has no `.shape`.
export {
  PROFILING_PHASES,
  OCCUPATION_MATCH_LAYERS,
  OCCUPATION_MATCH_STATUSES,
  ANSWER_STATUSES,
  PREDICATE_OPS,
  QUESTION_TARGET_KINDS,
  ANSWER_TYPES,
  QUESTION_PACK_STATUSES,
  PARSE_NORMALIZATIONS,
  EvidenceSpanSchema,
  AnswerRecordHistoryEntrySchema,
  AnswerRecordSchema,
  OccupationPinSchema,
  PredicateOperandSchema,
  PredicateSchema,
  QuestionPackOptionSchema,
  QuestionPackItemSchema,
  QuestionPackSchema,
  TranscriptLineSchema,
  TargetFieldSchema,
  ProfileParseInputSchema,
  ParsedFieldSchema,
  ProfileParseOutputSchema,
  ExperienceEntrySchema,
  LlmInterviewDraftSchema,
  LlmTurnInputSchema,
  LlmTurnOutputSchema,
  InterviewExtractInputSchema,
  InterviewExtractOutputSchema,
  WorkHistoryPolishInputSchema,
  WorkHistoryPolishOutputSchema,
  LLM_INTERVIEW_STAGES,
  INPUT_MODES,
} from "./oie";
export type {
  ProfilingPhase,
  ExperienceEntry,
  LlmInterviewStage,
  InputMode,
  LlmInterviewDraft,
  LlmTurnInput,
  LlmTurnOutput,
  InterviewExtractInput,
  InterviewExtractOutput,
  WorkHistoryPolishInput,
  WorkHistoryPolishOutput,
  OccupationMatchLayer,
  OccupationMatchStatus,
  AnswerStatus,
  PredicateOp,
  QuestionTargetKind,
  AnswerType,
  QuestionPackStatus,
  ParseNormalization,
  EvidenceSpan,
  AnswerRecordHistoryEntry,
  AnswerRecord,
  OccupationPin,
  PredicateOperand,
  Predicate,
  QuestionPackOption,
  QuestionPackItem,
  QuestionPack,
  TranscriptLine,
  TargetField,
  ProfileParseInput,
  ParsedField,
  ProfileParseOutput,
} from "./oie";
