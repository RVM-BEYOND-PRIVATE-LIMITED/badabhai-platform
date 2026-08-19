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
  // #643 — the push-notification toggle. Emitted because the flag GATES the ADR-0034
  // fan-out (a material state change); the Alerts read watermark it ships alongside
  // emits nothing, being a read position rather than a business action (§1).
  "worker.notification_prefs_updated": {
    version: 1,
    domain: "worker",
    payload: p.WorkerNotificationPrefsUpdatedPayload,
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
  "consent.revoked": { version: 1, domain: "consent", payload: p.ConsentRevokedPayload },

  "chat.session_started": { version: 1, domain: "chat", payload: p.ChatSessionStartedPayload },
  "chat.message_received": { version: 1, domain: "chat", payload: p.ChatMessageReceivedPayload },
  "chat.message_sent": { version: 1, domain: "chat", payload: p.ChatMessageSentPayload },
  "chat.session_abandoned": {
    version: 1,
    domain: "chat",
    payload: p.ChatSessionAbandonedPayload,
  },

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
  "interview_kit.ready_for_worker": {
    version: 1,
    domain: "interview_kit",
    payload: p.InterviewKitReadyForWorkerPayload,
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
  // #822 — the discovery surface, distinct from the personalized feed above. Carries the
  // SHAPE of the search only; see the payload's note on why the query text never appears.
  "job.search_performed": {
    version: 1,
    domain: "feed",
    payload: p.JobSearchPerformedPayload,
  },
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
  // Ops trust review → the worker-visible "Verified job" badge. PII-free (id + enums). v1.
  "job_posting.verification_updated": {
    version: 1,
    domain: "job_posting",
    payload: p.JobPostingVerificationUpdatedPayload,
  },

  // AI job-posting chat (ADR-0035) — the payer-facing conversational front door onto the
  // UNCHANGED job-posting create path. PII-FREE + `.strict()`: opaque session/payer/message
  // ids + the message-type enum only; never the payer's typed message, a draft field value,
  // or the payer's organisation name (never asked for — §Decision 3). `message_sent` covers
  // BOTH directions, discriminated by the ACTOR (payer vs ai_service). There is deliberately
  // NO publish event: publish reuses `job_posting.created` above, emitted by the existing
  // `createForPayer` — no second writer. All v1.
  "job_posting_chat.session_started": {
    version: 1,
    domain: "job_posting_chat",
    payload: p.JobPostingChatSessionStartedPayload,
  },
  "job_posting_chat.message_sent": {
    version: 1,
    domain: "job_posting_chat",
    payload: p.JobPostingChatMessageSentPayload,
  },
  "job_posting_chat.draft_ready": {
    version: 1,
    domain: "job_posting_chat",
    payload: p.JobPostingChatDraftReadyPayload,
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
  "posting_plan.paused": {
    version: 1,
    domain: "posting_plan",
    payload: p.PostingPlanPausedPayload,
  },
  "posting_plan.resumed": {
    version: 1,
    domain: "posting_plan",
    payload: p.PostingPlanResumedPayload,
  },
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
  // B4 — the install ACTUALLY attributed, plus WHICH leg of the post-Dynamic-Links chain
  // delivered it (app_link | install_referrer | custom_scheme | unknown). Emitted alongside
  // `*.accepted` on a SUCCESSFUL attribution only; ONE event serves both funnels
  // (`invite_kind` + the matching subject_type keep them distinguishable). PII-FREE: the
  // opaque ROW id — never the shareable code — plus two closed enums. v1.
  "invite.install": { version: 1, domain: "invite", payload: p.InviteInstallPayload },
  "messaging.requested": { version: 1, domain: "messaging", payload: p.MessagingRequestedPayload },
  "messaging.sent": { version: 1, domain: "messaging", payload: p.MessagingSentPayload },
  "messaging.suppressed": {
    version: 1,
    domain: "messaging",
    payload: p.MessagingSuppressedPayload,
  },
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
  // The test-login seam mints a session WITHOUT an OTP verification — a distinct event so a
  // synthetic session is never indistinguishable from a real login on the spine (Phase 2.1).
  "payer.test_login": { version: 1, domain: "payer", payload: p.PayerTestLoginPayload },
  // Payer LIFECYCLE transitions (ADR-0037): pending → active on first successful OTP
  // verification, and the admin suspend/reinstate pair. FACELESS: opaque payer_id + the
  // two closed status enums. These are additive and v1; `admin.action_performed` still
  // records the ADMIN's action separately (value-free), so an admin-driven transition
  // produces both — one says "an admin did a thing", this one says "the payer moved
  // from X to Y". All three share one payload shape.
  "payer.activated": { version: 1, domain: "payer", payload: p.PayerLifecycleTransitionPayload },
  "payer.suspended": { version: 1, domain: "payer", payload: p.PayerLifecycleTransitionPayload },
  "payer.reinstated": { version: 1, domain: "payer", payload: p.PayerLifecycleTransitionPayload },
  // The INVENTORY half of a suspension (ADR-0037 Decision 1). Emitted alongside — never
  // instead of — `payer.suspended`/`payer.reinstated`: the session freeze and the job
  // freeze are separate state changes on separate tables and either can move zero rows.
  // Counts only, so one admin click cannot emit hundreds of events. Both v1.
  "payer.inventory_suspended": {
    version: 1,
    domain: "payer",
    payload: p.PayerInventoryTransitionPayload,
  },
  "payer.inventory_reinstated": {
    version: 1,
    domain: "payer",
    payload: p.PayerInventoryTransitionPayload,
  },
  // ADR-0037 Decision 5 — a login code was reserved for a SUSPENDED account but not sent.
  // The only record of that attempt: the HTTP response stays neutral by design, and no
  // `payer.login_requested` is emitted because no code was actually delivered. v1.
  "payer.otp_suppressed": { version: 1, domain: "payer", payload: p.PayerOtpSuppressedPayload },
  // ADR-0037 Decision 6 — a captured payment was credited to a SUSPENDED payer. An ops
  // alert for Finance/Admin, NOT a rejection: the money is already taken and there is no
  // refund path, so the credit is applied and a human is told. The credits are unspendable
  // until reinstatement (PayerAuthGuard requires `active`). v1.
  "payer.suspended_payment_captured": {
    version: 1,
    domain: "payer",
    payload: p.PayerSuspendedPaymentCapturedPayload,
  },
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
  // Worker-facing notification events — per-worker feed, emitted at trigger points.
  "job.available": { version: 1, domain: "job", payload: p.NewJobAvailablePayload },

  "profile.viewed": { version: 1, domain: "profile", payload: p.ProfileViewedPayload },
  // AGENCY supply-attribution funnel (ADR-0022) — the payer-axis sibling of `invite.*`.
  // PII-FREE: opaque ids + channel enum + optional non-PII campaign tag only.
  // `agency_invite.accepted` carries the invited worker id and is emitted ONLY after
  // consent (invariant #6), exclusively from the internal consent-gated seam. All v1.
  "agency_invite.created": {
    version: 1,
    domain: "agency_invite",
    payload: p.AgencyInviteCreatedPayload,
  },
  // TD113 — the agency funnel's MIDDLE stage finally has an event. Emitted from the PUBLIC
  // click path (the invited worker is the only party who can click); NEUTRAL on an unknown
  // code (nothing is emitted), so it is not an existence oracle. PII-FREE and worker-handle
  // FREE: a click precedes consent, so no worker identity may be recorded (invariant #6). v1.
  "agency_invite.clicked": {
    version: 1,
    domain: "agency_invite",
    payload: p.AgencyInviteClickedPayload,
  },
  "agency_invite.accepted": {
    version: 1,
    domain: "agency_invite",
    payload: p.AgencyInviteAcceptedPayload,
  },

  // AGENCY financial KYC (ADR-0022 module 1, Amendment 2). FINANCIAL-PII-FREE: opaque agency
  // payer_id + status enum + (ops) verified_by admin id + reject CODE. The PAN/bank/IFSC/name
  // live encrypted ONLY in `agency_kyc`, NEVER here. All v1.
  "agency_kyc.submitted": {
    version: 1,
    domain: "agency_kyc",
    payload: p.AgencyKycSubmittedPayload,
  },
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
  // ADR-0025 Phase 6 — an admin READ one worker's journey (the 7-step funnel, or one
  // interview session in depth). Audited even though it is a `read_entities` read and returns
  // no PII: it is a BEHAVIOURAL profile at much higher granularity than the entity detail, so
  // looking at it must name who looked and at whom. PII-free: opaque admin/worker/session ids
  // + a view enum ONLY — never a question key, a status, a count, or any free text. v1.
  "admin.worker_journey_viewed": {
    version: 1,
    domain: "admin",
    payload: p.AdminWorkerJourneyViewedPayload,
  },
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

  // TD92 — stealth token-claim audit event. A push token was claimed FROM another
  // worker's devices (steal on register / push-token update). PII-FREE: the LOSING
  // worker is the subject + the payload carries the opaque losing worker_id + count
  // of stale rows cleared. The ACTOR (the worker whose device claimed the token)
  // identifies the winning principal. The token NEVER appears in payload/logs.
  "worker.push_token_claimed": {
    version: 1,
    domain: "worker",
    payload: p.WorkerPushTokenClaimedPayload,
  },

  // §X.6 — the RETENTION signal. At most ONE per worker per UTC day (the producer keys the
  // events-table idempotency key on `worker.active:<worker_id>:<day>`), so this is a coarse
  // daily-active FACT, not a request log: no route, no session, no ip_hash, no user-agent,
  // no sub-day timestamp. PII-FREE: opaque worker id + a `YYYY-MM-DD` bucket. v1.
  "worker.active": { version: 1, domain: "worker", payload: p.WorkerActivePayload },

  // §X.6 — the ₹20 worker-referral ACTIVATION BONUS, accrued only when the referred worker
  // completed a profile AND was unlocked (the fraud rule). MOCK ledger, NO disbursement —
  // and deliberately NO `referral.bonus_paid` sibling, because an event name is a promise
  // and no payout rail exists (real outbound money is the §7 gate). Emitted exactly once per
  // referred worker, gated by the UNIQUE constraint on `invited_worker_id`. PII-FREE. v1.
  "referral.bonus_accrued": {
    version: 1,
    domain: "referral",
    payload: p.ReferralBonusAccruedPayload,
  },

  // B4 — the `referral_links` resolver primitive. All three carry the opaque
  // `referral_link_id`, NEVER the shareable `code` (a bearer token — same rule as
  // `invite.clicked`). `install_claimed` is the one that closes attribution, and it is
  // emitted at most once per worker (the partial unique index on
  // `referral_clicks.claimed_by_worker_id` is what enforces that, not the emitter). v1.
  "referral.link_created": {
    version: 1,
    domain: "referral",
    payload: p.ReferralLinkCreatedPayload,
  },
  "referral.link_clicked": {
    version: 1,
    domain: "referral",
    payload: p.ReferralLinkClickedPayload,
  },
  "referral.install_claimed": {
    version: 1,
    domain: "referral",
    payload: p.ReferralInstallClaimedPayload,
  },

  // ── Matching V1 (ADR-0036) ────────────────────────────────────────────────
  // All PII-FREE: opaque uuids, closed-set `mskill_*` ids, integer counts, small
  // enums. Invariant #4: none of these is a model output — `match_tier` is set
  // membership and the ordering they describe is the fixed lexicographic rank key.

  // MOMENT ①/② — a worker's matchable supply was re-derived and his `job_reach`
  // rows reconciled. Emitted even when the rebuild derives ZERO skills (that is the
  // E17 low-tag signal, and it is invisible if we only emit on success-with-rows). v1.
  "worker.match_skills_rebuilt": {
    version: 1,
    domain: "worker",
    payload: p.WorkerMatchSkillsRebuiltPayload,
  },
  // MOMENT ③ — a posting's reach set was materialized (publish / unpause / edit /
  // ops widen). Counts only, never the worker list. v1.
  "job_posting.reach_materialized": {
    version: 1,
    domain: "job_posting",
    payload: p.JobPostingReachMaterializedPayload,
  },
  // E12/E13 — the posting reaches nobody, or reaches nobody who holds the POSTED
  // skill. The ops alert that replaces PACE's auto-widen (which V1 forbids). v1.
  "job_posting.reach_alert": {
    version: 1,
    domain: "job_posting",
    payload: p.JobPostingReachAlertPayload,
  },
  // POLICY 27 — an ops human WIDENED a reach set. Narrowing is structurally
  // impossible on that path (the service appends, never removes). v1.
  "job_posting.reach_widened": {
    version: 1,
    domain: "job_posting",
    payload: p.JobPostingReachWidenedPayload,
  },
  // ADR-0036 §7 — a boost purchase refused because matched supply is below
  // `match_config.boost_supply_floor`. v1.
  "job_posting.boost_refused": {
    version: 1,
    domain: "job_posting",
    payload: p.JobPostingBoostRefusedPayload,
  },
  // The conversion signal: a payer's credit balance hit EXACTLY zero on a debit.
  // Emitted from the debit's RETURNING balance (never a re-read) and keyed on the
  // debiting unlock, so it is exact and idempotent rather than approximate. v1.
  "payer.credits_exhausted": {
    version: 1,
    domain: "payer",
    payload: p.PayerCreditsExhaustedPayload,
  },
  // MOMENT ④ — `feed.shown` VERSION 2. `feed.shown` above KEEPS its v1 entry,
  // unmodified, as history (invariant #8): `validateEvent` allows exactly one version
  // per NAME, so a bump in place would invalidate every shipped emitter the moment it
  // deployed — including on a database still running with MATCH_V1_ENABLED=false. The
  // registry `version: 2` records the payload GENERATION; `score`/`hot` are gone and
  // `match_tier`/`boosted`/`job_posting_id` replace them.
  "feed.shown_v2": {
    version: 2,
    domain: "feed",
    payload: p.FeedShownV2Payload,
  },

  // ── Occupation Intelligence Engine (Phase 8) ──────────────────────────────
  // APPENDED AT THE END, never inserted among the entries above: the registry is
  // append-only by protocol, because an edited entry is a mutated event schema and
  // consumers version off these definitions.
  //
  // A worker's trade phrase reached none of the four retrieval layers and was recorded
  // to the growth queue. PII-FREE: sha256 of the (already pseudonymized) phrase, the
  // language tag, and the post-upsert count — never the text. v1.
  "occupation.phrase_unresolved": {
    version: 1,
    domain: "occupation",
    payload: p.OccupationPhraseUnresolvedPayload,
  },

  // The interview pinned an occupation: which one, via which rung of the ladder, at what
  // calibrated confidence. The source of the plan's layer-distribution gate, which cannot
  // be computed from `worker_profiles` because a re-pin overwrites the first pin. v1.
  "profile.occupation_identified": {
    version: 1,
    domain: "profile",
    payload: p.ProfileOccupationIdentifiedPayload,
  },

  // Which QUESTIONS the worker got, as opposed to which trade they are in. Pack contents are
  // immutable per version, so this pair is what makes a finished profile explicable a year
  // later. Emitted only when the durable `chat_sessions` pin won the write. v1.
  "profile.pack_pinned": {
    version: 1,
    domain: "profile",
    payload: p.ProfilePackPinnedPayload,
  },

  // The interview could NOT pin one and fell back to the universal pack. A normal outcome
  // that is otherwise invisible from both sides of the conversation — which is how a
  // catalogue silently stops covering a growing trade. v1.
  "profile.occupation_unresolved": {
    version: 1,
    domain: "profile",
    payload: p.ProfileOccupationUnresolvedPayload,
  },

  // The parse LLM contradicted the deterministic answer map and lost. Field ids and counts
  // only, never values — on either side. This is how gate 4 stays observable. v1.
  "profile.parse_disagreement": {
    version: 1,
    domain: "profile",
    payload: p.ProfileParseDisagreementPayload,
  },

  // One interview finished: duration histogram, ask count, how it ended, which pack ran. The
  // only source for p95 turn latency and the completion rate — neither is recoverable from
  // `worker_profiles`, which records the destination and overwrites the journey.
  //
  // `profile.*` and not a new `profiling` domain, matching the three Phase 8 OIE events above:
  // one prefix for everything the interview records about a worker's profile, rather than a
  // domain minted for a single event. v1.
  "profile.interview_completed": {
    version: 1,
    domain: "profile",
    payload: p.ProfileInterviewCompletedPayload,
  },

  // How much the six never-invent gates threw away, per gate. The gates always worked; the
  // RATE is what says the model started inventing spans or reading our questions back to us.
  // Counts only — no field ids, because a value that failed `provenance` or `pii` is not
  // vouched for and even the field it claimed to fill is unverified model output. v1.
  "profile.parse_gates_rejected": {
    version: 1,
    domain: "profile",
    payload: p.ProfileParseGatesRejectedPayload,
  },

  // A settled answer changed from the review screen. The one interview write with no
  // `chat_messages` row behind it — the correction path is deliberately outside the turn loop —
  // so without this event a stored value would change with nothing recording that it did. Also
  // the cheapest available signal that a question is badly worded or mis-heard. Keys and the
  // affordance only, never the value. v1.
  "profile.answer_corrected": {
    version: 1,
    domain: "profile",
    payload: p.ProfileAnswerCorrectedPayload,
  },

  // The LLM-led opening handed the interview back to the deterministic engine. Designed to be
  // invisible to the worker, which is exactly why it needs an event: a degraded ai-service
  // otherwise thins every profile with every user-visible signal still green. Once per
  // session — the fallback flag is sticky. v1.
  "profile.llm_interview_fallback": {
    version: 1,
    domain: "profile",
    payload: p.ProfileLlmInterviewFallbackPayload,
  },

  // One physical submission arrived twice and the second copy was served from the reply cache
  // (#931). Structurally invisible otherwise — a duplicate returns before the engine is consulted,
  // so it writes no `chat_messages` row and emits no `chat.message_received`; the only prior
  // evidence was one warn log on one of the three branches that absorb it. Also the rollout gate
  // for retiring the four reply-cache clocks: `absorbed_as: "client_id"` is a duplicate the
  // client's own submission id settled with no clock consulted. Keyed on the submission id, so a
  // retry storm collapses to one row. Ids, one pack key, two enums, two counts. v1.
  "profile.submission_duplicated": {
    version: 1,
    domain: "profile",
    payload: p.ProfileSubmissionDuplicatedPayload,
  },

  // S3-C / D-6 — `skill.phrase_unresolved` VERSION 2. The v1 entry above KEEPS its
  // definition, unmodified, as history (invariant #8), and keeps emitting for
  // legacy-scoped misses. Same reasoning as `feed.shown_v2`: `validateEvent` allows
  // exactly one version per NAME, so relaxing v1's REQUIRED `domain_id` in place — which
  // is what a canonical-scoped miss would need, having no legacy slug — would invalidate
  // every shipped consumer that reads the field without a null check. v2 carries exactly
  // one of `domain_id` (Path B) or `job_domain_id` (Path A), enforced by the payload's own
  // refine and mirrored by `unresolved_phrase_one_domain_chk` in the database.
  "skill.phrase_unresolved_v2": {
    version: 2,
    domain: "skill",
    payload: p.SkillPhraseUnresolvedV2Payload,
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
