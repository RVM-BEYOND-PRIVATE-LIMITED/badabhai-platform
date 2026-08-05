import { z } from "zod";

import {
  AICallMetadataSchema,
  PseudonymizationMetaSchema,
  languageCode,
} from "./common";

// Payer-side job-posting chat (ADR-0035): conversation state, the in-progress
// posting draft, the opener, and the turn request/response.

// ---------------------------------------------------------------------------
// Job-posting chat (ADR-0035) — the payer-facing sibling of the profiling
// contracts above. Mirrored field-for-field in apps/ai-service/app/contracts.py
// and pinned by the shared golden fixture __fixtures__/job-posting-chat.keys.json,
// which BOTH suites assert against (Pydantic silently drops unknown request keys,
// so a one-sided change is otherwise green on both sides).
// ---------------------------------------------------------------------------

/** The five shipped vacancy bands (ADR-0012). A posting is BANDED, never counted. */
const vacancyBand = z.enum(["1", "2-5", "6-10", "11-25", "25+"]);
/** The closed `jobs.shift` enum (packages/db schema.ts jobs_shift_chk). */
const jobShift = z.enum(["day", "night", "rotational"]);

// Caps mirror apps/api/src/job-postings/job-postings.dto.ts so a draft the AI
// service emits can never be one the publish DTO would reject.
const JP_LABEL_MAX = 200;
const JP_DESCRIPTION_MAX = 2000;

/**
 * Server-computed job-posting interview progress. Mirrors ConversationStateSchema's
 * shape. Holds POSTING signals only (role title, city, band, pay figures) — never
 * payer identity, and never the payer's organisation name, which this chat does not
 * ask for and never receives (ADR-0035 §Decision 3).
 */
export const JobPostingChatStateSchema = z.object({
  /**
   * Reserved trade seam. The job-posting bank is deliberately NOT split by trade
   * (the questions are identical across trades — see the AI service's
   * job_posting_chat/question_bank.py), so this is carried and passed to
   * `topics_for()` but does not branch today. Present so a future trade-specific
   * bank needs no contract change.
   */
  trade_hint: z.string().nullable().default(null),
  turn_count: z.number().int().nonnegative().default(0),
  answered_topics: z
    .array(
      z
        .string()
        .min(1)
        .max(40)
        .regex(/^[a-z_]+$/, "topic_id must be lowercase slug ([a-z_]+)"),
    )
    .default([]),
  asked_question_ids: z.array(z.string()).default([]),
  collected: z.record(z.string(), z.unknown()).default({}),
  /** CONSECUTIVE clarify re-serves of the same question (engine-bounded at 2). */
  clarify_count: z.number().int().nonnegative().default(0),
  /** Per-topic ASK count — `asked_question_ids` is a dedup set and cannot count. */
  ask_counts: z.record(z.string(), z.number().int().nonnegative()).default({}),
  /**
   * ESSENTIAL topics the payer never answered, in ESSENTIAL_TOPICS order. Empty =
   * complete. THIS, not `draft_ready`, is how an incomplete draft is declared.
   * Topic ids only — no PII.
   */
  unanswered_essentials: z.array(z.string()).default([]),
});
export type JobPostingChatState = z.infer<typeof JobPostingChatStateSchema>;

/**
 * The chat's in-progress job posting — the rich-draft precedent set by
 * WorkerProfileDraftSchema, pointed at the demand side.
 *
 * THERE IS DELIBERATELY NO `org_label` FIELD, and adding one is a defect (ADR-0035
 * §Decision 3). `PayerCreateJobPostingSchema` requires `org_label`, but the value is
 * already known server-side on `payers.orgNameEnc` and is decrypted + stamped onto
 * the create call by the NestJS publish step — the same post-hoc interpolation
 * AI-PERSONA-2 uses for a worker's name. The chat never asks for it, so it never
 * enters a payer message, this draft, conversation state, an event payload, or LLM
 * input. Asking would both duplicate data we already hold and invite a payer to type
 * personal contact details next to it.
 */
