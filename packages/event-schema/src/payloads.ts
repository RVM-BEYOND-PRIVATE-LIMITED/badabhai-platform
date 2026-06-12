import { z } from "zod";
import { uuidSchema, isoDateTimeSchema } from "./envelope";

/**
 * Event payloads.
 *
 * PRIVACY RULES (enforced by convention + review):
 * - Payloads carry IDs and HASHES, never raw PII.
 * - Never put raw phone, full name, address, employer name, or ID-doc tokens
 *   in a payload. Use `*_hash` or opaque IDs instead.
 * - Free-text fields are limited to non-PII signals (counts, statuses, lengths).
 */

const phoneHash = z.string().min(1).max(128);

// ---------------------------------------------------------------------------
// worker.*
// ---------------------------------------------------------------------------
export const WorkerCreatedPayload = z.object({
  worker_id: uuidSchema,
  phone_hash: phoneHash,
  status: z.enum(["pending", "active", "suspended"]).default("pending"),
});

export const WorkerOtpRequestedPayload = z.object({
  phone_hash: phoneHash,
  channel: z.enum(["sms", "whatsapp"]).default("sms"),
});

export const WorkerOtpVerifiedPayload = z.object({
  worker_id: uuidSchema,
  phone_hash: phoneHash,
  is_new_worker: z.boolean(),
});

// The worker recorded their real name. PII-free: the name itself is encrypted at
// rest in workers.full_name and NEVER appears here — only the fact that it was set.
export const WorkerNameRecordedPayload = z.object({
  worker_id: uuidSchema,
});

// ---------------------------------------------------------------------------
// consent.*
// ---------------------------------------------------------------------------
export const ConsentAcceptedPayload = z.object({
  worker_id: uuidSchema,
  consent_id: uuidSchema,
  consent_version: z.string().min(1).max(32),
  purposes: z.array(z.string().min(1).max(64)).min(1),
  accepted_at: isoDateTimeSchema,
});

// ---------------------------------------------------------------------------
// chat.*
// ---------------------------------------------------------------------------
const messageType = z.enum(["text", "voice", "system"]);

export const ChatSessionStartedPayload = z.object({
  session_id: uuidSchema,
  worker_id: uuidSchema,
});

export const ChatMessageReceivedPayload = z.object({
  session_id: uuidSchema,
  worker_id: uuidSchema,
  message_id: uuidSchema,
  message_type: messageType,
  has_voice_note: z.boolean().default(false),
});

export const ChatMessageSentPayload = z.object({
  session_id: uuidSchema,
  worker_id: uuidSchema,
  message_id: uuidSchema,
  message_type: messageType,
});

// ---------------------------------------------------------------------------
// voice_note.*
// ---------------------------------------------------------------------------
/** Max voice-note duration is 120 seconds in Phase 1. */
export const MAX_VOICE_NOTE_SECONDS = 120;
const voiceDuration = z.number().positive().max(MAX_VOICE_NOTE_SECONDS);

export const VoiceNoteUploadedPayload = z.object({
  voice_note_id: uuidSchema,
  worker_id: uuidSchema,
  session_id: uuidSchema,
  duration_seconds: voiceDuration,
  storage_path: z.string().min(1).max(512),
});

export const VoiceNoteTranscriptionRequestedPayload = z.object({
  voice_note_id: uuidSchema,
  worker_id: uuidSchema,
  ai_job_id: uuidSchema,
});

export const VoiceNoteTranscriptionCompletedPayload = z.object({
  voice_note_id: uuidSchema,
  worker_id: uuidSchema,
  ai_job_id: uuidSchema,
  transcript_confidence: z.number().min(0).max(1).nullable().default(null),
  transcript_length: z.number().int().nonnegative().nullable().default(null),
});

/** Terminal failure of an async transcription job (mirrors profile.extraction_failed). */
export const VoiceNoteTranscriptionFailedPayload = z.object({
  voice_note_id: uuidSchema,
  worker_id: uuidSchema,
  ai_job_id: uuidSchema,
  reason: z.string().min(1).max(256),
});

// ---------------------------------------------------------------------------
// profile.*
// ---------------------------------------------------------------------------
const profileStatus = z.enum(["draft", "extracting", "extracted", "confirmed"]);

export const ProfileExtractionRequestedPayload = z.object({
  worker_id: uuidSchema,
  session_id: uuidSchema.nullable().default(null),
  ai_job_id: uuidSchema,
});

export const ProfileExtractionCompletedPayload = z.object({
  worker_id: uuidSchema,
  profile_id: uuidSchema,
  ai_job_id: uuidSchema,
  profile_status: profileStatus,
  field_count: z.number().int().nonnegative().default(0),
});

export const ProfileConfirmedPayload = z.object({
  worker_id: uuidSchema,
  profile_id: uuidSchema,
  confirmed_at: isoDateTimeSchema,
});

