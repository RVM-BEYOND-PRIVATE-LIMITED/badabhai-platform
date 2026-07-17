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
  /**
   * ADR-0032 / TD77 — re-render a resume whose PDF is ALREADY rendered.
   *
   * The processor is idempotent by default ("already rendered → skip"), which is
   * right for retries but means a PRESENTATION-only change made AFTER the first
   * render (a profile photo added/replaced/removed, or the show_photo pref
   * flipped) would never reach the PDF. Producers of such a change set this to
   * re-render in place: SAME resume id + version + object key, so no new version
   * is minted and the existing PDF stays downloadable until the fresh one lands.
   *
   * LLM-FREE: the render reads the stored profile snapshot + the server-decrypted
   * name + the photo bytes — it never calls the AI service, so a re-render costs
   * no AI spend. Omitted/false keeps today's skip-if-rendered behaviour.
   */
  force?: boolean;
  /**
   * ADR-0032 / TD77 — this forced re-render's job is to take PII (the worker's
   * face) OFF the PDF: photo removed, or show_photo turned off while a photo
   * exists.
   *
   * It changes the TERMINAL-FAILURE rule. A forced re-render normally degrades
   * OPEN (keep serving the existing PDF — the photo just isn't on it yet), because
   * a cosmetic refresh must never cost a worker their downloadable resume. But in
   * the REMOVE direction the existing PDF still embeds the face the worker asked us
   * to erase, so serving it is a §2/DPDP leak: that case fails CLOSED instead
   * (mark the row not-rendered → download 409s) rather than serve erased PII.
   */
  failClosed?: boolean;
  /** Tracing ids carried from the originating HTTP request. */
  correlationId: string;
  requestId: string;
}