export const JobPostingDraftSchema = z.object({
  role_title: z.string().max(JP_LABEL_MAX).nullable().default(null),
  /** <= 10 phrases of <= 80 chars — the exact `skillsInput` cap in the publish DTO. */
  skills: z.array(z.string().min(1).max(80)).max(10).default([]),
  location_label: z.string().max(JP_LABEL_MAX).nullable().default(null),
  /** BANDED, never an integer (ADR-0012) — derived via `bandForCount` boundaries. */
  vacancy_band: vacancyBand.nullable().default(null),
  /** Monthly pay in whole rupees. Shapes match jobs.pay_min / jobs.pay_max. */
  pay_min: z.number().int().nonnegative().nullable().default(null),
  pay_max: z.number().int().nonnegative().nullable().default(null),
  shift: jobShift.nullable().default(null),
  benefits: z.array(z.string()).default([]),
  requirements: z.array(z.string()).default([]),
  description: z.string().max(JP_DESCRIPTION_MAX).nullable().default(null),
  /**
   * DETERMINISTIC coverage ratio (topics with a value / topics in the bank), NOT a
   * model score and never an input to ranking or a publish decision (invariant #4).
   */
  confidence: z.number().min(0).max(1).default(0),
  /**
   * Topic ids still without a value, in bank order. `vacancy` maps to `vacancy_band`
   * and `pay_range` to `pay_min`/`pay_max`; every other id is the draft field name.
   * Ids only — never the values.
   */
  missing_fields: z.array(z.string()).default([]),
  clarification_questions: z.array(z.string()).default([]),
});
export type JobPostingDraft = z.infer<typeof JobPostingDraftSchema>;

export const JobPostingChatOpeningInputSchema = z.object({
  trade_hint: z.string().nullable().optional(),
});
export type JobPostingChatOpeningInput = z.infer<typeof JobPostingChatOpeningInputSchema>;

/** Deliberately just the string — no model call, and no payer/org identity at all. */
export const JobPostingChatOpeningOutputSchema = z.object({
  opening_text: z.string(),
});
export type JobPostingChatOpeningOutput = z.infer<typeof JobPostingChatOpeningOutputSchema>;

/**
 * One payer turn. Mirrors ProfilingTurnInputSchema with one deliberate omission:
 * there is NO `history` field. The profiling input keeps one for caller compatibility
 * and then ignores it (COST-3 — the chat turn is stateless because the engine already
 * chose the question locally). A new contract does not inherit that dead weight, and
 * omitting it makes re-sending a transcript impossible rather than merely discouraged.
 */
export const JobPostingChatTurnInputSchema = z.object({
  session_id: z.string().min(1),
  /** OPAQUE payer reference for spend attribution — never a raw payer identity. */
  payer_ref: z.string().min(1).optional(),
  language: languageCode.optional(),
  message_text: z.string().min(1),
  trade_hint: z.string().nullable().optional(),
  conversation_state: JobPostingChatStateSchema.nullable().optional(),
  /**
   * Reserved for the rephrase seam. No LLM call is made on this route today, so this
   * is inert; it is in the frozen contract so turning the seam on is not a contract
   * change.
   */
  real_call_allowed: z.boolean().optional(),
});
export type JobPostingChatTurnInput = z.infer<typeof JobPostingChatTurnInputSchema>;

/**
 * One engine turn. Mirrors ProfilingTurnOutputSchema.
 *
 * `suggested_answers` is profiling's `suggested_followups` under an honest name:
 * that field's own docstring states it carries ANSWERS to the question just asked,
 * never follow-up questions, because a tapped chip is sent verbatim as the payer's
 * message. A new contract with two client teams building against it gets the
 * accurate name.
 *
 * `draft`/`updated_state` are nullable and are BOTH null on a blocked turn — nothing
 * was parsed, so the caller keeps whatever it had stored.
 */
export const JobPostingChatTurnOutputSchema = z.object({
  reply_text: z.string(),
  blocked: z.boolean().default(false),
  blocked_reason: z.string().nullable().default(null),
  suggested_answers: z.array(z.string()).default([]),
  /** Always true today — this route makes zero LLM calls on every path. */
  is_mock: z.boolean().default(true),
  asked_question_id: z.string().nullable().default(null),
  /**
   * The interview is complete: every essential answered and every must-ask topic
   * raised. The publish step still re-validates against PayerCreateJobPostingSchema.
   */
  draft_ready: z.boolean().default(false),
  draft: JobPostingDraftSchema.nullable().default(null),
  updated_state: JobPostingChatStateSchema.nullable().default(null),
  /** Always null today (no model is called); frozen for the rephrase seam. */
  ai_metadata: AICallMetadataSchema.nullable().default(null),
  pseudonymization_metadata: PseudonymizationMetaSchema.nullable().default(null),
});
export type JobPostingChatTurnOutput = z.infer<typeof JobPostingChatTurnOutputSchema>;
