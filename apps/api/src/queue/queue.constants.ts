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

/**
 * Policy 27 third leg ("Expiring", TD127) — reach-widen expiry sweep queue. The
 * repeatable tick carries NO payload: the predicate over `job_reach_widen`
 * (un-retracted + past `expires_at`) is the authoritative work list, so a lost or
 * duplicated Redis job is harmless — the next tick re-evaluates it. The RETRACT
 * decision itself lives in PublishReachService.retractExpiredWidens; this queue only
 * supplies the clock.
 */
export const REACH_WIDEN_EXPIRY_QUEUE = "reach-widen-expiry";

/**
 * Stable BullMQ job-scheduler id for the widen-expiry sweep (same doctrine as its
 * ACCOUNT_DELETION / AI_JOBS_RETENTION / CHAT_ABANDONMENT twins): the idempotent upsert
 * key the processor re-asserts at every boot.
 */
export const REACH_WIDEN_EXPIRY_SWEEP_SCHEDULER_ID = "reach-widen-expiry-sweep";

/**
 * #2749 item 4 — the credit-lot expiry sweep queue. The repeatable tick carries NO payload: the
 * predicate over `credit_lots` (open + past `expires_at`) is the authoritative work list, so a
 * lost or duplicated Redis job is harmless — the next tick (or the wallet's next spend, which
 * expires a due lot first) catches anything missed. The EXPIRY itself lives in packages/db
 * `credit-wallet.ts`; this queue only supplies the clock.
 */
export const CREDIT_LOT_EXPIRY_QUEUE = "credit-lot-expiry";

/** Stable BullMQ job-scheduler id for the credit-lot expiry sweep (twin doctrine). */
export const CREDIT_LOT_EXPIRY_SWEEP_SCHEDULER_ID = "credit-lot-expiry-sweep";

/**
 * #2750 item 7 — the couldn't-reach deadline sweep: a repeatable tick (every 15 minutes) that
 * closes each case still open past its 48-hour deadline as not reached and returns its credits.
 * Inert while the `credit_rules` switch is off everywhere. The rule lives in ReachDeskService; this
 * queue only supplies the clock.
 */
export const REACH_DESK_DEADLINE_QUEUE = "reach-desk-deadline";

/** Stable BullMQ job-scheduler id for the couldn't-reach deadline sweep. */
export const REACH_DESK_DEADLINE_SCHEDULER_ID = "reach-desk-deadline-sweep";

/**
 * #2751 item 9 — the Managed Hiring clock: a repeatable tick (every 15 minutes) that moves each open
 * order past its deadline (met, or extended free) or past its extension's end (met, or closed not
 * met with an admin alert). Inert while the `managed_hiring` switch is off everywhere. The rule
 * lives in ManagedHiringService; this queue only supplies the clock.
 */
export const MANAGED_HIRING_SWEEP_QUEUE = "managed-hiring-sweep";

/** Stable BullMQ job-scheduler id for the Managed Hiring sweep. */
export const MANAGED_HIRING_SWEEP_SCHEDULER_ID = "managed-hiring-sweep";

/**
 * LEARN label producer sweep (migration 0091) — drains spine events
 * (feed.shown_v2 / application.submitted / application.skipped) into `learn_labels`
 * for the offline reach-learn calibrator. The repeatable tick carries NO payload: the
 * cursor + UNIQUE impression key in the store are authoritative, so a lost or
 * duplicated Redis job is harmless.
 */
export const LEARN_LABELS_QUEUE = "learn-labels";

/** Stable BullMQ job-scheduler id for the learn-labels sweep (twin doctrine). */
export const LEARN_LABELS_SWEEP_SCHEDULER_ID = "learn-labels-sweep";

/**
 * #2297 (ADR-0056) — the Bada Bhai chat's retention sweep: once a day, delete the stored lines
 * older than 7 days and every rolling summary whose conversation has expired. The repeatable tick
 * carries NO payload: the age predicate over `companion_messages` is authoritative, so a lost or
 * duplicated Redis job is harmless.
 */
export const COMPANION_HISTORY_SWEEP_QUEUE = "companion-history-sweep";

