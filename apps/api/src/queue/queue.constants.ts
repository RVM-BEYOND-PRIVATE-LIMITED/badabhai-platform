/** BullMQ queue names. Keep in one place so producers + processors agree. */
export const PROFILE_EXTRACTION_QUEUE = "profile-extraction";
export const VOICE_TRANSCRIPTION_QUEUE = "voice-transcription";
/** TD5 resume-render worker queues. */
export const RESUME_GENERATE_QUEUE = "resume-generate";
export const RESUME_RENDER_QUEUE = "resume-render";

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
