/** BullMQ queue names. Keep in one place so producers + processors agree. */
export const PROFILE_EXTRACTION_QUEUE = "profile-extraction";
export const VOICE_TRANSCRIPTION_QUEUE = "voice-transcription";
/** TD5 resume-render worker queues. */
export const RESUME_GENERATE_QUEUE = "resume-generate";
export const RESUME_RENDER_QUEUE = "resume-render";
/** ADR-0031 deletion-grace sweep queue. The repeatable sweep job carries NO payload —
 * the DB marker (workers.deletion_scheduled_at) is the authoritative work list, so a
 * lost Redis job is harmless (the next tick catches anything missed). */
export const ACCOUNT_DELETION_QUEUE = "account-deletion";

/**
 * Stable BullMQ job-scheduler id for the ADR-0031 deletion sweep — the idempotent upsert
 * key the processor registers at boot AND the id the /health readiness probe looks up.
 * Lives here (not in the processor) so the writer and the reader can never drift: a
 * mismatch would make `/health` report a dead sweep while the sweep is fine, or worse,
 * report a live sweep while nothing ticks. A lost REGISTRATION is NOT self-healing the
 * way a lost job is (there is no next tick to catch it) — hence the probe.
 */
export const ACCOUNT_DELETION_SWEEP_SCHEDULER_ID = "account-deletion-sweep";

/** Payload enqueued for an async profile-extraction job (refs only, no PII). */
export interface ProfileExtractionJobData {
  workerId: string;
  sessionId: string | null;
  aiJobId: string;
  /** Tracing ids carried from the originating HTTP request. */
  correlationId: string;
  requestId: string;
}

/** Payload enqueued for an async voice-transcription job (refs only, no PII —
 * `storagePath` is an opaque object key; the transcript is never enqueued). */
export interface VoiceTranscriptionJobData {
  voiceNoteId: string;
  workerId: string;
  storagePath: string;
  durationSeconds: number | null;
  languageCode: string | null;
  aiJobId: string;
  /** Tracing ids carried from the originating HTTP request. */
  correlationId: string;
  requestId: string;
}

/** Payload enqueued to auto-generate a resume after a profile is confirmed (refs
 * only, no PII — the structured profile + name are loaded inside the worker). */
export interface ResumeGenerateJobData {
  workerId: string;
  profileId: string;
  /** Tracing ids carried from the originating HTTP request. */
  correlationId: string;
  requestId: string;
}

/** Payload enqueued to render a resume PDF off the request path (refs only, no
 * PII — the worker name is decrypted SERVER-SIDE inside the render processor and
 * NEVER enqueued, logged, or emitted). */
export interface ResumeRenderJobData {
  resumeId: string;
  workerId: string;
  /** Tracing ids carried from the originating HTTP request. */
  correlationId: string;
  requestId: string;
}
