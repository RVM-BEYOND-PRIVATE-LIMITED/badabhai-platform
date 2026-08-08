import { z } from "zod";
import { ANSWER_TYPES } from "@badabhai/ai-contracts";
import { uuidSchema, safeTextSchema } from "@badabhai/validators";

/**
 * The voice-form wire contract.
 *
 * WHY THIS IS NOT `chat.dto.ts`. Both surfaces run the SAME interview through the same
 * orchestrator and flush to the same tables — that is the owner's one-pipeline ruling and it is
 * upheld by `ChatService.runTurn`, which both call. What differs is what a client has to be told
 * in order to DRAW a question, and the difference is not cosmetic:
 *
 *  - Chat sends chip LABELS (`suggested_followups`) because its client renders a scroller and the
 *    worker can always type instead. The voice form must send back the `option_key` the worker
 *    tapped, so it needs keys, and the server does the key → label mapping (never the client:
 *    a label is the worker's answer of record verbatim, and letting a client choose it makes the
 *    stored answer a thing the client decided).
 *  - `answer_type` has no chat analogue and cannot be inferred. All 236 boolean pack items carry
 *    ZERO options, so "no options" does not mean "speak your answer" — a client keying chips off
 *    `options.length` renders a mic for a yes/no question, and a worker who cannot type has no
 *    way to answer it.
 *  - `why_text` is the ⓘ affordance. On chat a confused worker types "matlab?" and spends a turn;
 *    on a screen they cannot read, the explanation has to be available without spending anything.
 *
 * NOTHING HERE IS PII. Every field is engine-authored pack copy, a closed-vocabulary key, or a
 * count — the one exception is the review read, whose values are the worker's OWN answers
 * returned to the worker themselves, and which is response-only and never logged or evented.
 */

/** Opening a session takes nothing from the body — the worker comes from the bearer token. */
export const StartProfilingSessionSchema = z.object({}).strict();
export type StartProfilingSessionDto = z.infer<typeof StartProfilingSessionSchema>;

/**
 * One answer. Exactly one payload shape, chosen by `kind` — a discriminated union rather than
 * four optional fields, so "chips AND text" is rejected at the boundary instead of being
 * silently resolved by whichever branch the service happens to test first.
 */
export const ProfilingAnswerSchema = z.object({
  session_id: uuidSchema,
  /**
   * The question the CLIENT believes is on screen. 409 when it is not.
   *
   * NOT redundant with the session id. A worker on a bad connection whose submit timed out
   * retries; if the first attempt landed, the engine has moved on, and without this the retry
   * would be captured as the answer to the NEXT question. The reply cache catches that only
   * inside a ten-second window and only for identical text — a re-record produces different
   * words, so it misses exactly the case that matters most here.
   *
   * Nullable because the disambiguation turn belongs to no pack and has no key.
   */
  question_key: z
    .string()
    .regex(/^[a-z_]+$/)
    .max(40)
    .nullable(),
  answer: z.discriminatedUnion("kind", [
    /** Free text — including "Nahi pata", which the ENGINE maps to declined. No client skip. */
    z.object({ kind: z.literal("text"), text: safeTextSchema(4000).pipe(z.string().min(1)) }),
    /**
     * Chip taps, as KEYS. One for a single-select, any number for a multi-select.
     *
     * Bounded at 20: the widest authored item carries far fewer, and an unbounded array is a
     * free amplification of the label lookup on a route a worker's device can call at will.
     */
    z.object({
      kind: z.literal("chips"),
      option_keys: z.array(z.string().max(64)).min(1).max(20),
    }),
    /** A Haan/Nahi tap. The 236 boolean items carry no options, so the CLIENT renders these. */
    z.object({ kind: z.literal("boolean"), value: z.boolean() }),
  ]),
});
export type ProfilingAnswerDto = z.infer<typeof ProfilingAnswerSchema>;

export const ProfilingSessionParamSchema = z.object({ sessionId: uuidSchema });
export type ProfilingSessionParamDto = z.infer<typeof ProfilingSessionParamSchema>;

