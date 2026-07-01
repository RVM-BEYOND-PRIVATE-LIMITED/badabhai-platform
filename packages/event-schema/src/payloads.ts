import { z } from "zod";
import { VACANCY_BANDS, JOB_POSTING_STATUSES } from "@badabhai/types";
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

// ADR-0026 Phase 1 — opaque rotating refresh token reuse detection. A previously
// USED refresh token was replayed (token theft / a leaked token re-presented) ⇒ the
// whole token FAMILY is revoked and the worker is forced back to OTP. PII-FREE: the
// opaque worker id + the opaque family id (a UUID lineage handle) ONLY — the refresh
// TOKEN VALUE (and its sha256) is NEVER carried (CLAUDE.md invariant #2; mirrors the
// OTP HMAC rule). No phone, no token, no session-secret.
export const WorkerRefreshReuseDetectedPayload = z.object({
  worker_id: uuidSchema,
  family_id: uuidSchema,
});

// ADR-0026 Phase 1 — the worker revoked every active session (logout-all). PII-FREE:
// the opaque worker id + the non-negative count of sessions revoked ONLY. No session
// ids, no tokens, no phone.
export const WorkerLoggedOutAllPayload = z.object({
  worker_id: uuidSchema,
  sessions_revoked: z.number().int().nonnegative(),
});

// ADR-0026 Phase 2 — trusted-device binding. A device was registered on a fresh OTP
// login / revoked from the device list. PII-FREE: the opaque worker id + the device ROW
// uuid (`worker_devices.id`) ONLY. The `device_hash` (keyed HMAC of the client device
// id), the raw client device id, the `push_token`, and platform/model/app_version —
// NONE appear here (CLAUDE.md invariant #2; mirrors how the events above carry the
// family/session uuid, never the token value). The device row uuid is an opaque handle.
export const WorkerDeviceRegisteredPayload = z.object({
  worker_id: uuidSchema,
  device_id: uuidSchema,
});

export const WorkerDeviceRevokedPayload = z.object({
  worker_id: uuidSchema,
  device_id: uuidSchema,
});

// ADR-0026 Phase 5 — DPDP worker-initiated account deletion. The worker's identity row
// (and every PII-bearing child) has been hard-erased; the billing/intent rows survive with
// their identity join nulled (D3). PII-FREE: the now-erased worker's opaque id + non-negative
// COUNTS/FLAGS only — sessions/devices revoked, storage objects deleted/failed, and whether a
// PIN existed. The phone, phone_hash, name, device hash, resume object keys, and the OTP code
// NEVER appear here (CLAUDE.md invariant #2; "record the fact + counts, never the value"). This
// event is the DURABLE record of the deletion — the worker row itself is gone.
export const WorkerAccountDeletedPayload = z
  .object({
    worker_id: uuidSchema,
    sessions_revoked: z.number().int().nonnegative(),
    devices_revoked: z.number().int().nonnegative(),
    storage_objects_deleted: z.number().int().nonnegative(),
    storage_objects_failed: z.number().int().nonnegative(),
    had_pin: z.boolean(),
  })
  .strict();

// ---------------------------------------------------------------------------
// worker.pin_* — device-bound unlock PIN (ADR-0026 Phase 3).
//
// The PIN NEVER authenticates from scratch — a correct PIN only unlocks an already
// device-bound session. These record the PIN lifecycle (set / verified / verify-failed /
// locked / reset) for the audit spine — the PIN sibling of the `worker.device_*` events.
//
// PII-FREE BY CONSTRUCTION (CLAUDE.md invariant #2): the raw PIN, the `pin_hash`, the
// throttle state, the raw client device id / device fingerprint, and the phone NEVER
// appear here. The ONLY fields are the opaque worker id, the opaque device ROW uuid
// (`worker_devices.id`, same handle the `device_*` events carry), and bounded ints/bools
// for the lockout escalation. `.strict()` STRUCTURALLY rejects any extra (potentially
// PII-shaped) key at validation time — a careless caller cannot smuggle a value onto the
// spine. All v1 (version-never-mutate).
// ---------------------------------------------------------------------------

/** A worker set (or replaced) their device-unlock PIN. The opaque worker id ONLY —
 * never the PIN, the pin_hash, or any throttle/device value. `.strict()` backstop. */
export const WorkerPinSetPayload = z
  .object({
    worker_id: uuidSchema,
  })
  .strict();
export type WorkerPinSetPayload = z.infer<typeof WorkerPinSetPayload>;

/** A device-bound PIN was verified successfully (a fresh session was minted). The opaque
 * worker id + the device ROW uuid the PIN rode ONLY — never the PIN or any secret. */
export const WorkerPinVerifiedPayload = z
  .object({
    worker_id: uuidSchema,
    device_id: uuidSchema,
  })
  .strict();
export type WorkerPinVerifiedPayload = z.infer<typeof WorkerPinVerifiedPayload>;

/** A device-bound PIN verify FAILED (wrong PIN / locked / untrusted-device / invalidated
 * — the client sees ONE neutral 401; ops gets this distinct PII-free fact). The opaque
 * worker id + the device ROW uuid ONLY — never the submitted PIN or a reason value. */
export const WorkerPinVerifyFailedPayload = z
  .object({
    worker_id: uuidSchema,
    device_id: uuidSchema,
  })
  .strict();
export type WorkerPinVerifyFailedPayload = z.infer<typeof WorkerPinVerifyFailedPayload>;

/** A PIN lockout escalation step fired: the transient lockout cycle bumped, and when it
 * reaches the configured K cycles `force_otp` is true (the PIN is durably invalidated until
 * an OTP-gated reset). Opaque worker id + device ROW uuid + the integer cycle + the boolean
 * ONLY — never the PIN, the hash, or any throttle timestamp. */
export const WorkerPinLockedPayload = z
  .object({
    worker_id: uuidSchema,
    device_id: uuidSchema,
    lockout_cycle: z.number().int().nonnegative(),
    force_otp: z.boolean().default(false),
  })
  .strict();
export type WorkerPinLockedPayload = z.infer<typeof WorkerPinLockedPayload>;

/** A worker reset their PIN through the OTP-gated reset flow (a new PIN was set, clearing
 * the throttle + force-OTP state). The opaque worker id ONLY — never the new PIN, the old
 * hash, the OTP, or the phone. `.strict()` backstop. */
export const WorkerPinResetPayload = z
  .object({
    worker_id: uuidSchema,
  })
  .strict();
export type WorkerPinResetPayload = z.infer<typeof WorkerPinResetPayload>;

