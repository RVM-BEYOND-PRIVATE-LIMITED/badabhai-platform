import "server-only";
import { z } from "zod";
import { adminFetch } from "./admin-http";
import { qs } from "./entities";

/**
 * The WORKER JOURNEY data layer — the three reads behind "what happened to this one worker,
 * and where did they get stuck" (`read_entities`).
 *
 *   GET /admin/workers/:id/journey-summary   the 7-step funnel
 *   GET /admin/workers/:id/chat-sessions     their interview sessions, keyset-paginated
 *   GET /admin/chat-sessions/:id             one session in depth, incl. the stuck question
 *
 * Built exactly like `entities.ts`: `server-only`, `adminFetch`, every response Zod-parsed so a
 * shape change surfaces as an honest error state rather than as `undefined` rendering into a
 * blank cell.
 *
 * ══ NO TRANSCRIPT TEXT EXISTS ON THIS SURFACE, BY DESIGN ════════════════════════════════
 * `chat_messages.body_text` and `voice_notes.transcript_text` hold the worker's own words
 * UNMASKED, and serving them would be a materially larger exposure than any capability the
 * portal has — it has had no security review, so the API does not return them and a static
 * guard on the server blocks the columns. What arrives here is question KEYS, statuses, counts,
 * timings, error codes and opaque ids. Nothing in this module asks for more, and no screen
 * built on it should reach for another endpoint to fill the gap.
 *
 * ══ OPEN vs CLOSED SETS ═════════════════════════════════════════════════════════════════
 * Step `status` is a `z.enum` — three values, argued for in the API DTO, and each renders a
 * distinct treatment the UI must have. Everything else that names a state (session status,
 * answer status/source, capture/transcript status, AI job type/status, the stuck `outcome`,
 * and the `caveats` codes) is `z.string()`: those are stored values or a server-side enum the
 * API may extend, and rejecting the whole response over one new member would blank a page that
 * could simply have shown the value. Each has a presenter with an explicit unknown branch.
 */

// ---------------------------------------------------------------------------
// The 7-step funnel
// ---------------------------------------------------------------------------

/**
 * Three statuses, no `not_tracked`. The API DTO argues the fourth out: no step emits it, and a
 * value nobody sends is a case the UI must render and can never see. Honest ABSENCE rides on
 * `caveats` instead, which is per response and is actually populated.
 */
export const journeyStepStatusSchema = z.enum(["done", "in_progress", "not_done"]);
export type JourneyStepStatus = z.infer<typeof journeyStepStatusSchema>;

/** What every funnel row carries, so one component renders all seven. */
const stepBase = {
  /** 1..7, served by the server so the client never re-orders the funnel. */
  order: z.number(),
  status: journeyStepStatusSchema,
  /** Progress numerator, or null where a count is not meaningful for this step. */
  completed: z.number().nullable(),
  total: z.number().nullable(),
  first_at: z.string().nullable(),
  last_at: z.string().nullable(),
};

const packProgressSchema = z.object({
  pack_id: z.string(),
  pack_version: z.number(),
  /** Items in THIS EXACT pack version. 0 ⇒ the version was retired under the answers. */
  item_count: z.number(),
  answer_count: z.number(),
});
export type JourneyPackProgress = z.infer<typeof packProgressSchema>;

/**
 * The seven steps as a DISCRIMINATED UNION on `key`.
 *
 * Discriminated rather than a loose intersection so a component switching on `key` gets the
 * step's own extras narrowed — and so a step whose extras the server stops sending fails the
 * parse instead of rendering "undefined" where a count belongs.
 */
export const journeyStepSchema = z.discriminatedUnion("key", [
  z.object({
    key: z.literal("login"),
    ...stepBase,
    /** REAL logins (`worker.otp_verified`). */
    otp_verified_count: z.number(),
    /** The staging/e2e mint — a distinct event so a test login can never pass as a real one. */
    test_login_count: z.number(),
    last_test_login_at: z.string().nullable(),
    worker_created_at: z.string(),
  }),
  z.object({
    key: z.literal("profiling"),
    ...stepBase,
    answered_count: z.number(),
    declined_count: z.number(),
    unanswered_count: z.number(),
    session_count: z.number(),
    packs: z.array(packProgressSchema),
  }),
  z.object({
    key: z.literal("resume"),
    ...stepBase,
    has_resume: z.boolean(),
    resume_count: z.number(),
    /** How many have a rendered PDF — the async second leg fails on its own. */
    rendered_count: z.number(),
  }),
  z.object({
    key: z.literal("profile_confirmed"),
    ...stepBase,
    profile_status: z.string().nullable(),
    confirmed_at: z.string().nullable(),
    /** One row per extraction, so >1 means re-interviews. */
    profile_count: z.number(),
  }),
  z.object({
    key: z.literal("job_search_apply"),
    ...stepBase,
    search_count: z.number(),
    first_search_at: z.string().nullable(),
    last_search_at: z.string().nullable(),
    applied_count: z.number(),
    skipped_count: z.number(),
  }),
  z.object({ key: z.literal("photo"), ...stepBase, has_photo: z.boolean() }),
  z.object({
    key: z.literal("interview_kit"),
    ...stepBase,
    download_count: z.number(),
    trade_count: z.number(),
    /** True from migration 0079. A zero is NEVER "they never took a kit" — see `caveats`. */
    attribution_available: z.boolean(),
  }),
]);
export type JourneyStep = z.infer<typeof journeyStepSchema>;
export type JourneyStepKey = JourneyStep["key"];

