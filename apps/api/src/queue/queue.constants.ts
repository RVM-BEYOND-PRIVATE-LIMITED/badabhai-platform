/** BullMQ queue names. Keep in one place so producers + processors agree. */
export const PROFILE_EXTRACTION_QUEUE = "profile-extraction";
export const VOICE_TRANSCRIPTION_QUEUE = "voice-transcription";

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