// ---------------------------------------------------------------------------
// *.otp_send_cap_exceeded — OTP-5 global daily send circuit-breaker (the SPEND
// ceiling) breach, on BOTH the worker SMS and payer email real-send paths.
//
// AGGREGATE / PII-FREE BY CONSTRUCTION: this records the FACT that the platform-wide
// daily REAL-send breaker tripped — it carries NO worker/payer identity, NO phone,
// NO email, NO raw IP, NO code, NO hash of any of those (CLAUDE.md invariant #2). The
// ONLY fields are the channel KIND enum, the cap KIND literal, the integer limit, and
// the UTC-day string the breach happened on. There is deliberately NO id field that
// could carry an account handle — exactly the "record the fact, not the value" rule.
// Emitted ONCE per breach, in addition to (never instead of) the neutral throttle
// response the caller already returns — so ops can alert on the spend ceiling without
// parsing any per-account data. `worker.otp_send_cap_exceeded` (channel "worker_sms")
// and `payer.otp_send_cap_exceeded` (channel "payer_email") share this exact shape.
// ---------------------------------------------------------------------------

/** Which real-send path the global breaker tripped on. Enum-only → no PII. */
export const OTP_SEND_CAP_CHANNELS = ["worker_sms", "payer_email"] as const;
export const OtpSendCapChannel = z.enum(OTP_SEND_CAP_CHANNELS);
export type OtpSendCapChannel = z.infer<typeof OtpSendCapChannel>;

/** The aggregate, PII-free breach payload (worker + payer share this shape). */
const otpSendCapExceededShape = {
  channel: OtpSendCapChannel,
  // Pinned literal — there is exactly one cap kind (the global daily ceiling). Keeping
  // it a literal (not free text) STRUCTURALLY guarantees no PII can be smuggled here.
  cap: z.literal("global_daily"),
  /** The configured limit the breach was measured against (0 = paused = kill-switch). */
  limit: z.number().int().nonnegative(),
  /** The UTC-day window the breach happened on (`YYYYMMDD`) — never a timestamp/PII. */
  window: z
    .string()
    .regex(/^\d{8}$/, "window must be a UTC-day stamp YYYYMMDD"),
} as const;

export const WorkerOtpSendCapExceededPayload = z.object(otpSendCapExceededShape);
export type WorkerOtpSendCapExceededPayload = z.infer<typeof WorkerOtpSendCapExceededPayload>;

export const PayerOtpSendCapExceededPayload = z.object(otpSendCapExceededShape);
export type PayerOtpSendCapExceededPayload = z.infer<typeof PayerOtpSendCapExceededPayload>;

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
  // COUNT only of the derived English translation — never the text itself (raw
  // worker PII lives only on the voice_notes row). Nullable/defaulted → additive
  // and backward compatible with already-emitted v1 events.
  transcript_english_length: z.number().int().nonnegative().nullable().default(null),
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

/** A worker downloaded a resume (the PDF, or the raw text/json). IDs + enum only. */
export const ResumeDownloadedPayload = z.object({
  worker_id: uuidSchema,
  resume_id: uuidSchema,
  version: z.number().int().positive().default(1),
  format: z.enum(["pdf", "text", "json"]).default("pdf"),
});

/** A newer resume version was generated for a worker (re-run as the profile grows). */
export const ResumeRegeneratedPayload = z.object({
  worker_id: uuidSchema,
  profile_id: uuidSchema,
  resume_id: uuidSchema,
  version: z.number().int().positive().default(1),
  previous_version: z.number().int().positive().nullable().default(null),
  format: z.enum(["text", "json"]).default("text"),
});

/** A worker shared a resume. `channel` is an enum (no free text → no PII / no link leakage). */
export const ResumeSharedPayload = z.object({
  worker_id: uuidSchema,
  resume_id: uuidSchema,
  version: z.number().int().positive().default(1),
  channel: z.enum(["whatsapp", "link", "download", "other"]).default("link"),
});

// ---------------------------------------------------------------------------
// interview_kit.* (per-trade preparation kit — deterministic, render-once)
//
// PII-FREE BY CONSTRUCTION: kits are per-TRADE, not per-worker. Payloads carry a
// trade slug, the content version, and the deterministic kit id only — never a
// worker id, name, or any free text.
// ---------------------------------------------------------------------------
/** Trade slug, e.g. "cnc_operator". Lowercase letters/digits/underscores only. */
const tradeKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+$/, "trade_key must be a lowercase slug ([a-z0-9_])");
/** Deterministic kit id `{tradeKey}:v{contentVersion}` — the render-once identity. */
const kitIdSchema = z.string().min(1).max(96);
const contentVersionSchema = z.number().int().positive().default(1);

/** A per-trade kit PDF was rendered for the first time (and stored privately). */
export const InterviewKitRenderCompletedPayload = z.object({
  trade_key: tradeKeySchema,
  content_version: contentVersionSchema,
  kit_id: kitIdSchema,
});

/** A per-trade kit render attempt failed. `reason` is a short, PII-free code/phrase. */
export const InterviewKitRenderFailedPayload = z.object({
  trade_key: tradeKeySchema,
  content_version: contentVersionSchema,
  reason: z.string().min(1).max(256),
});

