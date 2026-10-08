/**
 * The profiling-stage free chat (ADR-0051, #2027).
 *
 * Mirrors `apps/ai-service/app/contracts.py`; both suites assert against the golden fixture
 * `__fixtures__/free-chat.keys.json`. Four endpoints:
 * `POST /free-chat/classify` (one message -> one closed category),
 * `POST /free-chat/reply` (one casual or career message -> 1-4 Hinglish lines, or a closed
 * refusal topic), `POST /free-chat/summarize` (Release 2, the rolling notes) and
 * `POST /free-chat/news` (ADR-0054: a news question -> a searched summary with its sources).
 * The reply and the news input take an optional `reply_language` (ADR-0051 §11): the language
 * CODE detected or the worker chose, which the model writes in.
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
  FREE_CHAT_NEWS_KINDS,
  FREE_CHAT_REFUSAL_TOPICS,
  FREE_CHAT_REPLY_CATEGORIES,
  FREE_CHAT_REPLY_LANGUAGES,
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
// Release 2 — the rolling conversation summary. The API stores at most SUMMARY_MAX characters;
// the model's output cap is looser so an over-long summary reaches the API's validator to be
// judged (and rejected) rather than failing at the transport.
const SUMMARY_MAX = 1200;
const SUMMARY_OUTPUT_MAX = 2000;
const SUMMARY_TURNS_MAX = 24;

/**
 * ADR-0051 §11 (R39–R41) — the language the model writes a reply in, from the closed
 * `FREE_CHAT_REPLY_LANGUAGES`. CODE decides it, never the model (R39): the language the API
 * detected in the worker's message (R40), or the one the worker chose to keep for the whole chat
 * (R41). Always Latin letters; `hinglish` covers Hindi in either script.
 */
export const FreeChatReplyLanguageSchema = z.enum(FREE_CHAT_REPLY_LANGUAGES);

/**
 * The optional `reply_language` the reply and the news input carry. Additive and defaulted: null,
 * or a caller that omits it, leaves the prompt's own language rules in force, exactly as before the
 * field existed.
 */
const ReplyLanguageFieldSchema = FreeChatReplyLanguageSchema.nullable().default(null);

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
  /**
   * Release 2 — the worker's rolling free-chat summary (earlier sessions and the turns older than
   * `recent_turns`), so a reply stays continuous across returns. Model-written context, validated
   * by the API before it was stored; never shown to the worker. Additive and defaulted.
   */
  summary: z.string().min(1).max(SUMMARY_MAX).nullable().default(null),
  /** ADR-0051 §11 — the language to reply in; null = the prompt's own rules, as before. */
  reply_language: ReplyLanguageFieldSchema,
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

// ── Release 2 — the rolling conversation summary (ADR-0051 §8) ──────────────────────────────

/**
 * Fold free-chat turns into the worker's summary: the previous summary (null on the first fold)
 * plus the turns that have just aged out of the reply's recent-turn window. Free-chat talk only;
 * interview answers live in the profile and are never sent here.
 */
export const FreeChatSummarizeInputSchema = z.object({
  previous_summary: z.string().min(1).max(SUMMARY_MAX).nullable().default(null),
  turns: z.array(CompanionRecentTurnSchema).min(1).max(SUMMARY_TURNS_MAX),
});
export type FreeChatSummarizeInput = z.infer<typeof FreeChatSummarizeInputSchema>;

/**
 * The updated summary, or null when the model produced nothing usable (the API then keeps the
 * previous one). UNTRUSTED: the API re-validates it (identifiers, the worker's own name, length,
 * template tokens) before storing it.
 */
export const FreeChatSummarizeOutputSchema = z.object({
  summary: z.string().min(1).max(SUMMARY_OUTPUT_MAX).nullable().default(null),
  ai_metadata: AICallMetadataSchema.nullable().default(null),
});
export type FreeChatSummarizeOutput = z.infer<typeof FreeChatSummarizeOutputSchema>;

// ── ADR-0054 (#2127) — live news through web search ─────────────────────────────────────────

const NEWS_SOURCES_MAX = 3;
const NEWS_URL_MAX = 500;
const NEWS_TITLE_MAX = 200;
const NEWS_SITE_MAX = 100;
const NEWS_SEARCHES_MAX = 3;

