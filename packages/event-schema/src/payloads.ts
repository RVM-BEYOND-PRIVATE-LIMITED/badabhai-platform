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