/** A kit was served/downloaded. `cache_hit` distinguishes a reuse from a first render. */
export const InterviewKitDownloadedPayload = z.object({
  trade_key: tradeKeySchema,
  content_version: contentVersionSchema,
  kit_id: kitIdSchema,
  source: z.enum(["worker_app", "web", "ops", "other"]).default("worker_app"),
  cache_hit: z.boolean().default(true),
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
 * Spend-cap / circuit-breaker block codes — the terminal `error_code` values the
 * AI gateway returns when it REFUSES a real provider call (TD27). Mirrors the
 * block reasons set in apps/ai-service. Enum-only (no free text) → no PII.
 */
export const AI_SPEND_CAP_REASONS = [
  "daily_cap_exceeded",
  "cumulative_cap_exceeded",
  "user_daily_cap_exceeded",
  "kill_switch_engaged",
  "retry_budget_exhausted",
  "cost_ceiling_exceeded",
] as const;
export const AiSpendCapReason = z.enum(AI_SPEND_CAP_REASONS);
export type AiSpendCapReason = z.infer<typeof AiSpendCapReason>;

/**
 * The AI gateway BLOCKED a real provider call because a spend cap / circuit
 * breaker tripped (TD27). Emitted in addition to `ai.cost_recorded` (which is
 * left UNCHANGED) so ops can alert on caps without parsing cost rows. PII-free by
 * construction: ids, model/provider names, the block reason enum, and flags only
 * — never prompts, completions, transcripts, names, or phone numbers.
 */
export const AiSpendCapExceededPayload = z.object({
  ai_call_id: uuidSchema,
  request_id: requestId.nullable().default(null),
  ai_job_id: uuidSchema.nullable().default(null),
  task_type: aiTaskType,
  model: z.string().min(1).max(128),
  provider: z.string().min(1).max(64),
  reason: AiSpendCapReason,
  real_call: z.boolean().default(false),
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

// ---------------------------------------------------------------------------
// job_posting.* — ops-created, vacancy-banded, stored-only job postings (ADR-0012).
//
// PII-FREE BY CONSTRUCTION: these record the FACT of a posting's lifecycle, never
// its values. The org label, role title, location label, and description live ONLY
// on the job_postings row and NEVER appear in a payload. Fields here are ids,
// enums (vacancy band / status), booleans, and field-KEY arrays only — exactly the
// "record the fact, not the value" convention used by the events above.
//
// VACANCY_BANDS / JOB_POSTING_STATUSES are the single source of truth in
// @badabhai/types (mirrored by the job_postings table) — reused, never re-declared.
// ---------------------------------------------------------------------------
const vacancyBand = z.enum(VACANCY_BANDS);
const jobPostingStatus = z.enum(JOB_POSTING_STATUSES);

// The only field KEYS an update may report as changed. Pinned as an enum (not a
// free `z.string()`) so the registry STRUCTURALLY guarantees changed_fields can
// never carry a free-text value — defense-in-depth on the §2.2 PII boundary.
const JOB_POSTING_CHANGED_FIELDS = [
  "org_label",
  "role_title",
  "location_label",
  "description",
  "vacancy_band",
  "status",
] as const;

/**
 * An ops user created a job posting. Carries the opaque posting id, the creator's
 * id, the (banded) vacancy, the created status, and booleans for whether optional
 * location/description were provided — NO free text (org_label/role_title/
 * location_label/description never appear).
 */
export const JobPostingCreatedPayload = z.object({
  job_posting_id: uuidSchema,
  vacancy_band: vacancyBand,
  status: jobPostingStatus,
  created_by: uuidSchema,
  has_location: z.boolean(),
  has_description: z.boolean(),
});
export type JobPostingCreatedPayload = z.infer<typeof JobPostingCreatedPayload>;

/**
 * An ops user updated a job posting. `changed_fields` is the list of field KEYS
 * that changed (e.g. "role_title", "vacancy_band") — KEYS ONLY, never the values
 * (so no org/role/location/description text ever leaks). `vacancy_band` is the
 * post-update band if it changed, else null.
 */
export const JobPostingUpdatedPayload = z.object({
  job_posting_id: uuidSchema,
  changed_fields: z.array(z.enum(JOB_POSTING_CHANGED_FIELDS)).max(JOB_POSTING_CHANGED_FIELDS.length),
  status: jobPostingStatus,
  vacancy_band: vacancyBand.nullable(),
});
export type JobPostingUpdatedPayload = z.infer<typeof JobPostingUpdatedPayload>;

/**
 * An ops user closed a job posting. Records the transition only: the previous
 * (open/draft) status and the terminal "closed" status. PII-free (id + enums).
 */
export const JobPostingClosedPayload = z.object({
  job_posting_id: uuidSchema,
  previous_status: z.enum(["draft", "open"]),
  status: z.literal("closed"),
});
export type JobPostingClosedPayload = z.infer<typeof JobPostingClosedPayload>;

/**
 * A payer PAUSED a live (open) job posting (B1). Records the transition only — PII-free
 * (id + enums). A paused posting is excluded from any open-filtered feed until resumed.
 */
export const JobPostingPausedPayload = z.object({
  job_posting_id: uuidSchema,
  previous_status: z.literal("open"),
  status: z.literal("paused"),
});
export type JobPostingPausedPayload = z.infer<typeof JobPostingPausedPayload>;

/** A payer RESUMED a paused job posting back to open (B1). PII-free (id + enums). */
export const JobPostingResumedPayload = z.object({
  job_posting_id: uuidSchema,
  previous_status: z.literal("paused"),
  status: z.literal("open"),
});
export type JobPostingResumedPayload = z.infer<typeof JobPostingResumedPayload>;
// unlock.* / contact.* / payment.* — Contact Unlock + Reveal (ADR-0010, Stream A).
//
// The single highest-risk PII path in the product — and therefore the family with
// the STRICTEST privacy contract: every payload below carries IDS + ENUMS + COUNTS
// ONLY. The revealed phone / proxy number / relay destination / routing token NEVER
// appears in ANY payload, ever (CLAUDE.md invariant 2; ADR-0010 §6.2; threat-model
// T1/F-5). The only identity reference is `worker_id`/`payer_id` — opaque UUIDs.
// `payer_id` is the "faceless-rails" opaque payer ref (employer OR agent), NEVER an
// employer name. `contact.revealed.channel` is the channel KIND only — never the
// destination. Every reason is an ENUM (no free text), exactly like
// `application.skipped.reason`. Alpha is mock credits → `payment.*.real_call` is the
// honest `false` (mirrors `AiCostRecordedPayload.real_call`).
// ---------------------------------------------------------------------------

/**
 * INTERNAL-ONLY deny reason (ADR-0010 §D4/§6.2 no-oracle rule). It is recorded on
 * the `unlock.denied` audit event for ops, but it is NEVER echoed to the payer (the
 * payer only ever sees a byte-identical neutral response — F-3). Enum-only → no PII.
 */
export const UNLOCK_DENY_REASONS = [
  "no_consent",
  "capped",
  "payment_required",
  "unknown_worker",
] as const;
export const UnlockDenyReasonEnum = z.enum(UNLOCK_DENY_REASONS);
export type UnlockDenyReasonEnum = z.infer<typeof UnlockDenyReasonEnum>;

/** Which worker-protection cap was exceeded (ADR-0010 §D4). Enum-only → no PII. */
export const UNLOCK_CAP_KINDS = ["daily_reveals", "weekly_payers", "attempts_per_unlock"] as const;
export const UnlockCapKind = z.enum(UNLOCK_CAP_KINDS);
export type UnlockCapKind = z.infer<typeof UnlockCapKind>;

/** The window the exceeded cap is measured over (ADR-0010 §D4). Enum-only → no PII. */
export const UNLOCK_CAP_WINDOWS = ["day", "week", "unlock"] as const;
export const UnlockCapWindow = z.enum(UNLOCK_CAP_WINDOWS);
export type UnlockCapWindow = z.infer<typeof UnlockCapWindow>;

/**
 * The routed-channel KIND (ADR-0010 §D2). Alpha ships `in_app_relay` only (discloses
 * NO number). `proxy_number` is the production human-gated channel. KIND ONLY — the
 * number / handle / destination NEVER travels in `contact.revealed` (F-5).
 */
export const UNLOCK_ROUTING_CHANNELS = ["in_app_relay", "proxy_number"] as const;
export const UnlockRoutingChannel = z.enum(UNLOCK_ROUTING_CHANNELS);
export type UnlockRoutingChannel = z.infer<typeof UnlockRoutingChannel>;

/** Why a mock payment/credit step failed (ADR-0010 §6.2). Enum-only → no PII. */
export const PAYMENT_FAILURE_REASONS = ["insufficient_credits", "gateway_error"] as const;
export const PaymentFailureReason = z.enum(PAYMENT_FAILURE_REASONS);
export type PaymentFailureReason = z.infer<typeof PaymentFailureReason>;

/** A payer requested to unlock a worker's routed contact (logged at entry). */
export const UnlockRequestedPayload = z.object({
  unlock_id: uuidSchema,
  payer_id: uuidSchema,
  worker_id: uuidSchema,
  job_id: uuidSchema.nullable().default(null),
});

/** An unlock was granted — ids + the access-window expiry ONLY. */
export const UnlockGrantedPayload = z.object({
  unlock_id: uuidSchema,
  payer_id: uuidSchema,
  worker_id: uuidSchema,
  job_id: uuidSchema.nullable().default(null),
  expires_at: isoDateTimeSchema,
});

/**
 * An unlock attempt was denied — INTERNAL AUDIT ONLY. `reason` is the internal deny
 * enum (NEVER echoed to the payer; F-3). Ids + enum only.
 */
export const UnlockDeniedPayload = z.object({
  unlock_id: uuidSchema.nullable().default(null),
  payer_id: uuidSchema,
  worker_id: uuidSchema,
  job_id: uuidSchema.nullable().default(null),
  reason: UnlockDenyReasonEnum,
});

/** A worker-protection cap was exceeded — ids + which cap/window only. */
export const UnlockCapExceededPayload = z.object({
  payer_id: uuidSchema,
  worker_id: uuidSchema,
  cap: UnlockCapKind,
  window: UnlockCapWindow.default("day"),
});

/**
 * A routed contact was revealed — channel KIND + counts ONLY. The number / handle /
 * relay destination / routing token NEVER appears here (F-5, non-tradeable #2).
 */
export const ContactRevealedPayload = z.object({
  unlock_id: uuidSchema,
  payer_id: uuidSchema,
  worker_id: uuidSchema,
  channel: UnlockRoutingChannel.default("in_app_relay"),
  reveal_count: z.number().int().nonnegative().default(0),
});

/** A (mock) credit hold was authorized. `real_call:false` in alpha (mock honesty). */
export const PaymentAuthorizedPayload = z.object({
  unlock_id: uuidSchema.nullable().default(null),
  payer_id: uuidSchema,
  pack_code: z.string().min(1).max(64).nullable().default(null),
  amount_inr: z.number().int().nonnegative().nullable().default(null),
  amount_credits: z.number().int().nonnegative().default(0),
  real_call: z.boolean().default(false),
});

/** A (mock) credit movement was captured (ledger debit / pack purchase). */
export const PaymentCapturedPayload = z.object({
  unlock_id: uuidSchema.nullable().default(null),
  payer_id: uuidSchema,
  pack_code: z.string().min(1).max(64).nullable().default(null),
  amount_inr: z.number().int().nonnegative().nullable().default(null),
  amount_credits: z.number().int().nonnegative().default(0),
  real_call: z.boolean().default(false),
});

/** A (mock) payment/credit step failed — ids + enum reason only. */
export const PaymentFailedPayload = z.object({
  unlock_id: uuidSchema.nullable().default(null),
  payer_id: uuidSchema,
  reason: PaymentFailureReason,
  real_call: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
// Monetization + Pricing Engine (ADR-0013) — PII-FREE: ids + CODES + enums +
// integer ₹ amounts + counts ONLY. Never a payer name, a worker identity beyond
// the opaque `worker_id`/`payer_id` uuid, resume bytes, a download link, or
// old/new catalog VALUES (changed events carry field KEYS only).
// ---------------------------------------------------------------------------

/** Paid posting tier (catalog-resolved). */
const PostingTierEnum = z.enum(["standard", "pro"]);
/** Booster tier (single tier today; extensible via the catalog). */
const BoostTierEnum = z.enum(["all_candidates"]);
/** Which catalog entity a `pricing.changed` event is about. */
const PricingChangeTypeEnum = z.enum(["plan", "discount", "coupon"]);
/** Stable catalog product/tier/coupon code (lowercase machine code). */
const catalogCode = z.string().min(1).max(64);

/**
 * A payer bought a paid job-posting plan (ADR-0013 Decision B). Price/quota/window
 * are STAMPED from the pricing catalog at purchase (the row is the receipt). `real_call`
 * is the mock-honesty flag (false until a real gateway ships, human-gated).
 */
export const JobPostingPurchasedPayload = z.object({
  plan_id: uuidSchema,
  job_posting_id: uuidSchema,
  payer_id: uuidSchema,
  tier: PostingTierEnum,
  applicant_visibility_quota: z.number().int().positive(),
  validity_days: z.number().int().positive(),
  price_inr: z.number().int().nonnegative(),
  discount_inr: z.number().int().nonnegative().default(0),
  coupon_applied: z.boolean().default(false),
  real_call: z.boolean().default(false),
});

/** A payer bought a booster for a posting (ADR-0013 Decision B). Ids + amounts only. */
export const JobPostingBoostedPayload = z.object({
  boost_id: uuidSchema,
  job_posting_id: uuidSchema,
  payer_id: uuidSchema,
  tier: BoostTierEnum.default("all_candidates"),
  boost_days: z.number().int().positive(),
  price_inr: z.number().int().nonnegative(),
  real_call: z.boolean().default(false),
});

/**
 * A payer viewed an applicant against a posting plan's visibility quota (ADR-0013 B.3).
 * A quota-consuming FACELESS view — `worker_id` is the opaque candidate ref; NO name /
 * contact / resume appears here. PII disclosure (name/resume) is a separate event.
 */
export const ApplicantViewedPayload = z.object({
  plan_id: uuidSchema,
  job_posting_id: uuidSchema,
  payer_id: uuidSchema,
  worker_id: uuidSchema,
  viewed_count: z.number().int().nonnegative(),
  quota: z.number().int().positive(),
});

/**
 * A worker's resume was disclosed to a payer (ADR-0013 Decision C). Resume download is
 * FREE (no price) but is still a PII DISCLOSURE riding the ADR-0010 consent+caps spine —
 * this records ONLY THE FACT. The resume bytes, the worker's name, and the download link
 * NEVER appear here (`resume_ref` is an opaque pointer to `generated_resumes`).
 */
export const ResumeDisclosedPayload = z.object({
  disclosure_id: uuidSchema,
  payer_id: uuidSchema,
  worker_id: uuidSchema,
  job_posting_id: uuidSchema.nullable().default(null),
  resume_ref: uuidSchema.nullable().default(null),
});

/**
 * A coupon was redeemed at purchase (ADR-0013 Decision D). Code + amount + opaque payer
 * only — no coupon-holder identity beyond `payer_id`.
 */
export const CouponRedeemedPayload = z.object({
  coupon_code: catalogCode,
  payer_id: uuidSchema,
  product: catalogCode,
  tier: catalogCode,
  discount_inr: z.number().int().nonnegative(),
});

/**
 * Ops edited the pricing catalog (ADR-0013 Decision D, the config builder audit). Field
 * KEYS only — NEVER the old/new VALUES (mirrors `job_posting.updated`). `changed_by` is
 * the opaque ops actor.
 */
export const PricingChangedPayload = z.object({
  change_type: PricingChangeTypeEnum,
  entity_code: catalogCode,
  changed_fields: z.array(z.string().min(1).max(64)),
  changed_by: uuidSchema,
});

// ---------------------------------------------------------------------------
// Per-payer hiring capacity (ADR-0016) — PII-FREE & FACELESS: opaque `payer_id`,
// tier CODE, integer counts + ₹ ONLY. `real_call:false` in alpha (mock payments).
// `posting_plan.paused/resumed` carry ONLY ids + an enum reason — no quota/price/PII.
// ---------------------------------------------------------------------------

/** Why a posting plan was paused (ADR-0016 D3) — enum only, no free text. */
const PostingPlanPauseReasonEnum = z.enum(["capacity_exceeded"]);
/** Why a posting plan was resumed (ADR-0016) — enum only, no free text. */
const PostingPlanResumeReasonEnum = z.enum(["capacity_restored"]);

/**
 * A payer bought (or upgraded) their concurrent-active-vacancy ALLOWANCE (ADR-0016).
 * `max_active_vacancies` is the allowance the purchase set; `tier` is the catalog code.
 * FACELESS: `payer_id` is the only identity ref (opaque, no FK). `real_call` is the
 * mock-honesty flag (false until a real gateway ships, human-gated).
 */
export const CapacityPurchasedPayload = z.object({
  payer_id: uuidSchema,
  tier: catalogCode,
  max_active_vacancies: z.number().int().nonnegative(),
  price_inr: z.number().int().nonnegative(),
  real_call: z.boolean().default(false),
});

/**
 * A posting plan was PAUSED because its payer was over capacity (ADR-0016 D3). A paused
 * plan is NOT an active vacancy and does NOT serve. Ids + enum reason ONLY (no PII).
 */
export const PostingPlanPausedPayload = z.object({
  plan_id: uuidSchema,
  job_posting_id: uuidSchema,
  payer_id: uuidSchema,
  reason: PostingPlanPauseReasonEnum,
});

/**
 * A previously-paused posting plan was RESUMED to active because capacity freed up
 * (ADR-0016 — e.g. after a capacity upgrade). Ids + enum reason ONLY (no PII).
 */
export const PostingPlanResumedPayload = z.object({
  plan_id: uuidSchema,
  job_posting_id: uuidSchema,
  payer_id: uuidSchema,
  reason: PostingPlanResumeReasonEnum,
});

/**
 * A payer topped up a posting plan's applicant-visibility quota (B2) — a paid "view more →
 * pay more" refill resolved through the ONE pricing engine (ADR-0013). `quota_added` is the
 * catalog `additionalVisibilityQuota` granted; `quota_topup_total` is the plan's running
 * top-up total AFTER this purchase (the original `applicant_visibility_quota` receipt stays
 * immutable). FACELESS: opaque `payer_id`, tier CODE, integer ₹ + counts ONLY (no PII).
 * `real_call` is the mock-honesty flag (false until a real gateway ships, human-gated).
 */
export const PostingPlanQuotaToppedPayload = z.object({
  plan_id: uuidSchema,
  job_posting_id: uuidSchema,
  payer_id: uuidSchema,
  tier: catalogCode,
  quota_added: z.number().int().positive(),
  quota_topup_total: z.number().int().nonnegative(),
  price_inr: z.number().int().nonnegative(),
  discount_inr: z.number().int().nonnegative().default(0),
  coupon_applied: z.boolean().default(false),
  real_call: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
// WhatsApp invite funnel + re-engagement (ADR-0020). PII-FREE: ids + enums +
// the template id ONLY. The phone, the message body, and template VARIABLES
// NEVER appear in a payload — the phone touches the WhatsApp provider only, at
// send time (the SmsProvider rule). Mock provider in alpha (real_call:false).
// ---------------------------------------------------------------------------

/** The channel a message/invite is delivered over. Extensible; whatsapp in v1. */
export const MessageChannelEnum = z.enum(["whatsapp"]);

/** Why a send was suppressed BEFORE reaching the provider (no-PII, internal audit). */
export const MessagingSuppressReasonEnum = z.enum(["no_consent", "unknown_worker"]);

/** Why a send FAILED at/after the provider (no-PII). */
export const MessagingFailReasonEnum = z.enum(["provider_error", "real_send_blocked"]);

/** An inviter created a referral deep-link. inviter is an opaque worker id. */
export const InviteCreatedPayload = z.object({
  invite_id: uuidSchema,
  inviter_worker_id: uuidSchema,
  channel: MessageChannelEnum,
  campaign: z.string().min(1).max(64).optional(),
});

/** A referral deep-link was opened (attribution; PII-free — code resolved to ids). */
export const InviteClickedPayload = z.object({
  invite_id: uuidSchema,
  channel: MessageChannelEnum,
});

/** An invited person became a worker — the attribution link (both ids opaque). */
export const InviteAcceptedPayload = z.object({
  invite_id: uuidSchema,
  inviter_worker_id: uuidSchema,
  invited_worker_id: uuidSchema,
});

/** A re-engagement/invite message was REQUESTED (consent already checked upstream). */
export const MessagingRequestedPayload = z.object({
  message_id: uuidSchema,
  worker_id: uuidSchema,
  template: z.string().min(1).max(64), // a pre-approved template ID, NOT the body
  channel: MessageChannelEnum,
  real_call: z.boolean().default(false),
});

/** The provider accepted the message (mock in alpha). PII-free. */
export const MessagingSentPayload = z.object({
  message_id: uuidSchema,
  worker_id: uuidSchema,
  template: z.string().min(1).max(64),
  channel: MessageChannelEnum,
  real_call: z.boolean().default(false),
});

/** A send was SUPPRESSED before the provider (e.g. no whatsapp_messaging consent). */
export const MessagingSuppressedPayload = z.object({
  worker_id: uuidSchema,
  template: z.string().min(1).max(64),
  reason: MessagingSuppressReasonEnum,
});

/** A send FAILED at/after the provider. PII-free. */
export const MessagingFailedPayload = z.object({
  message_id: uuidSchema,
  worker_id: uuidSchema,
  template: z.string().min(1).max(64),
  channel: MessageChannelEnum,
  reason: MessagingFailReasonEnum,
  real_call: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
// PACE supply-widening (ADR-0021) — the deterministic "release waves" slice of
// ADR-0011's PACE triad. PII-FREE & FACELESS: an opaque job_id + the widen-stage
// enum + supply COUNTS + elapsed hours ONLY. A worker, employer, location, or any
// PII NEVER appears. No LLM decides anything on this path (invariant 4) — the widen
// decision is a pure config-driven rule. All v1 (version-never-mutate).
// ---------------------------------------------------------------------------

/** Which supply-widening lever a wave applied. `area` raises the travel band;
 * `adjacent_trade` adds related-trade matches at the lower secondary weight (gated
 * on a ratified adjacency map — see ADR-0021). Enum-only → no free text. */
const PaceWidenStageEnum = z.enum(["area", "adjacent_trade"]);

/** A PACE wave widened a job's good-fit supply one step. `supply_count` is the count
 * of above-floor (on-trade) good-fit candidates AT widen time; `elapsed_hours` is
 * hours since the job's PACE run began. Faceless: opaque job_id + enum + counts only. */
export const PaceWaveWidenedPayload = z.object({
  job_id: uuidSchema,
  stage: PaceWidenStageEnum,
  supply_count: z.number().int().nonnegative(),
  elapsed_hours: z.number().nonnegative(),
});

/** Supply stayed thin past the configured window → an ops alert was raised for human
 * intervention. Faceless: opaque job_id + the thin supply count + elapsed hours only. */
export const PaceOpsAlertRaisedPayload = z.object({
  job_id: uuidSchema,
  supply_count: z.number().int().nonnegative(),
  elapsed_hours: z.number().nonnegative(),
});
// payer.* — Self-serve payer account auth (ADR-0019 Decision B; closes R16/LC-1/TD33).
//
// The payer is the THIRD principal (worker / payer / ops). These events record the
// payer auth lifecycle (signup → login-requested → session-started) for the audit
// spine — the payer analogue of `worker.created` / `worker.otp_requested` /
// `worker.otp_verified`.
//
// FACELESS / PII-FREE (CLAUDE.md invariant #2 + the ADR-0019 B-R2 extension): the
// payer's email, phone, and org/display name are a NEW PII class that lives ONLY in
// the `payers` table (encrypted at rest, keyed-hash lookup). They MUST NEVER appear
// here. The ONLY identity reference is the opaque `payer_id` (== `payers.id`); the
// rest is the role enum, the login-method enum, and booleans. No email hash either —
// the spine carries the resolved account id, not a contactable token.
// ---------------------------------------------------------------------------

/** The payer's account role (mirrors `db.PayerRole`). Enum-only → no PII. */
export const PayerRoleEnum = z.enum(["employer", "agent"]);
export type PayerRoleEnum = z.infer<typeof PayerRoleEnum>;

/**
 * The login mechanism a payer authenticated through (ADR-0019 B-R1). `email_otp` is
 * the alpha mock default; `whatsapp` rides the ADR-0020 mock provider; `supabase` is
 * the config-gated adapter (inert without keys). Enum-only → no PII.
 */
export const PayerLoginMethodEnum = z.enum(["email_otp", "whatsapp", "supabase"]);
export type PayerLoginMethodEnum = z.infer<typeof PayerLoginMethodEnum>;

/**
 * A new payer account was created (signup). `payer_id` is the opaque account id; the
 * email/phone/org-name that came with the signup are NOT here (they live encrypted in
 * `payers`). Role + method enums only.
 */
export const PayerCreatedPayload = z.object({
  payer_id: uuidSchema,
  role: PayerRoleEnum,
  method: PayerLoginMethodEnum,
});
export type PayerCreatedPayload = z.infer<typeof PayerCreatedPayload>;

/**
 * A login code was issued for an EXISTING payer account (the no-account branch emits
 * nothing — the HTTP response is identical either way, so this asymmetry is not a
 * caller-observable enumeration oracle; XB-H). Resolved `payer_id` + method only —
 * never the email/phone the request carried.
 */
export const PayerLoginRequestedPayload = z.object({
  payer_id: uuidSchema,
  method: PayerLoginMethodEnum,
});
export type PayerLoginRequestedPayload = z.infer<typeof PayerLoginRequestedPayload>;

/**
 * A payer session was minted (successful login-verify). `is_new_payer` echoes whether
 * the account was created in the same flow. ids + enums + boolean only.
 */
export const PayerSessionStartedPayload = z.object({
  payer_id: uuidSchema,
  method: PayerLoginMethodEnum,
  is_new_payer: z.boolean().default(false),
});
export type PayerSessionStartedPayload = z.infer<typeof PayerSessionStartedPayload>;

/**
 * The field KEYS a payer may self-edit on `PATCH /payer/me` (PROF-3). Pinned as an
 * enum (not a free `z.string()`) so the registry STRUCTURALLY guarantees
 * `changed_fields` can only ever carry KEYS — never the new org-name / phone VALUES
 * (defense-in-depth on the B-R2 PII boundary; CLAUDE.md invariant #2).
 */
const PAYER_ACCOUNT_CHANGED_FIELDS = ["org_name", "phone"] as const;

/**
 * A payer edited their OWN account display name and/or contact phone (PROF-3,
 * `PATCH /payer/me`). FACELESS by construction: the only fact recorded is WHICH field
 * KEYS changed — NEVER the new org-name or phone VALUES (those are the B-R2 contact PII,
 * stored ONLY in `payers`, encrypted). `changed_fields` is a non-empty subset of
 * {org_name, phone} (an empty patch is rejected at the boundary, so a recorded update
 * always changed at least one field). Email/role/status are immutable here, so they can
 * never appear. Mirrors the `job.updated` / `job_posting.updated` keys-only precedent.
 */
export const PayerAccountUpdatedPayload = z.object({
  payer_id: uuidSchema,
  changed_fields: z.array(z.enum(PAYER_ACCOUNT_CHANGED_FIELDS)).min(1),
});
export type PayerAccountUpdatedPayload = z.infer<typeof PayerAccountUpdatedPayload>;

// ---------------------------------------------------------------------------
// job.* — the `jobs` ENTITY lifecycle (ADR-0022 Agency Supply Portal demand slice).
//
// DISTINCT from `job_posting.*` (ADR-0012, the ops vacancy register, a DIFFERENT
// entity/table). These events record create/update/close on the faceless `jobs` row
// (the Reach-facing demand entity, `jobs.payer_id` = the owning payer). The PAYER is
// the actor; `subject` is the `job` entity.
//
// FACELESS / PII-FREE by construction: opaque ids (`job_id`, `payer_id`) + COARSE
// non-PII bands ONLY (trade slug, city label, integer ₹ pay bands, year counts) — the
// EXACT, already-non-PII subset of the `jobs` columns. NEVER an employer name, an
// address, a worker identity, or any free text beyond the coarse city label. `payer_id`
// is the opaque faceless-rails owner ref (employer OR agent), NEVER resolved to identity
// in any event/log. All v1 (version-never-mutate).
// ---------------------------------------------------------------------------

/** `jobs` lifecycle status (mirrors db.JobStatus — open|closed only). Enum → no PII. */
export const JobStatusEnum = z.enum(["open", "closed"]);
export type JobStatusEnum = z.infer<typeof JobStatusEnum>;

/** Coarse city label (e.g. "Pune") — NOT an address. Short, non-PII bound. */
const cityLabelSchema = z.string().min(1).max(120);

/**
 * A `jobs` row was created (demand posted). Carries the opaque job + owning payer ids,
 * the (open) status, and the COARSE bands the row already holds (trade slug + city) —
 * never an employer name or any free text. Pay/experience bands are optional bands.
 */
export const JobCreatedPayload = z.object({
  job_id: uuidSchema,
  payer_id: uuidSchema,
  status: JobStatusEnum,
  trade_key: tradeKeySchema,
  city: cityLabelSchema,
  pay_min: z.number().int().nonnegative().nullable().default(null),
  pay_max: z.number().int().nonnegative().nullable().default(null),
  min_experience_years: z.number().int().nonnegative().nullable().default(null),
  max_experience_years: z.number().int().nonnegative().nullable().default(null),
});
export type JobCreatedPayload = z.infer<typeof JobCreatedPayload>;

/** The KEYS of the `jobs` fields an update may touch — KEYS ONLY (never the values). */
export const JOB_CHANGED_FIELDS = [
  "trade_key",
  "title",
  "city",
  "area",
  "pay_min",
  "pay_max",
  "min_experience_years",
  "max_experience_years",
  "needed_by",
  "status",
] as const;

/**
 * A `jobs` row was updated. `changed_fields` is the list of field KEYS that changed —
 * KEYS ONLY, never the values (so no free text ever leaks). `status` is the post-update
 * status. Used for both edits and the pause==close transition (ADR-0022 Phase-1).
 */
export const JobUpdatedPayload = z.object({
  job_id: uuidSchema,
  payer_id: uuidSchema,
  status: JobStatusEnum,
  changed_fields: z.array(z.enum(JOB_CHANGED_FIELDS)).max(JOB_CHANGED_FIELDS.length),
});
export type JobUpdatedPayload = z.infer<typeof JobUpdatedPayload>;

/**
 * A `jobs` row was closed (terminal). Records the transition: the previous status and
 * the terminal "closed" status. PII-free (ids + enums only).
 */
export const JobClosedPayload = z.object({
  job_id: uuidSchema,
  payer_id: uuidSchema,
  previous_status: JobStatusEnum,
  status: z.literal("closed"),
});
export type JobClosedPayload = z.infer<typeof JobClosedPayload>;

// ---------------------------------------------------------------------------
// agency_invite.* — AGENCY supply-attribution funnel (ADR-0022). FACELESS, ids/enums.
//
// The SIBLING of `invite.*` (the worker→worker funnel) on the PAYER axis: here the
// inviter is an agency (a `payers` row, role='agent'). DISTINCT domain — the inviter is
// a different principal on a different identity axis (payer, not worker).
//
// PII-FREE by construction: opaque `agency_invite_id`, opaque `inviter_payer_id`, the
// channel enum, and an OPTIONAL non-PII campaign tag (a stable code, never free-form
// PII). NO phone, NO name, NO email, NO message body EVER. `agency_invite.accepted`
// adds the opaque `invited_worker_id` — emitted ONLY after `consent.accepted` (DPDP gate,
// invariant #6). All v1.
// ---------------------------------------------------------------------------

/**
 * An agency minted a referral deep-link (`/i/<code>`). `inviter_payer_id` is the opaque
 * owning agency; the opaque `code` itself is NOT carried (it is a shareable secret).
 * Optional non-PII campaign tag only.
 */
export const AgencyInviteCreatedPayload = z.object({
  agency_invite_id: uuidSchema,
  inviter_payer_id: uuidSchema,
  channel: MessageChannelEnum,
  campaign: z.string().min(1).max(64).optional(),
});
export type AgencyInviteCreatedPayload = z.infer<typeof AgencyInviteCreatedPayload>;

/**
 * An invited person became a worker AND has an ACTIVE consent (invariant #6) — the
 * attribution link. Both ids opaque. This is the ONLY agency_invite event that carries a
 * worker handle, and it is emitted EXCLUSIVELY from the consent-gated internal seam (never
 * an agency-supplied worker id).
 */
export const AgencyInviteAcceptedPayload = z.object({
  agency_invite_id: uuidSchema,
  inviter_payer_id: uuidSchema,
  invited_worker_id: uuidSchema,
});
export type AgencyInviteAcceptedPayload = z.infer<typeof AgencyInviteAcceptedPayload>;

// ---------------------------------------------------------------------------
// admin.* — the Admin Ops Portal, the 4th privileged principal (ADR-0025).
//
// FACELESS / PII-FREE by construction (CLAUDE.md invariant #2). The admin's OWN login
// email lives encrypted ONLY in `admin_users` — it MUST NEVER appear here. The ONLY
// identity reference is the opaque `admin_id` (== `admin_users.id`). These payloads carry
// ids + enums + CODES only — never a value, a changed value, the revealed PII, the admin's
// email, or a free-text reason note. `.strict()` on every schema STRUCTURALLY rejects any
// extra (potentially PII-shaped) key at validation time, so a careless caller cannot smuggle
// a value into the spine.
//
// `admin.session_started` / `admin.session_revoked` ride the `admin_session` subject;
// `admin.action_performed` / `admin.pii_viewed` (registered now for ADMIN-3, NOT emitted in
// ADMIN-1) carry a `target_type`/`target_id` of the entity acted on. All v1
// (version-never-mutate — a future incompatible change bumps the version, never mutates).
// ---------------------------------------------------------------------------

/** The admin's RBAC role (mirrors `db.AdminRole`). Enum-only → no PII. */
export const AdminRoleEnum = z.enum(["super_admin", "ops_admin", "support", "analyst"]);
export type AdminRoleEnum = z.infer<typeof AdminRoleEnum>;

/**
 * An admin session was minted (a successful login that passed OTP + the MFA gate). The
 * opaque `admin_id` + the role enum ONLY — never the admin's email or any value. `.strict()`
 * so no extra key can ride along.
 */
export const AdminSessionStartedPayload = z
  .object({
    admin_id: uuidSchema,
    role: AdminRoleEnum,
  })
  .strict();
export type AdminSessionStartedPayload = z.infer<typeof AdminSessionStartedPayload>;

/**
 * An admin session was revoked (logout). The opaque `admin_id` ONLY (no reason value, no
 * PII). `.strict()` rejects any extra key.
 */
export const AdminSessionRevokedPayload = z
  .object({
    admin_id: uuidSchema,
  })
  .strict();
export type AdminSessionRevokedPayload = z.infer<typeof AdminSessionRevokedPayload>;

/**
 * A governed admin mutation was performed (ADR-0025 Decision 5/6 — registered now for
 * ADMIN-3; NOT emitted in ADMIN-1). The WHAT is an opaque `action_code` (e.g. a
 * `suspend_payer` code), NEVER the old/new VALUES — exactly the "record the fact, not the
 * value" rule the `pricing.*` keys-only events use. `target_type`/`target_id` identify the
 * entity acted on (opaque). `.strict()` so no value can be smuggled in.
 */
export const AdminActionPerformedPayload = z
  .object({
    admin_id: uuidSchema,
    action_code: z.string().min(1).max(64),
    target_type: z.string().min(1).max(64),
    target_id: uuidSchema,
  })
  .strict();
export type AdminActionPerformedPayload = z.infer<typeof AdminActionPerformedPayload>;

/**
 * A reason-gated PII reveal happened (ADR-0025 Decision 4/6 — registered now for ADMIN-3;
 * NOT emitted in ADMIN-1). The audit FACT: which admin viewed which subject's contact and
 * under which `reason_code` (a closed code, never the free-text note, NEVER the revealed
 * value). The revealed phone/name exists ONLY in the HTTP response to the authenticated
 * admin — never in this payload, a log, `ai_jobs`, or `audit_logs`. `.strict()` is the
 * structural backstop against smuggling the value into the spine.
 */
export const AdminPiiViewedPayload = z
  .object({
    admin_id: uuidSchema,
    subject_id: uuidSchema,
    reason_code: z.string().min(1).max(64),
  })
  .strict();
export type AdminPiiViewedPayload = z.infer<typeof AdminPiiViewedPayload>;

/** Which per-admin reveal cap was breached (ADR-0025 ADMIN-3b must-fix #8). Enum-only → no PII. */
export const ADMIN_PII_REVEAL_CAP_WINDOWS = ["hour", "day"] as const;
export const AdminPiiRevealCapWindow = z.enum(ADMIN_PII_REVEAL_CAP_WINDOWS);
export type AdminPiiRevealCapWindow = z.infer<typeof AdminPiiRevealCapWindow>;

/**
 * A per-admin worker-PII reveal cap was EXCEEDED (ADR-0025 ADMIN-3b must-fix #8) — the
 * PII-free BREACH/ALERT recorded when an admin tries to reveal past their hour/day cap (an
 * over-cap request reveals NOTHING). Ops can alert on this without parsing any per-subject
 * data. AGGREGATE / PII-FREE BY CONSTRUCTION: the opaque `admin_id` whose velocity tripped
 * the cap + which `window` (hour|day) ONLY — NEVER a worker/subject id, the revealed value,
 * the reason note, or any phone. `.strict()` is the structural backstop against smuggling a
 * value onto the spine.
 */
export const AdminPiiRevealCapExceededPayload = z
  .object({
    admin_id: uuidSchema,
    window: AdminPiiRevealCapWindow,
  })
  .strict();
export type AdminPiiRevealCapExceededPayload = z.infer<typeof AdminPiiRevealCapExceededPayload>;

/**
 * The CLOSED set of platform operational/provider kill-switches an admin may request a
 * safe-direction PAUSE for (ADR-0025 ADMIN-3c, OQ-6). A switch KEY enum — never free text,
 * never a secret/value. Each names an EXISTING env/config-governed switch (the pause is
 * actioned out-of-band via env/deploy; this event records only the audited INTENT — §2 #5).
 */
export const ADMIN_KILL_SWITCH_KEYS = [
  "ai_real_calls", // AI_ENABLE_REAL_CALLS / ai-service real LLM calls
  "real_payments", // PAYMENTS_ENABLE_REAL (mock in alpha)
  "real_messaging", // MESSAGING_ENABLE_REAL — WhatsApp (mock in alpha)
  "worker_otp_sms", // OTP_GLOBAL_MAX_SENDS_PER_DAY → 0 = paused (worker SMS)
  "payer_otp_email", // PAYER_OTP_GLOBAL_MAX_SENDS_PER_DAY → 0 = paused (payer email)
  "resume_render", // RESUME_RENDER_ENABLED (WeasyPrint resume + interview-kit)
  "admin_pii_reveal", // ADMIN_PII_REVEAL_ENABLED (ADMIN-3b)
] as const;
export const AdminKillSwitchKey = z.enum(ADMIN_KILL_SWITCH_KEYS);
export type AdminKillSwitchKey = z.infer<typeof AdminKillSwitchKey>;

/**
 * Why an admin requested a safe-direction kill-switch PAUSE (ADR-0025 ADMIN-3c). A CLOSED
 * reason CODE — never free text — so the audited intent carries no PII / no value.
 */
export const ADMIN_KILL_SWITCH_PAUSE_REASONS = [
  "incident_response",
  "cost_spike",
  "abuse_mitigation",
  "maintenance",
] as const;
export const AdminKillSwitchPauseReason = z.enum(ADMIN_KILL_SWITCH_PAUSE_REASONS);
export type AdminKillSwitchPauseReason = z.infer<typeof AdminKillSwitchPauseReason>;

/**
 * A safe-direction kill-switch PAUSE was REQUESTED (ADR-0025 ADMIN-3c, OQ-6) — the audited
 * INTENT to pause a provider/operation. It NEVER enables anything (enabling a real provider
 * stays env/deploy-gated, §2 #5 — there is no enable event/route). PII-FREE & VALUE-FREE by
 * construction: the opaque `admin_id` + a switch KEY enum + a reason CODE ONLY — no secret,
 * no provider key, no toggle value. `.strict()` is the structural backstop against smuggling
 * a value onto the spine. Subject = the `kill_switch` subject (subject_id null).
 */
export const AdminKillSwitchPauseRequestedPayload = z
  .object({
    admin_id: uuidSchema,
    switch_key: AdminKillSwitchKey,
    reason_code: AdminKillSwitchPauseReason,
  })
  .strict();
export type AdminKillSwitchPauseRequestedPayload = z.infer<
  typeof AdminKillSwitchPauseRequestedPayload
>;
