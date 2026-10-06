/**
 * The profiling-stage free chat (ADR-0051, #2027).
 *
 * Mirrors `apps/ai-service/app/contracts.py`; both suites assert against the golden fixture
 * `__fixtures__/free-chat.keys.json`. Two endpoints:
 * `POST /free-chat/classify` (one message -> one closed category) and
 * `POST /free-chat/reply` (one casual or career message -> 1-4 Hinglish lines, or a closed
 * refusal topic).
 *
 * PRIVACY: `text`, `pending_question` and the recent turns are worker-facing text; the
 * AI-service applies the masking policy in force (ADR-0047) before `AIRouter`, and the API
 * redacts the worker's own name first (G2). The model's output is UNTRUSTED: the API maps a
 * category to a deterministic handler and re-validates every reply line before a worker reads
 * it (ADR-0051 §4). No field here can hold a name, a phone or an ID number.
 *
 * The closed sets come from `@badabhai/types`, the same source the API and the event spine
 * read. The recent-turn and worker-context shapes are the companion's (one shape, not two).
 */

import { z } from "zod";

import {
  FREE_CHAT_CATEGORIES,
  FREE_CHAT_REFUSAL_TOPICS,
  FREE_CHAT_REPLY_CATEGORIES,
} from "@badabhai/types";

import { AICallMetadataSchema } from "./common";
import { CompanionCareerWorkerContextSchema, CompanionRecentTurnSchema } from "./companion";

// Bounds that are NOT vocabularies, kept beside the schemas so the Pydantic mirror and the
// parity suite have one place to compare.
const TEXT_MAX_CLASSIFY = 1000;
const TEXT_MAX_MESSAGE = 4000;
const PENDING_QUESTION_MAX = 500;
const CLASSIFY_TURNS_MAX = 2;
const REPLY_TURNS_MAX = 6;
const REPLY_LINE_MAX = 300;
const REPLY_CHIP_MAX = 60;

/**
 * The modes a message can be classified IN. `greeting` is never sent: the greeting's Haan /
 * Baad mein is read deterministically, and anything else typed there is classified as `free`.
 */
export const FREE_CHAT_CLASSIFY_MODES = ["free", "resume"] as const;
export type FreeChatClassifyMode = (typeof FREE_CHAT_CLASSIFY_MODES)[number];

/**
 * One message to classify, with at most two recent turns.
 *
 * `pending_question` is the interview question on screen (résumé mode only), so an answer
 * like "5 saal" reads as `resume` rather than chit-chat. Null in free mode.
 */
export const FreeChatClassifyInputSchema = z.object({
  text: z.string().min(1).max(TEXT_MAX_CLASSIFY),
  recent_turns: z.array(CompanionRecentTurnSchema).max(CLASSIFY_TURNS_MAX).default([]),
  mode: z.enum(FREE_CHAT_CLASSIFY_MODES),
  pending_question: z.string().min(1).max(PENDING_QUESTION_MAX).nullable().default(null),
});
export type FreeChatClassifyInput = z.infer<typeof FreeChatClassifyInputSchema>;

/**
 * The classifier's closed category, its confidence and the block flag.
 *
 * The API tells a REAL verdict from an unavailable one by `ai_metadata.real_call === true` and
 * `blocked === false`: a mock, a blocked input, a timeout or a null is "unavailable", which in
 * résumé mode passes the message to today's interview (ADR-0051 §4.3).
 */
export const FreeChatClassifyOutputSchema = z.object({
  category: z.enum(FREE_CHAT_CATEGORIES),
  confidence: z.number().min(0).max(1),
  blocked: z.boolean().default(false),
  ai_metadata: AICallMetadataSchema.nullable().default(null),
});
export type FreeChatClassifyOutput = z.infer<typeof FreeChatClassifyOutputSchema>;

/** One casual or career message plus up to six recent turns and the closed worker context. */
export const FreeChatReplyInputSchema = z.object({
  category: z.enum(FREE_CHAT_REPLY_CATEGORIES),
  text: z.string().min(1).max(TEXT_MAX_MESSAGE),
  recent_turns: z.array(CompanionRecentTurnSchema).max(REPLY_TURNS_MAX).default([]),
  worker_context: CompanionCareerWorkerContextSchema.default({
    trade_label: null,
    experience_bucket: null,
  }),
});
export type FreeChatReplyInput = z.infer<typeof FreeChatReplyInputSchema>;

/**
 * The model's reply: 1-4 short Hinglish lines plus up to three follow-up chips.
 *
 * NOTHING here is trusted. The character caps are deliberately loose: the words-per-line bound
 * belongs to the API's validator, so a bad answer reaches it to be judged rather than being
 * rejected at the transport with the same outcome and a worse diagnosis.
 */
export const FreeChatAnswerSchema = z.object({
  status: z.literal("answer"),
  lines: z.array(z.string().min(1).max(REPLY_LINE_MAX)).min(1).max(4),
  followup_chips: z.array(z.string().min(1).max(REPLY_CHIP_MAX)).max(3).default([]),
  ai_metadata: AICallMetadataSchema.nullable().default(null),
});
export type FreeChatAnswer = z.infer<typeof FreeChatAnswerSchema>;

/**
 * The model refused: one closed topic, and the API serves that topic's fixed line.
 * `unsafe_other` is the catch-all, including for output that fails the schema.
 */
export const FreeChatRefuseSchema = z.object({
  status: z.literal("refuse"),
  topic: z.enum(FREE_CHAT_REFUSAL_TOPICS),
  ai_metadata: AICallMetadataSchema.nullable().default(null),
});
export type FreeChatRefuse = z.infer<typeof FreeChatRefuseSchema>;

export const FreeChatReplyOutputSchema = z.discriminatedUnion("status", [
  FreeChatAnswerSchema,
  FreeChatRefuseSchema,
]);
export type FreeChatReplyOutput = z.infer<typeof FreeChatReplyOutputSchema>;