/**
 * One news question: the worker's message (own name redacted, G2), up to six recent turns for
 * continuity ("aur batao") and the closed worker context, so a work answer can lean toward the
 * worker's trade. The API sends it only after a casual or career reply refused on `news`, and
 * only under the worker's daily cap.
 */
export const FreeChatNewsInputSchema = z.object({
  text: z.string().min(1).max(TEXT_MAX_MESSAGE),
  recent_turns: z.array(CompanionRecentTurnSchema).max(REPLY_TURNS_MAX).default([]),
  worker_context: CompanionCareerWorkerContextSchema.default({
    trade_label: null,
    experience_bucket: null,
  }),
  /**
   * The worker's OPAQUE spend ref (the D-2 attribution the parse and transcription contracts
   * carry), so the ai-service charges this paid, searched call to the per-worker daily spend cap
   * as well as the global ones. Never a name or a phone, and never sent to the model. Nullable
   * and defaulted: a caller that omits it is charged to the global caps only.
   */
  worker_ref: z.string().min(1).nullable().default(null),
  /** ADR-0051 §11 — the language to answer in, as for the reply; null = the prompt's own rules. */
  reply_language: ReplyLanguageFieldSchema,
});
export type FreeChatNewsInput = z.infer<typeof FreeChatNewsInputSchema>;

/**
 * One source a news answer drew on: the "read more" tile. `site` is the host the API shows; the
 * API re-checks that `url` is https and its host is on `FREE_CHAT_NEWS_DOMAINS` before any tile
 * is served, whatever the search returned.
 */
export const FreeChatNewsSourceSchema = z.object({
  url: z.string().min(1).max(NEWS_URL_MAX),
  title: z.string().min(1).max(NEWS_TITLE_MAX),
  site: z.string().min(1).max(NEWS_SITE_MAX),
});
export type FreeChatNewsSource = z.infer<typeof FreeChatNewsSourceSchema>;

/**
 * A searched answer: 1-4 short lines summarising what the sources say, the kind of news, the
 * sources it cited (1-3) and how many searches it ran (each one is charged). UNTRUSTED like every
 * reply: the API runs the free chat's whole reply gate over the lines.
 */
export const FreeChatNewsAnswerSchema = z.object({
  status: z.literal("answer"),
  kind: z.enum(FREE_CHAT_NEWS_KINDS),
  lines: z.array(z.string().min(1).max(REPLY_LINE_MAX)).min(1).max(4),
  sources: z.array(FreeChatNewsSourceSchema).min(1).max(NEWS_SOURCES_MAX),
  search_count: z.number().int().min(0).max(NEWS_SEARCHES_MAX),
  ai_metadata: AICallMetadataSchema.nullable().default(null),
});
export type FreeChatNewsAnswer = z.infer<typeof FreeChatNewsAnswerSchema>;

/** The search ran but found nothing the model could answer from: the API serves its fixed line. */
export const FreeChatNewsNoResultsSchema = z.object({
  status: z.literal("no_results"),
  search_count: z.number().int().min(0).max(NEWS_SEARCHES_MAX),
  ai_metadata: AICallMetadataSchema.nullable().default(null),
});
export type FreeChatNewsNoResults = z.infer<typeof FreeChatNewsNoResultsSchema>;

/**
 * The news model declined on a closed topic (politics or another off-limits subject, a sign of
 * distress, legal / medical / financial advice, anything unsafe). The API serves that topic's
 * fixed line, exactly as for a reply refusal.
 */
export const FreeChatNewsRefuseSchema = z.object({
  status: z.literal("refuse"),
  topic: z.enum(FREE_CHAT_REFUSAL_TOPICS),
  ai_metadata: AICallMetadataSchema.nullable().default(null),
});
export type FreeChatNewsRefuse = z.infer<typeof FreeChatNewsRefuseSchema>;

export const FreeChatNewsOutputSchema = z.discriminatedUnion("status", [
  FreeChatNewsAnswerSchema,
  FreeChatNewsNoResultsSchema,
  FreeChatNewsRefuseSchema,
]);
export type FreeChatNewsOutput = z.infer<typeof FreeChatNewsOutputSchema>;