/**
 * The honest-absence channel: a closed set server-side, parsed as strings here.
 *
 * `z.array(z.string())` deliberately. A caveat is the server saying "this measurement does not
 * exist for this data"; rejecting the response because a NEW kind of absence was added would
 * turn the honesty channel into an outage. Unknown codes render as themselves.
 */
const caveatsSchema = z.array(z.string());

export const workerJourneySummarySchema = z.object({
  worker_id: z.string(),
  generated_at: z.string(),
  steps: z.array(journeyStepSchema),
  caveats: caveatsSchema,
});
export type WorkerJourneySummary = z.infer<typeof workerJourneySummarySchema>;

export function getWorkerJourney(workerId: string) {
  return adminFetch(`/admin/workers/${encodeURIComponent(workerId)}/journey-summary`, {
    schema: workerJourneySummarySchema,
  });
}

// ---------------------------------------------------------------------------
// Chat sessions — the list
// ---------------------------------------------------------------------------

export const chatSessionListItemSchema = z.object({
  id: z.string(),
  worker_id: z.string(),
  /** `active` | `ended` | `abandoned` — `abandoned` is the idle sweep's verdict, not the worker's. */
  status: z.string(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  /** When the worker last spoke. The sweep deliberately does NOT stamp this. */
  last_message_at: z.string().nullable(),
  /**
   * Seconds since `last_message_at` AT READ TIME. Null when the worker never spoke at all —
   * itself the signal for a session opened and dropped before a single turn, which is why the
   * UI must not render it as "0s idle".
   */
  idle_seconds: z.number().nullable(),
  /** The pinned OCCUPATION pack. The universal pack is never pinned. */
  pack_id: z.string().nullable(),
  pack_version: z.number().nullable(),
  message_count: z.number(),
  /** DISTINCT question keys this session SETTLED (answered or declined). */
  answer_count: z.number(),
  abandoned: z.boolean(),
});
export type ChatSessionListItem = z.infer<typeof chatSessionListItemSchema>;

export const chatSessionsPageSchema = z.object({
  items: z.array(chatSessionListItemSchema),
  nextCursor: z.string().nullable(),
});
export type ChatSessionsPage = z.infer<typeof chatSessionsPageSchema>;

export interface ChatSessionFilters {
  cursor?: string;
  limit?: number;
  status?: string;
}

export function listWorkerChatSessions(workerId: string, f: ChatSessionFilters = {}) {
  return adminFetch(`/admin/workers/${encodeURIComponent(workerId)}/chat-sessions${qs(f)}`, {
    schema: chatSessionsPageSchema,
  });
}

// ---------------------------------------------------------------------------
// Chat sessions — the detail
// ---------------------------------------------------------------------------

/** One settled answer. THE VALUE IS NEVER SERVED — only that the question settled, and how. */
const sessionAnswerSchema = z.object({
  question_key: z.string(),
  /** `answered` | `declined` | `unanswered`. */
  status: z.string(),
  /** `chat` | `chip` | `form` | `ops` — a chip tap is not the same evidence as parsed prose. */
  source: z.string(),
  pack_id: z.string(),
  pack_version: z.number(),
  answered_at: z.string(),
});
export type SessionAnswer = z.infer<typeof sessionAnswerSchema>;

/**
 * One recorded voice attempt — the row that shows where a worker had to repeat themselves.
 *
 * Superseded attempts are INCLUDED on purpose: "phir se bolein" writes a new row and stamps the
 * old one, and hiding the first attempt would erase the only evidence that the worker had to say
 * it twice. `has_clip` is a boolean derived in Postgres; the voice-note id is never served,
 * because it addresses the row holding the raw transcript.
 */
const sessionVoiceAnswerSchema = z.object({
  id: z.string(),
  question_key: z.string(),
  /** 1 for the first recording. >1 is a re-record. */
  attempt_no: z.number(),
  /** Question position in the session — repeats across attempts of the same question. */
  ordinal: z.number(),
  capture_status: z.string(),
  transcript_status: z.string(),
  /** A CLOSED-SET failure code, never a provider message. */
  transcript_error_code: z.string().nullable(),
  duration_seconds: z.number().nullable(),
  superseded_at: z.string().nullable(),
  superseded_by_id: z.string().nullable(),
  purged_at: z.string().nullable(),
  has_clip: z.boolean(),
  pack_id: z.string(),
  pack_version: z.number(),
  created_at: z.string(),
});
export type SessionVoiceAnswer = z.infer<typeof sessionVoiceAnswerSchema>;

const sessionAiJobSchema = z.object({
  id: z.string(),
  job_type: z.string(),
  status: z.string(),
  model_name: z.string().nullable(),
  real_call: z.boolean().nullable(),
  input_tokens: z.number().nullable(),
  output_tokens: z.number().nullable(),
  total_tokens: z.number().nullable(),
  /**
   * A NUMBER here, unlike every other ₹ on this surface: `ai_jobs.cost_inr` is
   * `double precision`, not `numeric`. Kept as the server sends it rather than "tidied" into a
   * string — a false exactness is its own kind of lie.
   */
  cost_inr: z.number().nullable(),
  /** Derived in Postgres. The MESSAGE is not served: it comes from an external system. */
  has_error: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type SessionAiJob = z.infer<typeof sessionAiJobSchema>;

/**
 * This session's AI spend. NULL — never a zeroed object — when nothing was recorded: those
 * totals accrue only from migration 0077 forward, so an older session has no measurement, and
 * "we did not measure it" is not "it was free".
 */
const sessionAiCostSchema = z.object({
  total_cost_inr: z.string(),
  call_count: z.number(),
  real_call_count: z.number(),
  first_recorded_at: z.string(),
  updated_at: z.string(),
});
export type SessionAiCost = z.infer<typeof sessionAiCostSchema>;

/** One unsettled question the engine served, with everything the ranking judged it on. */
const stuckCandidateSchema = z.object({
  question_key: z.string(),
  /** Times the engine SERVED it. */
  asks: z.number(),
  /** The ceiling actually applied. */
  ask_ceiling: z.number(),
  /** The item's own `max_asks`, or null when the item resolved to no pack row. */
  max_asks: z.number().nullable(),
  /** `asks >= ask_ceiling` — the literal ceiling test, NOT "can never be served again". */
  exhausted: z.boolean(),
  /** THE ENGINE CAN NEVER SERVE THIS AGAIN. Null when `is_mandatory` is unknown. */
  unservable: z.boolean().nullable(),
  /** The answer map holds an `unanswered` record: the engine explicitly moved on. */
  engine_advanced_past: z.boolean(),
  is_mandatory: z.boolean().nullable(),
  is_core: z.boolean().nullable(),
  pack_id: z.string().nullable(),
  pack_version: z.number().nullable(),
  display_order: z.number().nullable(),
});
export type StuckCandidate = z.infer<typeof stuckCandidateSchema>;

/**
 * The stuck-question derivation.
 *
 * `outcome` is `z.string()`, not an enum, and the presenter owns the branching. Five values ship
 * today; the one that matters most is `engine_advanced_past_all` — the interview had CLOSED and
 * nothing was on screen, which is the MODAL shape for a completed session and must never be
 * rendered as "stuck on <the last question they failed>". `stuck_question` is null in every
 * outcome but `resolved`, and the presenter requires BOTH before it will name a question.
 */
const sessionStuckSchema = z.object({
  outcome: z.string(),
  stuck_question: stuckCandidateSchema.nullable(),
  /** EVERY unsettled asked key, ranked best-first — the tie-break made inspectable. */
  candidates: z.array(stuckCandidateSchema),
  asked_count: z.number(),
  settled_count: z.number(),
  /** Candidates that resolved to NO pack item — the ranking was partly blind. */
  unresolved_count: z.number(),
});
export type SessionStuck = z.infer<typeof sessionStuckSchema>;

export const chatSessionDetailSchema = chatSessionListItemSchema.extend({
  answers: z.array(sessionAnswerSchema),
  voice_answers: z.array(sessionVoiceAnswerSchema),
  ai_jobs: z.array(sessionAiJobSchema),
  ai_cost: sessionAiCostSchema.nullable(),
  stuck: sessionStuckSchema,
  caveats: caveatsSchema,
});
export type ChatSessionDetail = z.infer<typeof chatSessionDetailSchema>;

export function getChatSession(sessionId: string) {
  return adminFetch(`/admin/chat-sessions/${encodeURIComponent(sessionId)}`, {
    schema: chatSessionDetailSchema,
  });
}
