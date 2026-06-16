/**
 * @badabhai/types — shared domain enums and types.
 *
 * Framework-agnostic and dependency-free on purpose: anything (Nest, Next,
 * Drizzle, tests) can import these without pulling in zod or other runtime deps.
 * Runtime validation lives in @badabhai/validators; event contracts live in
 * @badabhai/event-schema.
 */

// ---- Worker lifecycle ----
export const WORKER_STATUSES = ["pending", "active", "suspended"] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];

// ---- Profile lifecycle ----
export const PROFILE_STATUSES = ["draft", "extracting", "extracted", "confirmed"] as const;
export type ProfileStatus = (typeof PROFILE_STATUSES)[number];

// ---- Consent ----
export const CONSENT_PURPOSES = [
  "profiling",
  "resume_generation",
  "communication",
  // Lawful basis for the in-house model track. Captured from day one on purpose:
  // adding it later would require re-consenting every existing worker (plan J1).
  "model_training",
  // Phase-2 Contact Unlock + Reveal (ADR-0010 §D3). A SEPARATE, explicit DPDP
  // disclosure purpose: it gates whether a worker's routed contact may be disclosed
  // to a paying party. It is DISTINCT from `profiling` — a worker may have profiling
  // consent but NOT this, and is then undiscoverable for unlock (neutral "unavailable").
  // The fail-closed gate keys on this exact string. Production DPDP notice copy +
  // lawful-basis wording remain a human/legal launch gate (CLAUDE.md §8).
  "employer_sharing",
] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

export const CURRENT_CONSENT_VERSION = "2026-06-01" as const;

// ---- Chat ----
export const CHAT_SESSION_STATUSES = ["active", "ended"] as const;
export type ChatSessionStatus = (typeof CHAT_SESSION_STATUSES)[number];

export const MESSAGE_DIRECTIONS = ["inbound", "outbound"] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

export const MESSAGE_TYPES = ["text", "voice", "system"] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

// ---- Voice notes ----
export const VOICE_RETENTION_POLICIES = ["retain_indefinitely", "delete_after_processing"] as const;
export type VoiceRetentionPolicy = (typeof VOICE_RETENTION_POLICIES)[number];

// Tiers for the indefinitely-retained voice/transcript corpus (plan J2):
// hot (active), archive (cheap cold object storage), physical (offline/archival).
export const STORAGE_CLASSES = ["hot", "archive", "physical"] as const;
export type StorageClass = (typeof STORAGE_CLASSES)[number];

/** Hard limit for Phase 1 voice notes (seconds). Mirrored in event-schema/validators. */
export const MAX_VOICE_NOTE_SECONDS = 120;

// ---- AI jobs ----
export const AI_JOB_TYPES = [
  "pseudonymization",
  "transcription",
  "profile_extraction",
  "resume_generation",
] as const;
export type AiJobType = (typeof AI_JOB_TYPES)[number];

export const AI_JOB_STATUSES = ["queued", "running", "completed", "failed"] as const;
export type AiJobStatus = (typeof AI_JOB_STATUSES)[number];

// ---- Languages (initial supported set for blue/grey-collar India) ----
export const LANGUAGE_CODES = [
  "en",
  "hi",
  "bn",
  "te",
  "ta",
  "mr",
  "gu",
  "kn",
  "ml",
  "pa",
  "or",
  "as",
] as const;
export type LanguageCode = (typeof LANGUAGE_CODES)[number];

// ---- Branded id helpers (lightweight; not enforced at runtime) ----
export type Uuid = string;
export type Iso8601 = string;