/** Stable BullMQ job-scheduler id for the companion history sweep (twin doctrine). */
export const COMPANION_HISTORY_SWEEP_SCHEDULER_ID = "companion-history-sweep";

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

/**
 * ADR-0041 résumé-import parse queue.
 *
 * A QUEUE AND NOT A DIRECT CALL, for the reason every other AI path here is one: reading a
 * document means downloading it, rasterising it, possibly running OCR over it and then one
 * model call. That is tens of seconds on a scanned photograph, and the worker who uploaded it
 * is holding a phone waiting for a 201. The confirm route registers the row and returns; this
 * queue does the reading.
 *
 * A LOST JOB IS A STUCK IMPORT, NOT A CORRUPT ONE. The row sits at `uploaded`, `GET :importId`
 * keeps answering, and the worker is never blocked — ruling D9's "never a dead end" is served
 * by the client carrying on into the chat, not by this job succeeding.
 */
export const RESUME_IMPORT_PARSE_QUEUE = "resume-import-parse";

/**
 * Payload for one résumé parse (refs only, no PII).
 *
 * TWO IDS AND THE TRACING PAIR — no storage key, no mime, no filename. The processor loads the
 * row itself, which is also what makes the job safe to retry: everything it needs is in
 * Postgres, so nothing about the worker's document ever sits in Redis.
 */
export interface ResumeImportParseJobData {
  importId: string;
  workerId: string;
  /** Tracing ids carried from the originating HTTP request. */
  correlationId: string;
  requestId: string;
}

/**
 * ADR-0041 §7 stale-import sweep queue (#1665) — the sweep §7 said was "owed before real
 * traffic" and that never got built.
 *
 * WHY A SECOND QUEUE AND NOT A JOB ON {@link RESUME_IMPORT_PARSE_QUEUE}. That queue's
 * `defaultJobOptions` are sized for a job that reads a document: 3 attempts with exponential
 * backoff. A repeatable clock tick wants neither, and mixing a scheduler into a queue whose
 * jobs can sit for minutes behind an OCR run means the tick inherits that wait. It also keeps
 * the two drainable independently when a backlog exists.
 *
 * The repeatable tick carries NO payload — the predicate over `worker_resume_import` (still
 * `parsing`, untouched for longer than RESUME_IMPORT_STALE_AFTER_SECONDS) is the authoritative
 * work list, so a lost or duplicated Redis job is harmless: the next tick re-evaluates it and
 * catches anything missed.
 */
export const RESUME_IMPORT_SWEEP_QUEUE = "resume-import-sweep";

/**
 * Stable BullMQ job-scheduler id for the stale-import sweep — the idempotent upsert key the
 * processor re-asserts at every boot (same-id upserts update the cadence instead of stacking
 * duplicate schedulers). Lives here beside its ACCOUNT_DELETION / AI_JOBS_RETENTION /
 * CHAT_ABANDONMENT / REACH_WIDEN_EXPIRY twins so queue names and scheduler ids stay in one
 * place.
 */
export const RESUME_IMPORT_SWEEP_SCHEDULER_ID = "resume-import-sweep";

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
  /**
   * ADR-0046 O6 — the job is a companion edit card's regeneration: a NEW history entry on the
   * worker's CURRENT profile, whose daily-cap slot `ResumeService.queueChatEditRegeneration`
   * already took on the worker's request. Absent on every profile.confirmed job, which behaves
   * exactly as it always did — and a build that predates the field reads such a job as one of
   * those, whose one-per-worker skip then spends nothing.
   */
  trigger?: "chat_edit" | "admin_edit";
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

/**
 * ADR-0050 (#1957) — the agency-job V1 twin sync. Two repeatable ticks on one queue, each
 * carrying NO payload: the `events` window (poll) and the agency `jobs` themselves (sweep) are
 * the authoritative work lists, and the sync is idempotent, so a lost or duplicated Redis job is
 * harmless. Registered whatever AGENCY_TWIN_SYNC_ENABLED says: disarmed, the sweep tick is how the
 * kill switch pauses twins.
 */
export const AGENCY_TWIN_SYNC_QUEUE = "agency-twin-sync";

