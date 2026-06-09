/** BullMQ queue names. Keep in one place so producers + processors agree. */
export const PROFILE_EXTRACTION_QUEUE = "profile-extraction";

/** Payload enqueued for an async profile-extraction job (refs only, no PII). */
export interface ProfileExtractionJobData {
  workerId: string;
  sessionId: string | null;
  aiJobId: string;
  /** Tracing ids carried from the originating HTTP request. */
  correlationId: string;
  requestId: string;
}