export const FinalizeProfilingSchema = z.object({ session_id: uuidSchema });
export type FinalizeProfilingDto = z.infer<typeof FinalizeProfilingSchema>;

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

const ProfilingOptionSchema = z.object({
  option_key: z.string(),
  label_text: z.string(),
});

const ProfilingQuestionSchema = z.object({
  /** Null on the disambiguation turn, which belongs to no pack. */
  question_key: z.string().nullable(),
  prompt_text: z.string().min(1),
  answer_type: z.enum(ANSWER_TYPES).nullable(),
  options: z.array(ProfilingOptionSchema),
  why_text: z.string().nullable(),
  /**
   * The pre-rendered audio for `prompt_text`, content-addressed — `sha256(normalize(text))[:16]`,
   * the same id `reply-closure.json` is keyed by, so a client resolves a bundled asset by name
   * without a round trip.
   *
   * AN ID THAT RESOLVES TO NOTHING IS THE DESIGNED DEGRADATION, not a bug. A reply outside the
   * closure — the disambiguation prompt is built from retrieval and belongs to no pack — simply
   * has no asset, and the client falls back to text. Content addressing is what makes that safe:
   * the only way to get the WRONG audio is a sha256 collision, and `assertNoCollisions` already
   * refuses to build a manifest containing one.
   */
  tts_clip_id: z.string(),
});

/**
 * What the engine served: a question, or the end of the interview.
 *
 * A DISCRIMINATED UNION rather than a nullable question, because "no question" and "the interview
 * is over" are different facts and a client that conflated them would show the review screen to a
 * worker whose turn merely failed.
 */
export const ProfilingStepSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("question"),
    question: ProfilingQuestionSchema,
    /** 1-based position and the pinned pack's total, for the dot rail. Never a percentage. */
    index: z.number().int().positive(),
    total: z.number().int().nonnegative(),
  }),
  z.object({ kind: z.literal("done") }),
  /**
   * Nothing was written and the worker may send that again.
   *
   * DISTINCT FROM AN HTTP ERROR, deliberately. A lost CAS or an unresolvable pack is not the
   * client's fault and not a crash; the honest response is the retryable line the chat surface
   * has always served, and a 5xx here would make an offline queue treat a recoverable turn as a
   * dead letter.
   */
  z.object({ kind: z.literal("unavailable"), reply: z.string() }),
]);
export type ProfilingStep = z.infer<typeof ProfilingStepSchema>;

export const ProfilingSessionResponseSchema = z.object({
  session_id: uuidSchema,
  step: ProfilingStepSchema,
});
export type ProfilingSessionResponse = z.infer<typeof ProfilingSessionResponseSchema>;

export const ProfilingStepResponseSchema = z.object({ step: ProfilingStepSchema });
export type ProfilingStepResponse = z.infer<typeof ProfilingStepResponseSchema>;

/**
 * One row of the review screen — the worker's own answer, read back to them.
 *
 * `display_value` is the NORMALIZED value rendered for a human, not the raw utterance: the point
 * of the review is to show what was UNDERSTOOD, because that is what reaches the profile. Showing
 * the raw words back would confirm the recording worked while hiding a mis-capture.
 */
export const ProfilingReviewRowSchema = z.object({
  question_key: z.string(),
  prompt_text: z.string(),
  status: z.enum(["answered", "declined", "unanswered"]),
  display_value: z.string().nullable(),
});

export const ProfilingReviewResponseSchema = z.object({
  session_id: uuidSchema,
  complete: z.boolean(),
  rows: z.array(ProfilingReviewRowSchema),
});
export type ProfilingReviewResponse = z.infer<typeof ProfilingReviewResponseSchema>;

export const FinalizeProfilingResponseSchema = z.object({
  session_id: uuidSchema,
  /** True once the interview is durably committed — the client's "profile is being built". */
  committed: z.boolean(),
});
export type FinalizeProfilingResponse = z.infer<typeof FinalizeProfilingResponseSchema>;
