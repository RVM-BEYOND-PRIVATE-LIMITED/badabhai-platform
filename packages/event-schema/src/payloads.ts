import { z } from "zod";
import {
  VACANCY_BANDS,
  JOB_POSTING_STATUSES,
  JOB_POSTING_VERIFICATION_STATUSES,
} from "@badabhai/types";
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

// D-3 — a worker session was minted via the GATED test-login seam (POST
// /auth/test-login; TEST_LOGIN_ENABLED + TEST_LOGIN_TOKEN, prod-boot-blocked).
// DISTINCT from worker.otp_verified so a test mint can never masquerade as a real
// OTP login on the audit spine. Mirrors WorkerOtpVerifiedPayload exactly — opaque
// worker_id + the keyed phone HASH + is_new_worker; `.strict()` so no extra field
// (a raw phone, the gate token) can ever ride in.
export const WorkerTestLoginPayload = z
  .object({
    worker_id: uuidSchema,
    phone_hash: phoneHash,
    is_new_worker: z.boolean(),
  })
  .strict();

// The worker recorded their real name. PII-free: the name itself is encrypted at
// rest in workers.full_name and NEVER appears here — only the fact that it was set.
export const WorkerNameRecordedPayload = z.object({
  worker_id: uuidSchema,
});

// The worker updated their resume display prefs on the "Aap control karte hain"
// edit screen. PII-FREE: only worker_id + the two boolean flags — never the
// name/phone/photo. Carries the RESULTING values (post-update) of both flags.
export const WorkerResumePrefsUpdatedPayload = z
  .object({
    worker_id: uuidSchema,
    show_photo: z.boolean(),
    night_shift_ready: z.boolean(),
  })
  .strict(); // no extra fields — a stray name/phone can never ride along (§2)

// ADR-0032 — the worker uploaded (or replaced) their profile photo. The photo is a
// high-sensitivity PII class living ONLY in the private WORKER_PHOTOS_BUCKET; this
// event carries the opaque worker_id and NOTHING else — never the object key, a URL,
// dimensions, or bytes (§2). Replacing a photo re-emits this same event.
export const WorkerPhotoUploadedPayload = z
  .object({
    worker_id: uuidSchema,
  })
  .strict();

// ADR-0032 — the worker removed their profile photo (pointer cleared + object
// best-effort deleted). Same PII posture: opaque worker_id only.
export const WorkerPhotoRemovedPayload = z
  .object({
    worker_id: uuidSchema,
  })
  .strict();

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

// ADR-0034 — server-initiated push. A push was SENT / FAILED for a worker.
//
// PII-FREE and DELIBERATELY MINIMAL. The `push_token` is the delivery ADDRESS and a
// secret: it must NEVER appear here (nor in logs / ai_jobs / audit_logs) — the same
// line `worker_devices.push_token` already holds. The rendered COPY is never carried
// either: it is static and server-rendered from NOTIFICATION_TEMPLATES, so it is fully
// reconstructible from `type` alone. `source_event_id` is the event that triggered the
// push, so the spine stays traceable without duplicating anything.
//
// `.strict()` on BOTH so a future field cannot be smuggled in without a version bump
// (§8) — in particular a token or a body of provider output.
export const WorkerPushSentPayload = z
  .object({
    worker_id: uuidSchema,
    source_event_id: uuidSchema,
    /** Coarse NotificationType (e.g. "security") — never free text. */
    type: z.string().min(1).max(64),
    /** How many devices it went to. A count, never the device ids or tokens. */
    device_count: z.number().int().nonnegative(),
  })
  .strict();

export const WorkerPushSendFailedPayload = z
  .object({
    worker_id: uuidSchema,
    source_event_id: uuidSchema,
    /** Closed enum — never a provider response body (which echoes the token). */
    reason: z.enum([
      "unregistered",
      "invalid_argument",
      "quota",
      "transport",
      "provider_error",
    ]),
  })
  .strict();

// TD92 — a push token was claimed FROM another worker's device rows (steal on register /
// push-token update). PII-FREE: opaque losing worker id + count of stale rows that were
// cleared. The ACTOR (winning worker) is the event envelope's actor_id. The token itself
// NEVER appears (CLAUDE.md invariant #2). v1.
export const WorkerPushTokenClaimedPayload = z
  .object({
    /** The worker WHO LOST the token (their devices were cleared). */
    worker_id: uuidSchema,
    /** How many of that worker's stale device rows were cleared. */
    device_count: z.number().int().nonnegative(),
  })
  .strict();

// ADR-0026 Phase 5 — DPDP worker-initiated account deletion. The worker's identity row
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

// ADR-0031 — the 7-day grace window around the erasure above. `scheduled_for` is the DUE
// time of the hard-delete (a system timestamp, not PII). Opaque worker_id ONLY — never a
// phone/phone_hash/name; .strict() so a stray PII field can never ride along (§2).
export const WorkerDeletionScheduledPayload = z
  .object({
    worker_id: uuidSchema,
    scheduled_for: isoDateTimeSchema,
  })
  .strict();