/** Terminal failure of an async (BullMQ) extraction job — keeps failures in the stream. */
export const ProfileExtractionFailedPayload = z.object({
  worker_id: uuidSchema,
  session_id: uuidSchema.nullable().default(null),
  ai_job_id: uuidSchema,
  reason: z.string().min(1).max(256),
});

/**
 * The stateful interview has collected enough to extract a profile — emitted by
 * the chat turn when the engine flips `extraction_ready`. Lets the backend gate
 * extraction on a worker signal rather than guessing. PII-free: ids, the
 * role-family slug, interview topic ids, and counts only.
 */
export const ProfileExtractionReadyPayload = z.object({
  worker_id: uuidSchema,
  session_id: uuidSchema.nullable().default(null),
  role_family: z.string().min(1).max(64).default("cnc_vmc"),
  turn_count: z.number().int().nonnegative().default(0),
  /** Interview topic ids answered so far (e.g. "role", "machines") — never PII. */
  answered_topics: z.array(z.string().min(1).max(40)).max(50).default([]),
});

// ---------------------------------------------------------------------------
// action.* — worker-side behavioural actions (the Learn-layer event stream).
//
// Generic, extensible recorder: one event name carries a controlled
// `action_type` so new actions are a DATA change (extend ACTION_TYPES), never a
// schema rebuild — matching the "taxonomy as data" mandate. PRIVACY: payloads
// carry ids/enums/short non-PII signals only; the API boundary rejects raw PII.
// NOTE: employer/match feedback signals (shortlist/reject/hire/no-show) are NOT
// here — that learning loop is deferred with matching.
// ---------------------------------------------------------------------------
export const ACTION_TYPES = [
  "profile_reviewed", // worker reviewed the extracted profile before confirming (BR-W-05)
  "profile_edited", // worker corrected/edited a profile field (BR-W-09)
  "profile_enriched", // worker added/enriched profile detail when prompted
  "resume_viewed", // worker opened the generated resume
  "resume_downloaded", // worker downloaded the resume PDF (BR-W-04)
  "resume_shared", // worker shared the resume
  "voice_note_played", // worker played back a voice note
  "onboarding_step_completed", // worker finished an onboarding step (offline-tolerant resume)
  "app_opened", // engagement signal
  "language_changed", // worker switched preferred language
] as const;
export const ActionType = z.enum(ACTION_TYPES);
export type ActionType = z.infer<typeof ActionType>;

/** What the action was about (the worker is always the actor + subject). */
export const ACTION_TARGET_TYPES = [
  "profile",
  "resume",
  "voice_note",
  "chat_session",
  "onboarding",
  "app",
  "language",
] as const;
export const ActionTargetType = z.enum(ACTION_TARGET_TYPES);
export type ActionTargetType = z.infer<typeof ActionTargetType>;

/** Where the action originated. */
export const ACTION_SOURCE_SURFACES = ["worker_app", "ops_console", "system"] as const;
export const ActionSourceSurface = z.enum(ACTION_SOURCE_SURFACES);

/**
 * Bounded, non-PII context bag. Values are primitives only and strings are
 * short — this keeps the behavioural stream cheap and makes it hard to smuggle
 * PII through. The API also rejects phone/email-like strings at capture time.
 */
const actionContextValue = z.union([z.string().max(120), z.number(), z.boolean()]);
export const ActionContextSchema = z
  .record(z.string().min(1).max(40), actionContextValue)
  .refine((o) => Object.keys(o).length <= 20, { message: "context may have at most 20 keys" });

export const ActionRecordedPayload = z.object({
  worker_id: uuidSchema,
  action_type: ActionType,
  target_type: ActionTargetType.nullable().default(null),
  target_id: uuidSchema.nullable().default(null),
  /** Client-reported time the action happened (supports offline batch flush). */
  client_occurred_at: isoDateTimeSchema.nullable().default(null),
  source_surface: ActionSourceSurface.default("worker_app"),
  context: ActionContextSchema.default({}),
});

// ---------------------------------------------------------------------------
// resume.*
// ---------------------------------------------------------------------------
export const ResumeGeneratedPayload = z.object({
  worker_id: uuidSchema,
  profile_id: uuidSchema,
  resume_id: uuidSchema,
  version: z.number().int().positive().default(1),
  format: z.enum(["text", "json"]).default("text"),
});

// ---------------------------------------------------------------------------
// ai.* (privacy + LLM lifecycle)
// ---------------------------------------------------------------------------
const requestId = z.string().min(1).max(128);

export const AiPseudonymizationStartedPayload = z.object({
  request_id: requestId,
  ai_job_id: uuidSchema.nullable().default(null),
  input_length: z.number().int().nonnegative().default(0),
});

