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
