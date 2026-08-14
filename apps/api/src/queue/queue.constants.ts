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

/** PERF-3 ai_jobs retention sweep queue. The repeatable tick carries NO payload —
 * the prune predicate over ai_jobs (terminal + aged-out + unreferenced) is the
 * authoritative work list, so a lost/duplicated Redis job is harmless: the next
 * tick re-evaluates the same predicate and catches anything missed. */
export const AI_JOBS_RETENTION_QUEUE = "ai-jobs-retention";

/** Stable BullMQ job-scheduler id for the PERF-3 retention sweep — the idempotent
 * upsert key the processor re-asserts at every boot (same-id upserts update the
 * cadence instead of stacking duplicate schedulers). Lives here beside its
 * ACCOUNT_DELETION twin so queue names and scheduler ids stay in one place. */
export const AI_JOBS_RETENTION_SWEEP_SCHEDULER_ID = "ai-jobs-retention-sweep";

/**
 * Idle-chat-session abandonment sweep queue. The repeatable tick carries NO payload —
 * the predicate over `chat_sessions` (still `active`, quiet longer than
 * CHAT_ABANDON_AFTER_SECONDS) is the authoritative work list, so a lost or duplicated
 * Redis job is harmless: the next tick re-evaluates it and catches anything missed.
 */
export const CHAT_ABANDONMENT_QUEUE = "chat-abandonment";

/**
 * Stable BullMQ job-scheduler id for the abandonment sweep — the idempotent upsert key
 * the processor re-asserts at every boot (same-id upserts update the cadence instead of
 * stacking duplicate schedulers). Lives here beside its ACCOUNT_DELETION and
 * AI_JOBS_RETENTION twins so queue names and scheduler ids stay in one place.
 */
export const CHAT_ABANDONMENT_SWEEP_SCHEDULER_ID = "chat-abandonment-sweep";

/** ADR-0034 worker push-notification queue. */
export const PUSH_QUEUE = "worker-push";

/**
 * §X.6 worker-referral activation-bonus evaluation queue.
 *
 * A QUEUE rather than a direct service call on purpose. The rule needs both of its legs —
 * a confirmed profile AND a granted unlock — and those happen in two different modules,
 * minutes or weeks apart. Enqueuing from each keeps the evaluation off both request paths,
 * gives it BullMQ's retries for free (the rule is idempotent, and `UNIQUE
 * (invited_worker_id)` is the backstop), and — the reason it is a queue and not an
 * injected service — introduces NO module dependency edge from `profiles`/`unlocks` into
 * `referrals`, so no import cycle and no blast radius in either producer.
 *
 * A LOST job is a missed accrual, not a corrupt one: the ops
 * `POST /referrals/bonus/evaluate` re-runs the same idempotent rule.
 */
export const REFERRAL_BONUS_QUEUE = "referral-bonus";

/**
 * Payload enqueued to deliver ONE push fan-out (ADR-0034).
 *
 * REFS ONLY — no push token, no rendered copy, no name. `deviceIds` are opaque
 * `worker_devices.id` uuids; the processor resolves the token itself, so a token never
 * sits in Redis. The copy is static and server-rendered from NOTIFICATION_TEMPLATES,
 * keyed by `eventName`, so it is fully reconstructible and never travels.
 *
 * TARGETING is decided by the PRODUCER, not the processor, because only the producer
 * knows the intent: a new-device alert must reach the worker's OTHER phones (never the
 * one that just logged in — otherwise a SIM-swap attacker gets the warning and the real
 * owner does not), and a logout-all alert must reach the devices it JUST revoked.
 */
export interface PushJobData {
  workerId: string;
  /** The event that triggered this push — the dedupe key + the audit link. */
  sourceEventId: string;
  /** Allowlisted event name; the copy is looked up from it. */
  eventName: string;
  /** Explicit targets (opaque device row ids). Never tokens. */
  deviceIds: string[];
}

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

/**
 * Payload for a §X.6 activation-bonus evaluation (refs only, no PII).
 *
 * Carries ONLY the referred worker's opaque id — the inviter is resolved server-side from
 * the `invites` row that attributed them, so no producer can nominate who gets paid, and
 * no phone/name/amount ever sits in Redis. `trigger` is a non-PII enum kept for
 * observability (which leg completed last), never for control flow: the processor
 * re-evaluates BOTH legs from the database regardless.
 */
export interface ReferralBonusJobData {
  invitedWorkerId: string;
  trigger: "profile_confirmed" | "unlock_granted";
}