export const AiPseudonymizationCompletedPayload = z.object({
  request_id: requestId,
  replaced_entities: z.number().int().nonnegative().default(0),
  blocked: z.boolean().default(false),
});

export const AiPseudonymizationFailedPayload = z.object({
  request_id: requestId,
  reason: z.string().min(1).max(256),
  /** A failed pseudonymization MUST result in a blocked LLM path (fail closed). */
  blocked: z.literal(true),
});

export const AiLlmCallRequestedPayload = z.object({
  request_id: requestId,
  model: z.string().min(1).max(128),
  purpose: z.enum(["profiling_respond", "profile_extract", "resume_generate"]),
});

export const AiLlmCallCompletedPayload = z.object({
  request_id: requestId,
  model: z.string().min(1).max(128),
  latency_ms: z.number().int().nonnegative().nullable().default(null),
  tokens_in: z.number().int().nonnegative().nullable().default(null),
  tokens_out: z.number().int().nonnegative().nullable().default(null),
});

export const AiLlmCallFailedPayload = z.object({
  request_id: requestId,
  model: z.string().min(1).max(128).nullable().default(null),
  error: z.string().min(1).max(512),
});

/** AI task the router executed. Mirrors `TaskType` in app/ai/model_config.py. */
const aiTaskType = z.enum(["profiling_chat_turn", "profile_extraction", "resume_generation"]);

/** Async AI job type. Mirrors `AI_JOB_TYPES` in @badabhai/types. */
const aiJobType = z.enum([
  "pseudonymization",
  "transcription",
  "profile_extraction",
  "resume_generation",
]);

/**
 * Cost + token accounting for one AI call (mirrors the AI service's
 * AICallMetadata). This is the cost/spend spine — guardrail flags travel with
 * it. PII-free by construction: ids, model name, token counts, INR estimate.
 */
export const AiCostRecordedPayload = z.object({
  ai_call_id: uuidSchema,
  request_id: requestId.nullable().default(null),
  ai_job_id: uuidSchema.nullable().default(null),
  task_type: aiTaskType,
  model: z.string().min(1).max(128),
  provider: z.string().min(1).max(64),
  real_call: z.boolean().default(false),
  tokens_in: z.number().int().nonnegative().default(0),
  tokens_out: z.number().int().nonnegative().default(0),
  estimated_cost_inr: z.number().nonnegative().default(0),
  latency_ms: z.number().int().nonnegative().default(0),
  cost_alert: z.boolean().default(false),
  above_target: z.boolean().default(false),
});

/**
 * An async AI job (an `ai_jobs` row) completed successfully — lets the BullMQ
 * extraction/transcription path keep its lifecycle in the event spine.
 * (Failures use the domain-specific `*_failed` events.)
 */
export const AiJobCompletedPayload = z.object({
  ai_job_id: uuidSchema,
  job_type: aiJobType,
  worker_id: uuidSchema.nullable().default(null),
  /** The entity the job produced (e.g. profile_id / resume_id), if any. */
  result_id: uuidSchema.nullable().default(null),
  latency_ms: z.number().int().nonnegative().nullable().default(null),
});

// ---------------------------------------------------------------------------
// feed.* / application.* — Reach foundation behavioural record (ADR-0005, TD8).
//
// The worker-side signals the matching/LEARN layer reads: which jobs a worker was
// SHOWN (and at what rank/score), which they APPLY to, and which they SKIP. Defined
// now; emitted when the Phase-2 feed surface ships. PII-free: worker_id + an opaque
// job_id + ranking signals only — never employer name, pay, or worker contact.
// ---------------------------------------------------------------------------

/** A job was surfaced to a worker in their feed (one impression). */
export const FeedShownPayload = z.object({
  worker_id: uuidSchema,
  job_id: uuidSchema,
  /** 1-based position in the worker's feed. */
  rank: z.number().int().positive(),
  /** Relevance score the engine assigned (0..1). */
  score: z.number().min(0).max(1).default(0),
  /** Whether it wore the "hot" tag for this worker. */
  hot: z.boolean().default(false),
});

/** A worker applied to a job (a tap or a voice note). */
export const ApplicationSubmittedPayload = z.object({
  worker_id: uuidSchema,
  job_id: uuidSchema,
  /** The feed position it was applied from, if known. */
  rank: z.number().int().positive().nullable().default(null),
  source_surface: z.enum(["feed", "search", "share", "other"]).default("feed"),
});

/** A worker skipped/dismissed a job shown in their feed. */
export const ApplicationSkippedPayload = z.object({
  worker_id: uuidSchema,
  job_id: uuidSchema,
  /** Coarse, non-PII reason (no free text). */
  reason: z.enum(["not_interested", "too_far", "low_pay", "wrong_trade", "other"]).default("other"),
});