// ADR-0031 — the worker cancelled a pending deletion during grace. Deliberately carries
// NOTHING but the opaque id: what was cancelled (and when it was due) is recoverable from
// the paired worker.deletion_scheduled event on the same worker_id.
export const WorkerDeletionCancelledPayload = z
  .object({
    worker_id: uuidSchema,
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
// worker.otp_send_failed — F4 (#168): provider-side SMS send-failure signal on the
// worker OTP path. Fast2SMS is the ONLY send path (real-only, no console/mock), so a
// send failure was previously visible only as a logger.error — invisible to the event
// spine ops watches. AGGREGATE / PII-FREE BY CONSTRUCTION: the provider LITERAL + a
// failure-KIND enum ONLY — no phone, no phone_hash, no worker id, no OTP code, no HTTP
// status code, and no free text a status/response body could smuggle PII through
// (CLAUDE.md invariant #2 — "record the fact, not the value"). Emitted ONCE per failed
// send, in addition to (never instead of) the neutral 502 the caller already returns.
// ---------------------------------------------------------------------------

/**
 * How the real send failed. Enum-only → no PII / no status-code free text:
 *   - "transport"          the HTTPS request itself failed (network/DNS/TLS)
 *   - "http_error"         the provider answered with a non-2xx HTTP status
 *   - "provider_rejected"  the provider answered 200 but did not accept the message
 *                          (`return:false`) or returned an unparseable body
 */
export const OTP_SEND_FAILURE_REASONS = ["transport", "http_error", "provider_rejected"] as const;
export const OtpSendFailureReason = z.enum(OTP_SEND_FAILURE_REASONS);
export type OtpSendFailureReason = z.infer<typeof OtpSendFailureReason>;

/** The aggregate, PII-free send-failure payload. `.strict()` backstop. */
export const WorkerOtpSendFailedPayload = z
  .object({
    // Pinned literal — Fast2SMS is the only worker-SMS provider (§1 exit criteria).
    // Keeping it a literal (not free text) STRUCTURALLY guarantees no PII here.
    provider: z.literal("fast2sms"),
    reason: OtpSendFailureReason,
  })
  .strict();
export type WorkerOtpSendFailedPayload = z.infer<typeof WorkerOtpSendFailedPayload>;

/**
 * The RETENTION signal (§X.6, previously NOT FOUND on the spine): an authenticated worker
 * was active on a given UTC day. This is the denominator every activation/retention question
 * needs — "did the referred worker come back?" — and without it the referral funnel ends at
 * install and goes dark.
 *
 * AT MOST ONCE PER WORKER PER UTC DAY, by construction: the producer keys the events-table
 * idempotency key on `worker.active:<worker_id>:<day>`, so a worker making a thousand requests
 * writes exactly one row. The event is therefore a coarse DAILY-ACTIVE fact, NOT a request
 * log — it deliberately carries no route, no session id, no ip/ip_hash, no user-agent, and no
 * timestamp finer than the day, so it can never be turned into a per-worker movement trace.
 *
 * PII-FREE: the opaque worker id + a `YYYY-MM-DD` UTC day bucket ONLY. `.strict()` blocks
 * smuggling a phone / route / device id alongside.
 */
export const WorkerActivePayload = z
  .object({
    worker_id: uuidSchema,
    /** COARSE UTC day bucket `YYYY-MM-DD` — never a timestamp (that would be a trace). */
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "day must be a UTC day bucket YYYY-MM-DD"),
  })
  .strict();
export type WorkerActivePayload = z.infer<typeof WorkerActivePayload>;

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

/** TD69 — DPDP consent withdrawal (`POST /consent/withdraw`). PII-free: opaque
 * worker id + an aggregate count of sessions revoked, no session ids. */
export const ConsentRevokedPayload = z.object({
  worker_id: uuidSchema,
  sessions_revoked: z.number().int().min(0),
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
  /** Interview topic ids answered so far (e.g. "role", "machines") — never PII.
   * Must be lowercase slugs (a-z, underscore) only — enforced by regex. */
  answered_topics: z
    .array(z.string().min(1).max(40).regex(/^[a-z_]+$/, "topic_id must be lowercase slug ([a-z_]+)"))
    .max(50)
    .default([]),
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
const jobPostingVerificationStatus = z.enum(JOB_POSTING_VERIFICATION_STATUSES);

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
  // ADR-0030 / TAX-6 (ADDITIVE enum member): the posting's skill inputs changed
  // (names only — the PHRASES/ids never enter the payload).
  "skills",
  // ADR-0036 (ADDITIVE enum members, same precedent as "skills" above). Widening the
  // KEY enum is backward-compatible: every shipped payload still validates, and the
  // payload still carries only which field changed, never its value. `match_skills`
  // covers the `mskill_*` selection AND its unticks — they are one editorial act on
  // the form, and splitting them would let a reader infer the untick list's presence.
  // `pay_band` is one key for pay_min+pay_max for the same reason.
  "match_skills",
  "city",
  "pay_band",
  "shift",
  "needed_by",
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

// ---------------------------------------------------------------------------
// job_posting_chat.* — the AI job-posting chat (ADR-0035).
//
// PII-FREE BY CONSTRUCTION, and `.strict()` makes it STRUCTURAL rather than a
// convention: every schema below rejects ANY key it does not name, so a future
// caller cannot smuggle the payer's typed message, a draft field value, or the
// payer's organisation name onto the audit spine. What may appear here is opaque
// ids, the message-type enum — nothing else.
//
// The organisation name deserves its own sentence because it is the one value a
// reviewer might expect to find: the chat NEVER asks for it and the AI service
// never receives it. It is decrypted server-side from `payers.orgNameEnc` and
// stamped onto the create call at publish time (ADR-0035 §Decision 3, the
// AI-PERSONA-2 post-hoc pattern), so it exists on no message, no draft, no
// conversation state, and no payload here.
//
// PUBLISH IS DELIBERATELY ABSENT from this family. It reuses the already-shipped
// `job_posting.created`, emitted by `JobPostingsService.createForPayer` — this
// slice adds no second writer of that event (ADR-0035 §Decision 6).
// ---------------------------------------------------------------------------

/** A payer opened a new AI job-posting chat. Two opaque ids, nothing else. */
export const JobPostingChatSessionStartedPayload = z
  .object({
    session_id: uuidSchema,
    payer_id: uuidSchema,
  })
  .strict();
export type JobPostingChatSessionStartedPayload = z.infer<
  typeof JobPostingChatSessionStartedPayload
>;

/**
 * A message was stored on an AI job-posting chat.
 *
 * ONE event name covers BOTH directions (ADR-0035 §Decision 6 freezes three events
 * for this domain, not four); the ACTOR is what distinguishes them — `payer` for a
 * payer turn, `ai_service` for the engine's reply — exactly the discrimination the
 * worker chat gets from having two names. The direction is therefore never a payload
 * field, and `body_text` never appears in ANY form (raw, hashed, or truncated).
 */
export const JobPostingChatMessageSentPayload = z
  .object({
    session_id: uuidSchema,
    payer_id: uuidSchema,
    message_id: uuidSchema,
    message_type: messageType,
  })
  .strict();
export type JobPostingChatMessageSentPayload = z.infer<typeof JobPostingChatMessageSentPayload>;

/**
 * The deterministic interview engine reported the draft complete — emitted ONCE per
 * session, on the flip. Records the FACT only: which fields were filled, and with
 * what, is never here. Readiness is advisory — the publish step still re-validates
 * the draft against `PayerCreateJobPostingSchema` (invariant #4: the engine assists,
 * it does not decide that a posting may be created).
 */
export const JobPostingChatDraftReadyPayload = z
  .object({
    session_id: uuidSchema,
    payer_id: uuidSchema,
  })
  .strict();
export type JobPostingChatDraftReadyPayload = z.infer<typeof JobPostingChatDraftReadyPayload>;

/**
 * An OPS user set a job posting's TRUST review — the worker-visible "Verified job"
 * badge. Records the transition only: the new [verification_status] and the
 * [previous_status] it moved from. PII-free (id + enums). The lifecycle `status`
 * (draft/open/…) is unaffected and NOT carried here.
 */
export const JobPostingVerificationUpdatedPayload = z.object({
  job_posting_id: uuidSchema,
  verification_status: jobPostingVerificationStatus,
  previous_status: jobPostingVerificationStatus,
});
export type JobPostingVerificationUpdatedPayload = z.infer<
  typeof JobPostingVerificationUpdatedPayload
>;
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
/**
 * Booster tier. ADDITIVE ENUM WIDENING (ADR-0036 §7, same discipline as
 * `PostingPlanStatus` gaining 'paused'): the three new tiers are appended and
 * `all_candidates` STAYS — every shipped `job_posting.boosted` payload still
 * validates, which is what makes this backward-compatible rather than a mutation.
 * `all_candidates` is retired from the OFFERED catalog, not from history.
 */
const BoostTierEnum = z.enum(["all_candidates", "boost_7", "boost_15", "boost_30"]);
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

/**
 * Why a send was suppressed BEFORE reaching the provider (no-PII, internal audit).
 * "pending_deletion" is an ADDITIVE ADR-0031 extension (payer-surface freeze: a worker
 * inside the deletion grace window gets no sends) — every previously-valid payload
 * stays valid, same event, same v1 (consumers: ops console only).
 */
export const MessagingSuppressReasonEnum = z.enum([
  "no_consent",
  "unknown_worker",
  "pending_deletion",
]);

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

/**
 * WHICH transport carried the referral payload across the Play Store round-trip (blocker
 * B4). Firebase Dynamic Links died 2025-08-25; the replacement chain is a self-hosted
 * `/i/<code>` resolver + Play Install Referrer, and this enum is how we measure which leg
 * of that chain actually delivered the attribution:
 *   - "app_link"         the app was already installed and intercepted the verified
 *                        Android App Link (`https://app.badabhai.in/i/<code>`).
 *   - "install_referrer" a fresh install: the code came back via the Play Install
 *                        Referrer (`referrer=bb_code=<code>`) on first run.
 *   - "custom_scheme"    a `badabhai://` deep link (the legacy/fallback leg).
 *   - "unknown"          the client did not (or could not) say — the safe DEFAULT, and
 *                        what every pre-B4 client sends, since `source` is OPTIONAL on the
 *                        wire (invariant #8: old clients keep working unchanged).
 * A CLOSED enum, never free text — so no client-supplied string can ride onto the spine.
 */
export const INVITE_INSTALL_SOURCES = [
  "app_link",
  "install_referrer",
  "custom_scheme",
  "unknown",
] as const;
export const InviteInstallSource = z.enum(INVITE_INSTALL_SOURCES);
export type InviteInstallSource = z.infer<typeof InviteInstallSource>;

/**
 * The install was ACTUALLY ATTRIBUTED — the moment the referral chain closed (blocker B4 /
 * §X.6, previously NOT FOUND on the spine). Emitted at the same instant as the matching
 * `invite.accepted` / `agency_invite.accepted`, and only ever on a SUCCESSFUL attribution,
 * but it answers a different question: *how* the payload survived the Play Store round-trip
 * (`source`). Without it, a broken App Link / Install Referrer leg is invisible — the
 * funnel just silently loses agents.
 *
 * ONE event covers BOTH funnels (worker→worker `invites` and agency→worker `agency_invites`),
 * discriminated by `invite_kind`; the subject carries the matching subject_type, so the two
 * are never conflated on the spine.
 *
 * PII-FREE by construction: the opaque ROW id (`invite_id`) — NEVER the shareable `code`,
 * which `invite.clicked`/`agency_invite.created` also deliberately omit (it is a bearer
 * token: anyone holding it can claim the referral) — plus two closed enums. No phone, no
 * name, no worker id (the attribution join already lives on `*.accepted`). `.strict()` is
 * the structural backstop against smuggling a code/phone alongside.
 */
export const InviteInstallPayload = z
  .object({
    /** The opaque `invites.id` / `agency_invites.id` — never the shareable code. */
    invite_id: uuidSchema,
    invite_kind: z.enum(["worker", "agency"]),
    source: InviteInstallSource,
  })
  .strict();
export type InviteInstallPayload = z.infer<typeof InviteInstallPayload>;

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
 * The payer lifecycle statuses, as they appear on the spine (ADR-0037).
 *
 * A CLOSED enum, and admissible under invariant #2: a lifecycle status is a bounded
 * system value, not PII — unlike the payer's email/org-name/phone, which stay encrypted
 * in `payers` and never reach an event. Mirrors `PayerStatus` in packages/db.
 */
export const PayerStatusEnum = z.enum(["pending", "active", "suspended"]);
export type PayerStatusEnum = z.infer<typeof PayerStatusEnum>;

/**
 * A payer lifecycle transition (ADR-0037) — `payer.activated` / `payer.suspended` /
 * `payer.reinstated`.
 *
 * Carries BOTH ends of the transition, which is the point: "audit every state transition"
 * is unmet by an event that records only that something happened. `previous_status` is
 * what makes a reinstate auditable (it says what the payer was restored TO) and what makes
 * a suspend-from-`pending` distinguishable from a suspend-from-`active` after the fact.
 *
 * FACELESS: the opaque `payer_id` plus two closed enum values. Deliberately NO reason,
 * NO actor detail beyond the envelope's own actor, and NO admin email — the admin action
 * itself is separately recorded by the value-free `admin.action_performed`, and the reason
 * lives on the system-of-record, not the spine.
 */
export const PayerLifecycleTransitionPayload = z
  .object({
    payer_id: uuidSchema,
    previous_status: PayerStatusEnum,
    new_status: PayerStatusEnum,
  })
  // `.strict()` is the STRUCTURAL backstop for the value-free rule, mirroring
  // `AdminActionPerformedPayload`. Without it an extra key is silently STRIPPED rather
  // than rejected, so a caller that started attaching a free-text `reason` (the obvious
  // way a name/email/phone reaches the spine) would look like it was working. Strict
  // makes that a validation failure at the boundary instead of a silent PII channel.
  .strict();
export type PayerLifecycleTransitionPayload = z.infer<typeof PayerLifecycleTransitionPayload>;

/**
 * The INVENTORY side of a payer suspension (ADR-0037 Decision 1) —
 * `payer.inventory_suspended` / `payer.inventory_reinstated`.
 *
 * A payer suspension freezes two independent things: their SESSION (recorded by
 * `payer.suspended` above) and their live JOB INVENTORY (recorded here). They are
 * separate events because they can diverge — a suspension with nothing published moves
 * zero rows — and because "why did this job vanish from the feed?" is a question the
 * session event cannot answer.
 *
 * COUNTS, NOT IDS. The affected postings can number in the hundreds and a per-posting
 * event would flood the spine on a single admin click; the per-row truth already lives on
 * `job_postings.status` / `previous_status` (the system of record), which is where an
 * investigator reads it from. The counts are what make the cascade auditable at a glance:
 * a reinstate whose counts do not match its suspend is the signal that something moved in
 * between.
 *
 * TWO COUNTS, NOT ONE. `job_postings` is the Matching-V1 served entity and `jobs` is the
 * legacy entity that still backs the worker feed and the agency surface (TD37 — both are
 * live). Summing them would hide which surface was actually affected.
 *
 * FACELESS: an opaque `payer_id` plus two non-negative integers. No titles, no org label,
 * no posting ids.
 */
export const PayerInventoryTransitionPayload = z
  .object({
    payer_id: uuidSchema,
    /** `job_postings` rows moved by this cascade (the Matching-V1 served entity). */
    postings_affected: z.number().int().min(0),
    /** `jobs` rows moved by this cascade (the legacy entity still serving the feed). */
    jobs_affected: z.number().int().min(0),
  })
  // `.strict()` for the same reason as the transition payload above: an extra key is the
  // obvious way a role title or org label would reach the spine. Reject, never strip.
  .strict();
export type PayerInventoryTransitionPayload = z.infer<typeof PayerInventoryTransitionPayload>;

/**
 * A login code was RESERVED but deliberately NOT DELIVERED (ADR-0037 Decision 5) —
 * `payer.otp_suppressed`.
 *
 * This is the security/audit record for a login attempt on a suspended account. It is the
 * ONLY place that attempt is visible: the HTTP response is deliberately identical to a
 * normal one (no enumeration), and no `payer.login_requested` is emitted, because no login
 * code was actually sent — counting it as one would overstate the login funnel and hide
 * repeated probing of a banned account behind ordinary traffic.
 *
 * `reason` is a CLOSED enum, never free text. A free-text reason on an auth event is
 * exactly how an operator note naming a person reaches the spine.
 */
export const PayerOtpSuppressedPayload = z
  .object({
    payer_id: uuidSchema,
    reason: z.enum(["account_suspended"]),
  })
  .strict();
export type PayerOtpSuppressedPayload = z.infer<typeof PayerOtpSuppressedPayload>;

/**
 * A real payment was captured and credited for a SUSPENDED payer (ADR-0037 Decision 6) —
 * `payer.suspended_payment_captured`. An OPS ALERT for Finance/Admin review, not a rejection.
 *
 * The money was already taken by Razorpay before this webhook arrived, and the codebase has
 * NO refund path. Refusing to credit it would leave the platform holding funds with no
 * ledger entry against them — a worse outcome than crediting an account that cannot spend
 * (every spending route is behind `PayerAuthGuard`, which requires `active`). So the credit
 * is applied as designed and a human is told.
 *
 * Carries the ORDER id, not the amount: the amount already lives on `payment.captured` and
 * on the `credit_ledger` row keyed to the same order, so repeating it here would create a
 * second place for the money to be stated — and to disagree.
 */
export const PayerSuspendedPaymentCapturedPayload = z
  .object({
    payer_id: uuidSchema,
    /** The internal `payment_orders` row id — the join key to the amount + pack. */
    order_id: uuidSchema,
  })
  .strict();
export type PayerSuspendedPaymentCapturedPayload = z.infer<
  typeof PayerSuspendedPaymentCapturedPayload
>;

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

/** A member's role within a payer org (ADR-0027 / B5). Enum-only → no PII. */
export const OrgRoleEnum = z.enum(["owner", "recruiter"]);
export type OrgRoleEnum = z.infer<typeof OrgRoleEnum>;

/**
 * A teammate was INVITED to a payer org (ADR-0027 / B5). `member_id` is the opaque
 * `payer_members` row id; `invited_by` is the acting owner. The invitee's EMAIL is NOT here
 * (it lives encrypted in `payer_members`), nor is the invite token (a bearer secret — only its
 * hash is stored). ids + the org_role enum ONLY.
 */
export const PayerMemberInvitedPayload = z.object({
  member_id: uuidSchema,
  org_id: uuidSchema,
  org_role: OrgRoleEnum,
  invited_by: uuidSchema,
});
export type PayerMemberInvitedPayload = z.infer<typeof PayerMemberInvitedPayload>;

/**
 * A teammate ACCEPTED an org invite (ADR-0027 / B5.4) — the invited row went `active` and was
 * bound to `member_payer_id` (the accepting payer). ids ONLY — no email/PII, no invite token
 * (the bearer secret is consumed on accept, never emitted).
 */
export const PayerMemberAcceptedPayload = z.object({
  member_id: uuidSchema,
  org_id: uuidSchema,
  member_payer_id: uuidSchema,
});
export type PayerMemberAcceptedPayload = z.infer<typeof PayerMemberAcceptedPayload>;

/**
 * A teammate was REMOVED from a payer org (ADR-0027 / B5) — soft-deleted (status='removed').
 * `removed_by` is the acting owner. ids ONLY (no email/PII).
 */
export const PayerMemberRemovedPayload = z.object({
  member_id: uuidSchema,
  org_id: uuidSchema,
  removed_by: uuidSchema,
});
export type PayerMemberRemovedPayload = z.infer<typeof PayerMemberRemovedPayload>;

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

/**
 * `jobs` lifecycle status (mirrors db.JobStatus). Enum → no PII.
 *
 * WIDENED, not changed (ADR-0037): `suspended` joins the existing two. Every payload that
 * validated before still validates — this only admits a value the producers could not
 * previously emit — so `job.*` stays v1 (invariant #8 forbids MUTATING a shipped payload,
 * not extending an enum in the accepting direction).
 *
 * Keeping the mirror exact is the point: this enum's job is to be db.JobStatus, and a
 * mirror that silently omits a value the column can hold would make a legitimate emit fail
 * validation at runtime rather than at compile time.
 */
export const JobStatusEnum = z.enum(["open", "closed", "suspended"]);
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
  // ADR-0024 final addendum (2026-07-16) — ADDITIVE enum members (the TAX-6
  // "skills" precedent above: widening the key enum is backward-compatible, no
  // version bump): the four worker-visible content columns joined `jobs`. KEYS
  // only — the screened free text (description / benefits / requirements items)
  // NEVER enters a payload.
  "description",
  "shift",
  "benefits",
  "requirements",
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
// Worker-facing notification events (TD64). These are per-worker events emitted at
// trigger points throughout the platform and consumed by the worker's notification
// feed (GET /workers/me/notifications). PII-FREE: opaque worker_id + coarse non-PII
// bands only (trade slug, city label). Copy is server-rendered from static
// allowlist — the event payload is NEVER passed through.
// ---------------------------------------------------------------------------

/** Per-worker notification: a kit for the worker's confirmed trade is ready. */
export const InterviewKitReadyForWorkerPayload = z.object({
  worker_id: uuidSchema,
  trade_key: tradeKeySchema,
  content_version: contentVersionSchema,
  kit_id: kitIdSchema,
}); // .strict() intentionally omitted — the test introspects payload.shape

/** Per-worker notification: a new job matching the worker's trade/city was posted. */
export const NewJobAvailablePayload = z.object({
  worker_id: uuidSchema,
  job_id: uuidSchema,
  trade_key: tradeKeySchema,
  city: cityLabelSchema,
});

/** Per-worker notification: a payer viewed the worker's profile. */
export const ProfileViewedPayload = z.object({
  worker_id: uuidSchema,
  viewer_payer_id: uuidSchema,
  job_id: uuidSchema,
});

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
 * ORGANIC vs PAID. Selects which match window a click is judged under (7d vs 24h by
 * default, both config). Snapshotted onto the click so a later re-tag of the link cannot
 * retroactively re-judge a click that already happened.
 *
 * DECLARED HERE, above its first use, because TWO payload families now share it: the
 * agency invite funnel (`agency_invite.created`, immediately below) and the B4 referral
 * link/click payloads further down. One declaration, so the two code spaces cannot drift
 * into different notions of "medium" — the same reason the DB gives `agency_invites` and
 * `referral_links` a byte-identical CHECK.
 */
export const ReferralLinkMediumEnum = z.enum(["organic", "paid"]);

/**
 * An agency minted a referral deep-link (`/i/<code>`). `inviter_payer_id` is the opaque
 * owning agency; the opaque `code` itself is NOT carried (it is a shareable secret).
 * Optional non-PII campaign tag only.
 *
 * W1 ADDED `medium` AND `payload_keys` — both ADDITIVE and OPTIONAL, so this stays v1 and
 * every existing consumer keeps parsing unchanged (invariant #8; the schema was never
 * `.strict()`, and is deliberately left non-strict here for that same backward tolerance).
 *
 * `medium` is a closed enum — it is the match-window discriminator, so a funnel query has
 * to be able to segment on it or the window arithmetic is unauditable after the fact.
 *
 * `payload_keys` CARRIES KEY NAMES, NEVER VALUES. The values (role/city slugs) live on
 * `agency_invites.payload` and stop there.
 *
 * THE ASYMMETRY WITH `campaign` IS DELIBERATE, not an oversight: `campaign` is a single
 * scalar with a long ADR-0020 precedent and a screen that has been tightened twice, whereas
 * the context object is a NEW, WIDER, agency-writable jsonb surface. A wider surface starts
 * closed on the audit spine and is widened on evidence — emitting the key names is enough
 * to answer "is anyone actually using this, and with what fields?", which is the only
 * question the spine needs to answer before the values are ever considered. Promoting
 * values to the payload later is an additive change; retracting them from a permanent audit
 * record is not.
 */
export const AgencyInviteCreatedPayload = z.object({
  agency_invite_id: uuidSchema,
  inviter_payer_id: uuidSchema,
  channel: MessageChannelEnum,
  campaign: z.string().min(1).max(64).optional(),
  medium: ReferralLinkMediumEnum.optional(),
  // Sorted, deduped key names of the stored deep-link context. Bounded by the closed DTO
  // shape (`InviteContextSchema` admits two keys), with headroom left for a reviewed
  // widening. Omitted entirely when no context was supplied — an empty array and "no
  // context" would otherwise be indistinguishable.
  payload_keys: z.array(z.string().min(1).max(32)).max(8).optional(),
});
export type AgencyInviteCreatedPayload = z.infer<typeof AgencyInviteCreatedPayload>;

/**
 * An agency referral deep-link was OPENED (TD113). The payer-axis sibling of
 * `invite.clicked` — the agency funnel shipped `created`/`accepted` but no `clicked`, so
 * the middle of the funnel had no event at all even though the agency's own stage COUNTS
 * already tracked it. Adding it (rather than reusing `invite.clicked`) keeps the two
 * funnels distinguishable on the spine: the inviter is a PAYER here, not a worker.
 *
 * Emitted from the PUBLIC click path — the invited worker is the only party who can
 * actually click, so this is NOT owner-scoped and is NEUTRAL on an unknown code (an
 * unknown code emits nothing at all, which is what keeps the endpoint from being an
 * existence oracle).
 *
 * PII-FREE: the opaque row id + the opaque owning agency + the channel enum. NEVER the
 * shareable `code` (a bearer token), never a worker handle — a click happens BEFORE the
 * DPDP consent gate, so no worker identity may be recorded here (invariant #6);
 * `agency_invite.accepted` is the only agency event that carries a worker id. `.strict()`.
 */
export const AgencyInviteClickedPayload = z
  .object({
    agency_invite_id: uuidSchema,
    inviter_payer_id: uuidSchema,
    channel: MessageChannelEnum,
  })
  .strict();
export type AgencyInviteClickedPayload = z.infer<typeof AgencyInviteClickedPayload>;

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
// agency_kyc.* — AGENCY financial-KYC lifecycle (ADR-0022 module 1, Amendment 2).
//
// FINANCIAL-PII-FREE ON THE SPINE (CLAUDE.md invariant #2): the PAN / bank account / IFSC /
// account-holder-name live encrypted ONLY in `agency_kyc` (ADR-0004 discipline) and MUST
// NEVER appear here. The ONLY tokens are the opaque agency `payer_id`, the `status` enum,
// and (for ops actions) the opaque `verified_by` admin id + a reject-reason CODE. `.strict()`
// STRUCTURALLY rejects any extra (potentially PII-shaped) key at validation time.
// ---------------------------------------------------------------------------
/** Bounded reject-reason CODES (never a free-form note that could carry PII). */
export const AgencyKycRejectReason = z.enum([
  "invalid_pan",
  "invalid_bank",
  "name_mismatch",
  "duplicate",
  "other",
]);
export type AgencyKycRejectReason = z.infer<typeof AgencyKycRejectReason>;

export const AgencyKycSubmittedPayload = z
  .object({
    payer_id: uuidSchema,
    status: z.literal("pending"),
  })
  .strict();
export type AgencyKycSubmittedPayload = z.infer<typeof AgencyKycSubmittedPayload>;

// verify/reject are ops actions (the shared-secret `ops` principal — apps/web ops console via
// InternalServiceGuard); WHO acted is the envelope `actor` (actor_type: "ops"), so the payload
// carries no per-person id (there is none on the ops path today). payer_id + reason CODE only.
export const AgencyKycVerifiedPayload = z
  .object({
    payer_id: uuidSchema,
  })
  .strict();
export type AgencyKycVerifiedPayload = z.infer<typeof AgencyKycVerifiedPayload>;

export const AgencyKycRejectedPayload = z
  .object({
    payer_id: uuidSchema,
    reason: AgencyKycRejectReason,
  })
  .strict();
export type AgencyKycRejectedPayload = z.infer<typeof AgencyKycRejectedPayload>;

// ---------------------------------------------------------------------------
// agency_payout.* — AGENCY commission payout lifecycle (ADR-0022 modules 3+7, Amendment 2).
//
// PII-FREE: ₹ amounts (whole rupees, integer — never paise) + opaque ids + a reason CODE
// only. MOCK — `agency_payout.paid` is INERT (no real disbursement; real outbound money is
// the §7 launch gate). `.strict()` rejects any extra key.
// ---------------------------------------------------------------------------
export const AgencyPayoutAccruedPayload = z
  .object({
    agency_payer_id: uuidSchema,
    unlock_id: uuidSchema, // the granted unlock (the revenue event) this accrues on
    amount_inr: z.number().int().nonnegative(),
    basis_inr: z.number().int().nonnegative(),
    rate_bps: z.number().int().nonnegative(),
  })
  .strict();
export type AgencyPayoutAccruedPayload = z.infer<typeof AgencyPayoutAccruedPayload>;

export const AgencyPayoutRequestedPayload = z
  .object({
    agency_payer_id: uuidSchema,
    payout_request_id: uuidSchema,
    amount_inr: z.number().int().nonnegative(),
    accrual_count: z.number().int().nonnegative(),
  })
  .strict();
export type AgencyPayoutRequestedPayload = z.infer<typeof AgencyPayoutRequestedPayload>;

/** Why a payout request was refused at the gate (a CODE — no PII, no free text). */
export const AgencyPayoutBlockedReason = z.enum([
  "kyc_not_verified",
  "below_threshold",
  "disabled",
]);
export type AgencyPayoutBlockedReason = z.infer<typeof AgencyPayoutBlockedReason>;

export const AgencyPayoutBlockedPayload = z
  .object({
    agency_payer_id: uuidSchema,
    reason: AgencyPayoutBlockedReason,
    amount_inr: z.number().int().nonnegative(), // pending ₹ at block time (audit)
  })
  .strict();
export type AgencyPayoutBlockedPayload = z.infer<typeof AgencyPayoutBlockedPayload>;

export const AgencyPayoutPaidPayload = z
  .object({
    agency_payer_id: uuidSchema,
    payout_request_id: uuidSchema,
    amount_inr: z.number().int().nonnegative(),
  })
  .strict();
export type AgencyPayoutPaidPayload = z.infer<typeof AgencyPayoutPaidPayload>;

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

/**
 * A skill phrase missed the canonicalization confidence floor and was recorded to the
 * `unresolved_phrase` growth queue (ADR-0030 / FORK-B-1 seam A). PII-FREE BY CONSTRUCTION:
 * the phrase itself (already pseudonymized, SG-1) is NOT carried — only its sha256 hex
 * `phrase_hash` (correlate-able, never reversible), the skill domain, the language tag,
 * and the row's occurrence `count` after the upsert. `.strict()` blocks smuggling the text.
 */
export const SkillPhraseUnresolvedPayload = z
  .object({
    phrase_hash: z.string().regex(/^[0-9a-f]{64}$/),
    domain_id: z.string().min(1),
    lang: z.string().min(2).max(8),
    count: z.number().int().positive(),
  })
  .strict();
export type SkillPhraseUnresolvedPayload = z.infer<typeof SkillPhraseUnresolvedPayload>;

// ---------------------------------------------------------------------------
// referral.* — the WORKER-referral activation bonus (blocker B4 / §X.6).
//
// The single most valuable referral fraud control in the plan: the ₹20 is accrued ONLY
// when a referred worker completes a profile AND is unlocked by a paying party. Both legs
// are things a fraudster cannot manufacture for free, which kills the referral-farm
// economics before they start — so the ACCRUAL is the event worth recording, and there is
// deliberately no event on click / install / upload (those prove nothing).
//
// MOCK LEDGER, NO DISBURSEMENT: nothing pays out in this release (mirrors `agency_payout.*`
// and the ADR-0022 posture — real outbound money is the §7 launch gate). There is
// deliberately NO `referral.bonus_paid` event: an event name is a promise, and adding one
// before a ratified payout rail would imply a capability that does not exist.
//
// PII-FREE: opaque accrual/worker ids + a whole-rupee integer ONLY. The fraud checks read
// `workers.phone_hash`, and that hash NEVER appears here (or in any log) — a hash tied to
// two worker ids in one payload would be a re-identification join. The disqualify REASON is
// likewise not carried: nothing is emitted at all when a bonus is refused.
// ---------------------------------------------------------------------------

/**
 * A referred worker QUALIFIED and the ₹20 activation bonus was accrued to their inviter.
 * Emitted EXACTLY ONCE per referred worker, ever — enforced by the UNIQUE constraint on
 * `referral_bonus_accruals.invited_worker_id` (the row is the idempotency key; no row
 * written ⇒ no event), not by a best-effort check.
 *
 * `amount_inr` is WHOLE RUPEES (integer — never paise, matching `agency_payout.*`).
 * `.strict()` rejects any extra key, so a phone_hash / reason string / name can never ride
 * along.
 */
export const ReferralBonusAccruedPayload = z
  .object({
    /** The opaque `referral_bonus_accruals.id` (also the event subject). */
    accrual_id: uuidSchema,
    /** The worker who is OWED the bonus (opaque). */
    inviter_worker_id: uuidSchema,
    /** The referred worker who QUALIFIED (opaque). */
    invited_worker_id: uuidSchema,
    amount_inr: z.number().int().positive(),
  })
  .strict();
export type ReferralBonusAccruedPayload = z.infer<typeof ReferralBonusAccruedPayload>;

// ---------------------------------------------------------------------------
// B4 ATTRIBUTION — the `referral_links` resolver primitive.
//
// THE `code` NEVER APPEARS IN ANY OF THESE PAYLOADS. It is a BEARER TOKEN: anyone
// holding it can claim the referral, and the events table is read by the ops console.
// Every payload carries the opaque `referral_link_id` row id instead — exactly the rule
// `invite.clicked` and `InviteInstallPayload` already follow. `.strict()` on all three is
// the structural backstop that stops a code/phone/IP being smuggled alongside.
//
// PII-FREE otherwise by construction: opaque uuids, closed enums, integer hours. The
// click's `click_hash` (a keyed HMAC over ip+UA) is deliberately ALSO absent — it is a
// storage-side de-duplication key, not something the audit spine needs.
// ---------------------------------------------------------------------------

/** The link's owner axis — which commission channel a click belongs to. */
export const ReferralLinkKindEnum = z.enum(["agent", "worker", "campaign"]);

// `ReferralLinkMediumEnum` (organic | paid) is declared ABOVE, next to
// `AgencyInviteCreatedPayload` — the agency funnel needs it earlier in the file and both
// families must share one declaration. It is used unchanged by the three payloads below.

/** Coarse device class of a click. Diagnostics only — deliberately not a fingerprint. */
export const ReferralClickPlatformEnum = z.enum(["android", "desktop", "other"]);

/** A shareable referral link was minted (agent code, worker share, campaign URL, or QR). */
export const ReferralLinkCreatedPayload = z
  .object({
    /** The opaque `referral_links.id` (also the event subject). NEVER the code. */
    referral_link_id: uuidSchema,
    kind: ReferralLinkKindEnum,
    medium: ReferralLinkMediumEnum,
    /** Stable non-PII campaign tag, when this is a campaign link. */
    campaign_id: z.string().min(1).max(64).optional(),
  })
  .strict();
export type ReferralLinkCreatedPayload = z.infer<typeof ReferralLinkCreatedPayload>;

/**
 * A referral link was RESOLVED by `GET /r/:code` — one row in the click log.
 *
 * Emitted for a link that resolved to a `referral_links` row only; a legacy
 * `invites`/`agency_invites` code keeps emitting its own `invite.clicked` /
 * `agency_invite.clicked` (no double-count on the spine).
 */
export const ReferralLinkClickedPayload = z
  .object({
    referral_link_id: uuidSchema,
    medium: ReferralLinkMediumEnum,
    platform: ReferralClickPlatformEnum,
  })
  .strict();
export type ReferralLinkClickedPayload = z.infer<typeof ReferralLinkClickedPayload>;

/**
 * A click WON a worker's first-touch claim — the moment attribution actually closes.
 *
 * Answers the question the funnel could not answer before: not just "was this worker
 * attributed" (`invite.accepted` already says that) but "which click earned it, how old
 * was that click, and which window admitted it". `age_hours` + `window_hours` together
 * make a mis-tuned window visible in the data instead of silently dropping referrals.
 *
 * Emitted at most ONCE per worker, ever — enforced by the partial unique index on
 * `referral_clicks.claimed_by_worker_id`, not by this emitter.
 */
export const ReferralInstallClaimedPayload = z
  .object({
    referral_link_id: uuidSchema.nullable(),
    /** The worker who claimed (opaque). */
    worker_id: uuidSchema,
    medium: ReferralLinkMediumEnum,
    /** Which leg of the post-Dynamic-Links chain delivered the code. */
    source: InviteInstallSource,
    /** How old the winning click was at claim time (whole hours, floored). */
    age_hours: z.number().int().nonnegative(),
    /** The window that admitted it — the config value in force at claim time. */
    window_hours: z.number().int().positive(),
  })
  .strict();
export type ReferralInstallClaimedPayload = z.infer<typeof ReferralInstallClaimedPayload>;

// ---------------------------------------------------------------------------
// Matching V1 (ADR-0036, spec docs/specs/matching-algorithm-v1.md).
//
// PII-FREE BY CONSTRUCTION, and narrower than that: these payloads carry opaque
// worker/posting/payer uuids, CLOSED-VOCABULARY `mskill_*` ids, integer counts and
// small enums. There is no employer name, no worker identity beyond the uuid, no pay
// figure, and no free text anywhere. Every one is `.strict()`, so a future field
// cannot be smuggled in without a review.
//
// INVARIANT #4: nothing here is a model output. `match_tier` is set membership, the
// counts are SQL aggregates, and the ordering these events describe is the fixed
// lexicographic rank key in `@badabhai/match-engine`. No LLM produces or reads them.
// ---------------------------------------------------------------------------

/** A closed-set Matching V1 skill id (`mskill_*`). Never free text. */
const matchSkillIdSchema = z.string().regex(/^mskill_[a-z0-9_]+$/);

/**
 * MOMENT ①/② — a worker's matchable supply was re-derived from his latest profile and
 * his rows in `job_reach` were reconciled against every live posting.
 *
 * COUNTS ONLY, NEVER THE SKILL LIST. The vocabulary is public, but a per-worker skill
 * array on the audit spine is a supply profile with no reader — and `worker_skill` is
 * already the queryable source of truth for it (put the FACT on the spine, not the
 * data). `skill_count: 0` is a legitimate and useful record: it is exactly the E17
 * "one-tag worker" / `avg_skill_tags_per_worker` signal.
 */
export const WorkerMatchSkillsRebuiltPayload = z
  .object({
    worker_id: uuidSchema,
    /** How many `derived_coarse` rows the rebuild produced (0 is legitimate). */
    skill_count: z.number().int().nonnegative(),
    /** How many industries he now has tenure in. */
    industry_count: z.number().int().nonnegative(),
    /** How many open/paused postings can reach him after reconciliation. */
    reached_postings: z.number().int().nonnegative(),
  })
  .strict();
export type WorkerMatchSkillsRebuiltPayload = z.infer<typeof WorkerMatchSkillsRebuiltPayload>;

/**
 * MOMENT ③ — a posting's reach set was materialized into `job_reach` (on publish, on
 * unpause, on an edit, or on an ops widen). The audit record of "who could this posting
 * reach, and how wide was the net when we decided that".
 *
 * `reach_skill_count >= match_skill_count` always (reach ⊇ posted, spec Part 2). The two
 * tier counts let an analyst reconstruct the E12/E18 picture later without re-running the
 * materializer against a `job_reach` table that has since moved.
 */
export const JobPostingReachMaterializedPayload = z
  .object({
    job_posting_id: uuidSchema,
    /** Skills the company actually typed (TIER 1 is membership of these). */
    match_skill_count: z.number().int().nonnegative(),
    /** Posted ∪ curated related ⊖ the company's honoured unticks. */
    reach_skill_count: z.number().int().nonnegative(),
    /** Related skills the company unticked and we honoured (Policy 10 audit trail). */
    unticked_count: z.number().int().nonnegative(),
    /** Workers reached, total and by tier. `reach_total = reach_tier1 + reach_tier2`. */
    reach_total: z.number().int().nonnegative(),
    reach_tier1: z.number().int().nonnegative(),
    reach_tier2: z.number().int().nonnegative(),
    /** Which write produced this set. */
    trigger: z.enum(["publish", "unpause", "ops_widen", "edit"]),
  })
  .strict();
export type JobPostingReachMaterializedPayload = z.infer<typeof JobPostingReachMaterializedPayload>;

/**
 * E12/E13 OPS ALERT — a posting went live into a void, or into a void of the trade it
 * actually asked for.
 *
 *   `zero_reach`     total reach is 0. "Never take money for a posting into a void"
 *                    (E13). The form warns before payment; this is the server-side
 *                    re-check at publish, so a client that skipped the preview cannot
 *                    make the alert disappear.
 *   `no_tier1_reach` nobody holds a POSTED skill; every reachable worker got there via a
 *                    related one (E12 — reach falls to the related skills). The posting
 *                    works, but ops should know the exact trade is unsupplied.
 *
 * IDS AND COUNTS ONLY — no org label, no role title, no worker. Deliberately NOT a PACE
 * event: PACE auto-WIDENS, which V1 forbids (a company's approved reach set is frozen;
 * only an audited ops action may widen it — Policy 27).
 */
export const JobPostingReachAlertPayload = z
  .object({
    job_posting_id: uuidSchema,
    reason: z.enum(["zero_reach", "no_tier1_reach"]),
    reach_total: z.number().int().nonnegative(),
    reach_tier1: z.number().int().nonnegative(),
    /** How many skills were in the net when it came up short. */
    reach_skill_count: z.number().int().nonnegative(),
  })
  .strict();
export type JobPostingReachAlertPayload = z.infer<typeof JobPostingReachAlertPayload>;

/**
 * POLICY 27 — "Ops may widen a reach set, never narrow one. Expiring, audited, evented."
 * This is the EVENTED half; the audited half is the ops actor on the envelope.
 *
 * The payload names the skills ADDED (closed-vocabulary ids, so a reviewer can read the
 * decision) plus the before/after reach counts, which is what makes "did widening this
 * actually help?" answerable later. Narrowing is structurally impossible on this path —
 * the service appends and re-materializes; it never removes an id.
 */
export const JobPostingReachWidenedPayload = z
  .object({
    job_posting_id: uuidSchema,
    /** The `mskill_*` ids appended to `reach_skill_ids`. Never a posted skill. */
    added_skill_ids: z.array(matchSkillIdSchema).min(1),
    reach_before: z.number().int().nonnegative(),
    reach_after: z.number().int().nonnegative(),
  })
  .strict();
export type JobPostingReachWidenedPayload = z.infer<typeof JobPostingReachWidenedPayload>;

/**
 * A boost purchase was REFUSED because the posting's matched supply is below
 * `match_config.boost_supply_floor` (ADR-0036 §7). Selling a ₹999 boost into a trade
 * with four workers costs the ₹999 AND the renewal behind it, so the refusal is a
 * product fact worth recording, not just a 4xx.
 *
 * PII-free & faceless: opaque payer/posting ids, the tier CODE, two integers.
 */
export const JobPostingBoostRefusedPayload = z
  .object({
    job_posting_id: uuidSchema,
    payer_id: uuidSchema,
    tier: z.string().min(1),
    reason: z.literal("supply_below_floor"),
    reach_total: z.number().int().nonnegative(),
    supply_floor: z.number().int().nonnegative(),
  })
  .strict();
export type JobPostingBoostRefusedPayload = z.infer<typeof JobPostingBoostRefusedPayload>;

/**
 * A payer's unlock-credit balance hit EXACTLY ZERO on a debit.
 *
 * This is the signal the whole conversion engine fires on, so it is exact rather than
 * approximate: it is emitted from the debit path using the balance the debit RETURNED
 * (never a re-read, which would race a concurrent debit), and only on the `>0 → 0`
 * transition. The emit carries an idempotency key derived from the debiting unlock, so
 * an at-least-once retry of the same debit records it once.
 *
 * FACELESS: the opaque `payer_id` only. No email, no org name, no worker.
 */
export const PayerCreditsExhaustedPayload = z
  .object({
    payer_id: uuidSchema,
    /** The debit that took the balance to zero (opaque `unlocks.id`), when known. */
    unlock_id: uuidSchema.nullable().default(null),
    /** The free-tier grant this payer started with — the quota that just ran out. */
    free_tier_credits: z.number().int().nonnegative(),
  })
  .strict();
export type PayerCreditsExhaustedPayload = z.infer<typeof PayerCreditsExhaustedPayload>;

/**
 * MOMENT ④ — `feed.shown`, VERSION 2 (ADR-0036 "feed.shown gets a v2 payload").
 *
 * WHY A NEW NAME AND NOT A VERSION BUMP IN PLACE. Invariant #8 forbids mutating a
 * shipped payload, and `validateEvent` enforces EXACTLY ONE version per event name — so
 * bumping `feed.shown` to 2 would invalidate every already-shipped emitter (the legacy
 * `/feed`, the ops `/reach/*` views, `/payer/reach/*`) the moment it deployed, including
 * on a database where `MATCH_V1_ENABLED` is still false. A SECOND registry entry keeps
 * the shipped v1 shape alive, unmodified, as history — exactly what the ADR asks for —
 * and lets both regimes coexist across the cutover boundary (the offline LEARN corpus
 * will contain both). The registry `version: 2` records which payload GENERATION this is.
 *
 * WHAT CHANGED. `score` and `hot` are GONE: V1 has no score at the visibility layer at
 * all (spec Part 2 — "Nothing is hidden by score. There is no score at this layer"), and
 * `hot` was a weighted-engine concept ADR-0036 retires. `match_tier` and `boosted`
 * replace them — the two facts that explain why this card is here and why it is where it
 * is. `job_posting_id` (not `job_id`) names the served entity honestly.
 */
export const FeedShownV2Payload = z
  .object({
    worker_id: uuidSchema,
    /** The SERVED entity — `job_postings.id`, never the legacy `jobs.id`. */
    job_posting_id: uuidSchema,
    /** 1-based position in the worker's feed, AFTER the max-2-per-company interleave. */
    rank: z.number().int().positive(),
    /** 1 = holds a posted skill · 2 = reached through a curated related skill (E18). */
    match_tier: z.union([z.literal(1), z.literal(2)]),
    /** Whether an active boost lifted this card. Boost NEVER adds a card (Policy 13). */
    boosted: z.boolean().default(false),
    /** The skill that earned the match — a closed-set id, the E18 badge's source. */
    matched_skill_id: matchSkillIdSchema,
  })
  .strict();
export type FeedShownV2Payload = z.infer<typeof FeedShownV2Payload>;
