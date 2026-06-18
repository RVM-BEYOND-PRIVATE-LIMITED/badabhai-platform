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
  "worker.name_recorded": { version: 1, domain: "worker", payload: p.WorkerNameRecordedPayload },

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

  // WhatsApp invite funnel + re-engagement (ADR-0020). PII-FREE; mock provider in alpha.
  "invite.created": { version: 1, domain: "invite", payload: p.InviteCreatedPayload },
  "invite.clicked": { version: 1, domain: "invite", payload: p.InviteClickedPayload },
  "invite.accepted": { version: 1, domain: "invite", payload: p.InviteAcceptedPayload },
  "messaging.requested": { version: 1, domain: "messaging", payload: p.MessagingRequestedPayload },
  "messaging.sent": { version: 1, domain: "messaging", payload: p.MessagingSentPayload },
  "messaging.suppressed": { version: 1, domain: "messaging", payload: p.MessagingSuppressedPayload },
  "messaging.failed": { version: 1, domain: "messaging", payload: p.MessagingFailedPayload },
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