/** The event-poll tick's scheduler id + job name (fast: a few seconds behind an agency write). */
export const AGENCY_TWIN_POLL_SCHEDULER_ID = "agency-twin-sync-poll";
export const AGENCY_TWIN_POLL_JOB = "poll";
export const AGENCY_TWIN_POLL_EVERY_MS = 30_000;

/** The convergence sweep's scheduler id + job name (the backstop and the kill switch's clock). */
export const AGENCY_TWIN_SWEEP_SCHEDULER_ID = "agency-twin-sync-sweep";
export const AGENCY_TWIN_SWEEP_JOB = "sweep";
export const AGENCY_TWIN_SWEEP_EVERY_MS = 10 * 60_000;

/**
 * B4 (#2557) — the admin candidate read table. Two repeatable ticks on one queue,
 * each carrying NO payload: the events-cursor window (poll) and the `workers`
 * table itself (rebuild) are the authoritative work lists, and projection is an
 * idempotent upsert, so a lost or duplicated Redis job is harmless.
 */
export const CANDIDATE_INDEX_QUEUE = "candidate-index";

/** #2561 PR 3 — re-project ONE worker after an admin correction commits. */
export const CANDIDATE_INDEX_PROJECT_JOB = "project-worker";

/** The events-cursor poll tick (minutes behind a worker/profile/résumé write). */
export const CANDIDATE_INDEX_POLL_SCHEDULER_ID = "candidate-index-poll";
export const CANDIDATE_INDEX_POLL_JOB = "poll";

/** The full-rebuild tick (missed events and resolver changes converge). */
export const CANDIDATE_INDEX_REBUILD_SCHEDULER_ID = "candidate-index-rebuild";
export const CANDIDATE_INDEX_REBUILD_JOB = "rebuild";

/** How far before the stored watermark each poll tick re-reads (overlap window). */
export const CANDIDATE_INDEX_OVERLAP_MS = 5 * 60_000;

/**
 * #2747 item 8 — the outbound-signal sender (`outbound_signals`, migration 0167). One repeatable
 * tick with NO payload: the table's due pending rows are the work list, and the destination
 * de-duplicates on each row's id, so a lost or duplicated Redis job is harmless.
 */
export const OUTBOUND_SIGNALS_QUEUE = "outbound-signals";
export const OUTBOUND_SIGNALS_SWEEP_SCHEDULER_ID = "outbound-signals-sweep";

/**
 * #2753 item 5 — the monthly "still looking?" sweep (`still_looking_checks`, migration 0173). One
 * repeatable DAILY tick with NO payload: the predicate over `workers` and `still_looking_checks` (an
 * active, consented worker with no open check and none inside STILL_LOOKING_EVERY_DAYS) is the work
 * list, and the open-check unique index guards the insert, so a lost or duplicated Redis job is
 * harmless: the next tick re-evaluates it, and two ticks racing open one check per worker.
 */
export const STILL_LOOKING_SWEEP_QUEUE = "still-looking-sweep";
export const STILL_LOOKING_SWEEP_SCHEDULER_ID = "still-looking-sweep";

/**
 * #2755 part B — the numbers screen's nightly snapshot sweep (`numbers_weekly`). One repeatable
 * DAILY tick with NO payload: the not-yet-frozen weeks from the baseline to the current one are the
 * work list, each recomputed whole under its own advisory lock, so a lost or duplicated Redis job
 * is harmless: the next tick recomputes the same weeks, and two ticks racing leave one set of rows.
 */
export const NUMBERS_WEEKLY_SWEEP_QUEUE = "numbers-weekly-sweep";
export const NUMBERS_WEEKLY_SWEEP_SCHEDULER_ID = "numbers-weekly-sweep";

/**
 * #2774 — the nightly credit balance audit. A repeatable daily tick with no payload: the audit is
 * one read-only snapshot of every wallet, so a lost or duplicated Redis job is harmless (the next
 * tick reads the same books, and the alert's per-day key raises it once). Inert while
 * CREDIT_BALANCE_AUDIT_ENABLED is off: a tick returns at once without a query.
 */
export const CREDIT_BALANCE_AUDIT_QUEUE = "credit-balance-audit";
export const CREDIT_BALANCE_AUDIT_SCHEDULER_ID = "credit-balance-audit";
