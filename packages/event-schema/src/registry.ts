import type { z } from "zod";
import type { EventDomain } from "./enums";
import * as p from "./payloads";

/**
 * The event registry is the single source of truth for every event the platform
 * may emit. Each entry pins the current schema `version` and the Zod `payload`
 * schema for that version.
 *
 * Versioning strategy (Phase 1): one current version per event name. When a
 * payload must change incompatibly, bump the version here and keep the old
 * schema available behind a versioned map (see `docs/decisions`). For now we
 * keep it intentionally simple.
 */
export interface EventDefinition<TPayload extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly version: number;
  readonly domain: EventDomain;
  readonly payload: TPayload;
}

export const EVENT_REGISTRY = {
  "worker.created": { version: 1, domain: "worker", payload: p.WorkerCreatedPayload },
  "worker.otp_requested": { version: 1, domain: "worker", payload: p.WorkerOtpRequestedPayload },
  "worker.otp_verified": { version: 1, domain: "worker", payload: p.WorkerOtpVerifiedPayload },
  // D-3 — a session minted via the GATED test-login seam (staging smoke / e2e only;
  // TEST_LOGIN_ENABLED, structurally impossible in production). Deliberately DISTINCT
  // from worker.otp_verified so a test mint is always distinguishable on the spine.
  "worker.test_login": { version: 1, domain: "worker", payload: p.WorkerTestLoginPayload },
  "worker.name_recorded": { version: 1, domain: "worker", payload: p.WorkerNameRecordedPayload },
  "worker.resume_prefs_updated": {
    version: 1,
    domain: "worker",
    payload: p.WorkerResumePrefsUpdatedPayload,
  },
  // ADR-0032 — profile photo lifecycle. Payloads are worker_id ONLY (the photo is
  // PII at rest in Storage; keys/URLs never enter the event spine).
  "worker.photo_uploaded": {
    version: 1,
    domain: "worker",
    payload: p.WorkerPhotoUploadedPayload,
  },
  "worker.photo_removed": {
    version: 1,
    domain: "worker",
    payload: p.WorkerPhotoRemovedPayload,
  },
  // ADR-0026 Phase 1 — opaque rotating-refresh-token reuse detection + logout-all.
  // PII-FREE: opaque worker/family ids + a count only (never the refresh token value
  // or its sha256, never a phone). Routine token rotation is NOT emitted (it is not a
  // material state change and would flood the events spine) — only the security-material
  // facts (a replayed used token, a full logout-all) are recorded. All v1.
  "worker.refresh_reuse_detected": {
    version: 1,
    domain: "worker",
    payload: p.WorkerRefreshReuseDetectedPayload,
  },
  "worker.logged_out_all": {
    version: 1,
    domain: "worker",
    payload: p.WorkerLoggedOutAllPayload,
  },
  // ADR-0026 Phase 2 — trusted-device binding. PII-FREE: opaque worker id + the device
  // ROW uuid ONLY (never the device_hash, the raw client device id, the push_token, or
  // platform/model/app_version). `device_registered` fires once per NEW device on a
  // fresh OTP login; `device_revoked` fires when a worker revokes a device. v1.
  "worker.device_registered": {
    version: 1,
    domain: "worker",
    payload: p.WorkerDeviceRegisteredPayload,
  },
  // ADR-0034 — worker push notifications. NOTE: these two must NEVER be added to
  // NOTIFICATION_TEMPLATES. A push emits an event; if that event were itself pushable
  // the fan-out would push -> emit -> push forever. A test pins the disjointness.
  "worker.push_sent": {
    version: 1,
    domain: "worker",
    payload: p.WorkerPushSentPayload,
  },
  "worker.push_send_failed": {
    version: 1,
    domain: "worker",
    payload: p.WorkerPushSendFailedPayload,
  },
  "worker.device_revoked": {
    version: 1,
    domain: "worker",
    payload: p.WorkerDeviceRevokedPayload,
  },
  // ADR-0026 Phase 3 — device-bound unlock PIN. PII-FREE: opaque worker id + the device
  // ROW uuid (the same handle the `device_*` events carry) + bounded ints/bools ONLY —
  // never the PIN, the pin_hash, the throttle state, the raw device fingerprint, or a
  // phone. `pin_set` fires on set/reset; `pin_verified`/`pin_verify_failed` on a verify;
  // `pin_locked` when a lockout cycle escalates (force_otp at the final cycle); `pin_reset`
  // on the OTP-gated reset. All v1.
  "worker.pin_set": {
    version: 1,
    domain: "worker",
    payload: p.WorkerPinSetPayload,
  },
  "worker.pin_verified": {
    version: 1,
    domain: "worker",
    payload: p.WorkerPinVerifiedPayload,
  },
  "worker.pin_verify_failed": {
    version: 1,
    domain: "worker",
    payload: p.WorkerPinVerifyFailedPayload,
  },
  "worker.pin_locked": {
    version: 1,
    domain: "worker",
    payload: p.WorkerPinLockedPayload,
  },
  "worker.pin_reset": {
    version: 1,
    domain: "worker",
    payload: p.WorkerPinResetPayload,
  },
  // ADR-0026 Phase 5 — DPDP worker-initiated account deletion. PII-FREE: opaque worker id +
  // non-negative counts/flags ONLY (sessions/devices revoked, storage objects deleted/failed,
  // had_pin). Never a phone, phone_hash, name, device hash, resume key, or OTP code. Emitted
  // AFTER the hard-delete (the actor_id is opaque, no FK to the gone row), so it is the durable
  // record of the erasure. v1.
  "worker.account_deleted": {
    version: 1,
    domain: "worker",
    payload: p.WorkerAccountDeletedPayload,
  },
  // ADR-0031 — 7-day deletion grace window (amends ADR-0026 Phase 5 D1/D2/D4). Confirm now
  // SCHEDULES the erasure instead of executing it: this event records the schedule (opaque
  // worker_id + the due timestamp — no PII). worker.account_deleted above remains the FINAL
  // erasure record, emitted by the sweep once the grace elapses. First *_scheduled/_cancelled
  // pair in the registry (paired-verb precedent: job_posting.paused/resumed). v1.
  "worker.deletion_scheduled": {
    version: 1,
    domain: "worker",
    payload: p.WorkerDeletionScheduledPayload,
  },
  // ADR-0031 — the worker cancelled the pending deletion during grace (explicit action only —
  // login never auto-cancels). Opaque worker_id only. v1.
  "worker.deletion_cancelled": {
    version: 1,
    domain: "worker",
    payload: p.WorkerDeletionCancelledPayload,
  },
  // OTP-5 global daily SEND circuit-breaker breach (worker SMS path). AGGREGATE /
  // PII-free: channel/cap enums + integer limit + UTC-day string ONLY — no worker id,
  // phone, IP, or code. Emitted once per breach (the spend ceiling tripped).
  "worker.otp_send_cap_exceeded": {
    version: 1,
    domain: "worker",
    payload: p.WorkerOtpSendCapExceededPayload,
  },
  // F4 (#168) — a REAL Fast2SMS send failed at the provider boundary (the only worker-OTP
  // send path). AGGREGATE / PII-free: provider literal + failure-kind enum ONLY — no phone,
  // no hash, no worker id, no code, no HTTP status, no free text. Ops watch: an elevated
  // rate = delivery degradation (see docs/observability-runbook.md §7).
  "worker.otp_send_failed": {
    version: 1,
    domain: "worker",
    payload: p.WorkerOtpSendFailedPayload,
  },

  "consent.accepted": { version: 1, domain: "consent", payload: p.ConsentAcceptedPayload },

  "chat.session_started": { version: 1, domain: "chat", payload: p.ChatSessionStartedPayload },
  "chat.message_received": { version: 1, domain: "chat", payload: p.ChatMessageReceivedPayload },
  "chat.message_sent": { version: 1, domain: "chat", payload: p.ChatMessageSentPayload },

  "voice_note.uploaded": { version: 1, domain: "voice_note", payload: p.VoiceNoteUploadedPayload },
  "voice_note.transcription_requested": {
    version: 1,
    domain: "voice_note",
    payload: p.VoiceNoteTranscriptionRequestedPayload,
  },
  "voice_note.transcription_completed": {
    version: 1,
    domain: "voice_note",
    payload: p.VoiceNoteTranscriptionCompletedPayload,
  },
  "voice_note.transcription_failed": {
    version: 1,
    domain: "voice_note",
    payload: p.VoiceNoteTranscriptionFailedPayload,
  },

  "profile.extraction_requested": {
    version: 1,
    domain: "profile",
    payload: p.ProfileExtractionRequestedPayload,
  },
  "profile.extraction_completed": {
    version: 1,
    domain: "profile",
    payload: p.ProfileExtractionCompletedPayload,
  },
  "profile.confirmed": { version: 1, domain: "profile", payload: p.ProfileConfirmedPayload },
  "profile.extraction_failed": {
    version: 1,
    domain: "profile",
    payload: p.ProfileExtractionFailedPayload,
  },
  "profile.extraction_ready": {
    version: 1,
    domain: "profile",
    payload: p.ProfileExtractionReadyPayload,
  },

  "resume.generated": { version: 1, domain: "resume", payload: p.ResumeGeneratedPayload },
  "resume.downloaded": { version: 1, domain: "resume", payload: p.ResumeDownloadedPayload },
  "resume.regenerated": { version: 1, domain: "resume", payload: p.ResumeRegeneratedPayload },
  "resume.shared": { version: 1, domain: "resume", payload: p.ResumeSharedPayload },

  "interview_kit.render_completed": {
    version: 1,
    domain: "interview_kit",
    payload: p.InterviewKitRenderCompletedPayload,
  },
  "interview_kit.render_failed": {
    version: 1,
    domain: "interview_kit",
    payload: p.InterviewKitRenderFailedPayload,
  },
  "interview_kit.downloaded": {
    version: 1,
    domain: "interview_kit",
    payload: p.InterviewKitDownloadedPayload,
  },

  "action.recorded": { version: 1, domain: "action", payload: p.ActionRecordedPayload },

  "ai.pseudonymization_started": {
    version: 1,
    domain: "ai",
    payload: p.AiPseudonymizationStartedPayload,
  },
  "ai.pseudonymization_completed": {
    version: 1,
    domain: "ai",
    payload: p.AiPseudonymizationCompletedPayload,
  },
  "ai.pseudonymization_failed": {
    version: 1,
    domain: "ai",
    payload: p.AiPseudonymizationFailedPayload,
  },
  "ai.llm_call_requested": { version: 1, domain: "ai", payload: p.AiLlmCallRequestedPayload },
  "ai.llm_call_completed": { version: 1, domain: "ai", payload: p.AiLlmCallCompletedPayload },
  "ai.llm_call_failed": { version: 1, domain: "ai", payload: p.AiLlmCallFailedPayload },
  "ai.cost_recorded": { version: 1, domain: "ai", payload: p.AiCostRecordedPayload },
  "ai.spend_cap_exceeded": {
    version: 1,
    domain: "ai",
    payload: p.AiSpendCapExceededPayload,
  },
  "ai.job_completed": { version: 1, domain: "ai", payload: p.AiJobCompletedPayload },

  // Reach foundation (ADR-0005, TD8) — worker-side behavioural record for matching/
  // LEARN. Defined now; emitted when the Phase-2 feed surface ships. PII-free.
  "feed.shown": { version: 1, domain: "feed", payload: p.FeedShownPayload },
  "application.submitted": {
    version: 1,
    domain: "application",
    payload: p.ApplicationSubmittedPayload,
  },
  "application.skipped": {
    version: 1,
    domain: "application",
    payload: p.ApplicationSkippedPayload,
  },

  // Ops-created job postings (ADR-0012) — vacancy-banded, stored-only. PII-free:
  // ids/enums/booleans/field-key arrays only (org/role/location/description never
  // appear in a payload).
  "job_posting.created": {
    version: 1,
    domain: "job_posting",
    payload: p.JobPostingCreatedPayload,
  },
  "job_posting.updated": {
    version: 1,
    domain: "job_posting",
    payload: p.JobPostingUpdatedPayload,
  },
  "job_posting.closed": {
    version: 1,
    domain: "job_posting",
    payload: p.JobPostingClosedPayload,
  },
  "job_posting.paused": {
    version: 1,
    domain: "job_posting",
    payload: p.JobPostingPausedPayload,
  },
  "job_posting.resumed": {
    version: 1,
    domain: "job_posting",
    payload: p.JobPostingResumedPayload,
  },
  // Contact Unlock + Reveal (ADR-0010, Stream A) — PII-FREE, ids/enums/counts only.
  // The revealed contact / proxy number / relay destination NEVER appears in any
  // payload (CLAUDE.md invariant 2; threat-model F-5). All v1.
  "unlock.requested": { version: 1, domain: "unlock", payload: p.UnlockRequestedPayload },
  "unlock.granted": { version: 1, domain: "unlock", payload: p.UnlockGrantedPayload },
  "unlock.denied": { version: 1, domain: "unlock", payload: p.UnlockDeniedPayload },
  "unlock.cap_exceeded": { version: 1, domain: "unlock", payload: p.UnlockCapExceededPayload },
  "contact.revealed": { version: 1, domain: "contact", payload: p.ContactRevealedPayload },
  "payment.authorized": { version: 1, domain: "payment", payload: p.PaymentAuthorizedPayload },
  "payment.captured": { version: 1, domain: "payment", payload: p.PaymentCapturedPayload },
  "payment.failed": { version: 1, domain: "payment", payload: p.PaymentFailedPayload },

  // Monetization + Pricing Engine (ADR-0013) — PII-FREE: ids + codes + enums + integer
  // ₹ amounts + counts only. `payment.*` above is reused for the money movement of every
  // paid product; these add the product-specific facts. Resume disclosure is FREE but
  // still recorded as a PII-disclosure FACT (no bytes/name/link). All v1.
  "job_posting.purchased": {
    version: 1,
    domain: "job_posting",
    payload: p.JobPostingPurchasedPayload,
  },
  "job_posting.boosted": { version: 1, domain: "job_posting", payload: p.JobPostingBoostedPayload },
  "applicant.viewed": { version: 1, domain: "job_posting", payload: p.ApplicantViewedPayload },
  "resume.disclosed": { version: 1, domain: "resume", payload: p.ResumeDisclosedPayload },
  "coupon.redeemed": { version: 1, domain: "pricing", payload: p.CouponRedeemedPayload },
  "pricing.changed": { version: 1, domain: "pricing", payload: p.PricingChangedPayload },

  // Per-payer hiring capacity (ADR-0016) — PII-FREE & faceless (opaque payer_id, no FK).
  // `capacity.purchased` rides the payer-scoped `pricing_plan` subject (subject_id =
  // payer_id), matching the `coupon.redeemed` precedent. `posting_plan.paused/resumed`
  // are the plan serving-state machine (subject = the posting_plans row). All v1.
  "capacity.purchased": { version: 1, domain: "capacity", payload: p.CapacityPurchasedPayload },
  "posting_plan.paused": { version: 1, domain: "posting_plan", payload: p.PostingPlanPausedPayload },
  "posting_plan.resumed": { version: 1, domain: "posting_plan", payload: p.PostingPlanResumedPayload },
  // Quota top-up (B2): a paid applicant-visibility refill on an active plan (pricing engine).
  "posting_plan.quota_topped": {
    version: 1,
    domain: "posting_plan",
    payload: p.PostingPlanQuotaToppedPayload,
  },

  // WhatsApp invite funnel + re-engagement (ADR-0020). PII-FREE; mock provider in alpha.
  "invite.created": { version: 1, domain: "invite", payload: p.InviteCreatedPayload },
  "invite.clicked": { version: 1, domain: "invite", payload: p.InviteClickedPayload },
  "invite.accepted": { version: 1, domain: "invite", payload: p.InviteAcceptedPayload },
  "messaging.requested": { version: 1, domain: "messaging", payload: p.MessagingRequestedPayload },
  "messaging.sent": { version: 1, domain: "messaging", payload: p.MessagingSentPayload },
  "messaging.suppressed": { version: 1, domain: "messaging", payload: p.MessagingSuppressedPayload },
  "messaging.failed": { version: 1, domain: "messaging", payload: p.MessagingFailedPayload },

  // PACE supply-widening (ADR-0021) — deterministic widen waves + ops alert (the
  // "release waves" slice of ADR-0011's PACE triad). PII-FREE & faceless: opaque
  // job_id + widen-stage enum + supply counts + elapsed hours only; no LLM. v1.
  "pace.wave_widened": { version: 1, domain: "pace", payload: p.PaceWaveWidenedPayload },
  "pace.ops_alert_raised": { version: 1, domain: "pace", payload: p.PaceOpsAlertRaisedPayload },
  // Self-serve payer account auth (ADR-0019 Decision B — closes R16/LC-1/TD33). PII-FREE
  // & FACELESS: opaque payer_id + role/method enums + booleans ONLY (the payer's
  // email/phone/org-name live encrypted in `payers`, never in an event). The payer
  // analogue of the `worker.*` auth events. All v1.
  "payer.created": { version: 1, domain: "payer", payload: p.PayerCreatedPayload },
  "payer.login_requested": { version: 1, domain: "payer", payload: p.PayerLoginRequestedPayload },
  "payer.session_started": { version: 1, domain: "payer", payload: p.PayerSessionStartedPayload },
  // A payer self-edited their own account on PATCH /payer/me (PROF-3). FACELESS:
  // opaque payer_id + the changed field KEYS (subset of {org_name, phone}) ONLY —
  // never the new org-name/phone VALUES (B-R2 PII lives encrypted in `payers`). v1.
  "payer.account_updated": {
    version: 1,
    domain: "payer",
    payload: p.PayerAccountUpdatedPayload,
  },
  // Payer org membership lifecycle (ADR-0027 / B5). PII-FREE: opaque row/org/actor ids +
  // org_role enum only — the invitee email lives encrypted in `payer_members`, never here.
  "payer_member.invited": { version: 1, domain: "payer", payload: p.PayerMemberInvitedPayload },
  "payer_member.accepted": { version: 1, domain: "payer", payload: p.PayerMemberAcceptedPayload },
  "payer_member.removed": { version: 1, domain: "payer", payload: p.PayerMemberRemovedPayload },
  // OTP-5 global daily SEND circuit-breaker breach (payer email path). Same AGGREGATE /
  // PII-free shape as worker.otp_send_cap_exceeded (channel "payer_email") — no payer id,
  // email, IP, or code. Emitted once per breach; the HTTP response stays byte-identical
  // for a known vs unknown account (no enumeration oracle, XB-H).
  "payer.otp_send_cap_exceeded": {
    version: 1,
    domain: "payer",
    payload: p.PayerOtpSendCapExceededPayload,
  },

  // The `jobs` ENTITY lifecycle (ADR-0022 Agency Supply Portal) — DISTINCT from
  // `job_posting.*` (ADR-0012, a different entity). PII-FREE: opaque ids + coarse
  // non-PII bands only; the PAYER is the actor, the `job` entity the subject. All v1.
  "job.created": { version: 1, domain: "job", payload: p.JobCreatedPayload },
  "job.updated": { version: 1, domain: "job", payload: p.JobUpdatedPayload },
  "job.closed": { version: 1, domain: "job", payload: p.JobClosedPayload },

  // AGENCY supply-attribution funnel (ADR-0022) — the payer-axis sibling of `invite.*`.
  // PII-FREE: opaque ids + channel enum + optional non-PII campaign tag only.
  // `agency_invite.accepted` carries the invited worker id and is emitted ONLY after
  // consent (invariant #6), exclusively from the internal consent-gated seam. All v1.
  "agency_invite.created": {
    version: 1,
    domain: "agency_invite",
    payload: p.AgencyInviteCreatedPayload,
  },
  "agency_invite.accepted": {
    version: 1,
    domain: "agency_invite",
    payload: p.AgencyInviteAcceptedPayload,
  },

  // AGENCY financial KYC (ADR-0022 module 1, Amendment 2). FINANCIAL-PII-FREE: opaque agency
  // payer_id + status enum + (ops) verified_by admin id + reject CODE. The PAN/bank/IFSC/name
  // live encrypted ONLY in `agency_kyc`, NEVER here. All v1.
  "agency_kyc.submitted": { version: 1, domain: "agency_kyc", payload: p.AgencyKycSubmittedPayload },
  "agency_kyc.verified": { version: 1, domain: "agency_kyc", payload: p.AgencyKycVerifiedPayload },
  "agency_kyc.rejected": { version: 1, domain: "agency_kyc", payload: p.AgencyKycRejectedPayload },

  // AGENCY commission payout (ADR-0022 modules 3+7, Amendment 2). PII-FREE: ₹ + opaque ids +
  // reason CODE. MOCK — `agency_payout.paid` is inert (real money is the §7 gate). All v1.
  "agency_payout.accrued": {
    version: 1,
    domain: "agency_payout",
    payload: p.AgencyPayoutAccruedPayload,
  },
  "agency_payout.requested": {
    version: 1,
    domain: "agency_payout",
    payload: p.AgencyPayoutRequestedPayload,
  },
  "agency_payout.blocked": {
    version: 1,
    domain: "agency_payout",
    payload: p.AgencyPayoutBlockedPayload,
  },
  "agency_payout.paid": { version: 1, domain: "agency_payout", payload: p.AgencyPayoutPaidPayload },

  // Admin Ops Portal (ADR-0025) — the 4th privileged principal. PII-FREE & FACELESS:
  // opaque admin_id + role/action/reason CODES + opaque target ids ONLY (the admin email
  // lives encrypted in `admin_users`, never in an event). `session_started`/`session_revoked`
  // are emitted by ADMIN-1; `action_performed`/`pii_viewed` are registered now for ADMIN-3
  // (not emitted in ADMIN-1). All v1.
  "admin.session_started": {
    version: 1,
    domain: "admin",
    payload: p.AdminSessionStartedPayload,
  },
  "admin.session_revoked": {
    version: 1,
    domain: "admin",
    payload: p.AdminSessionRevokedPayload,
  },
  "admin.action_performed": {
    version: 1,
    domain: "admin",
    payload: p.AdminActionPerformedPayload,
  },
  "admin.pii_viewed": { version: 1, domain: "admin", payload: p.AdminPiiViewedPayload },
  // ADR-0025 ADMIN-3b (must-fix #8) — a per-admin worker-PII reveal cap was exceeded. The
  // PII-free BREACH event: opaque admin_id + which window (hour|day) ONLY — never a worker/
  // subject id, the revealed value, or the reason note. An over-cap request reveals nothing. v1.
  "admin.pii_reveal_cap_exceeded": {
    version: 1,
    domain: "admin",
    payload: p.AdminPiiRevealCapExceededPayload,
  },
  // ADR-0025 ADMIN-3c (OQ-6) — an admin requested a SAFE-DIRECTION kill-switch PAUSE. The
  // audited INTENT only; it NEVER enables anything (enabling a real provider stays env/deploy-
  // gated, §2 #5). PII-free: opaque admin_id + a switch KEY enum + a reason CODE only. v1.
  "admin.kill_switch_pause_requested": {
    version: 1,
    domain: "admin",
    payload: p.AdminKillSwitchPauseRequestedPayload,
  },
  // ADR-0030 / FORK-B-1 (seam A): a below-floor skill phrase was recorded to the
  // unresolved_phrase growth queue. Hash-only (never the text — even pseudonymized),
  // domain + lang + post-upsert count. v1.
  "skill.phrase_unresolved": {
    version: 1,
    domain: "skill",
    payload: p.SkillPhraseUnresolvedPayload,
  },
} as const satisfies Record<string, EventDefinition>;

/** Union of all known event names. */
export type EventName = keyof typeof EVENT_REGISTRY;

/** Runtime list of all known event names. */
export const EVENT_NAMES = Object.keys(EVENT_REGISTRY) as EventName[];

/** Inferred (output) payload type for a given event name — after defaults applied. */
export type PayloadOf<N extends EventName> = z.infer<(typeof EVENT_REGISTRY)[N]["payload"]>;

/** Input payload type for a given event name — fields with defaults are optional. */
export type PayloadInputOf<N extends EventName> = z.input<(typeof EVENT_REGISTRY)[N]["payload"]>;

/** Type guard: is the given string a registered event name? */
export function isEventName(value: unknown): value is EventName {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(EVENT_REGISTRY, value);
}

/** Look up the registry entry for an event name. */
export function getEventDefinition<N extends EventName>(name: N): (typeof EVENT_REGISTRY)[N] {
  return EVENT_REGISTRY[name];
}
