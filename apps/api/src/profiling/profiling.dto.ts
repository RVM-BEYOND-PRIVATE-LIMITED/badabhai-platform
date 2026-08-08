import { z } from "zod";
import { ANSWER_TYPES } from "@badabhai/ai-contracts";
import { uuidSchema, safeTextSchema } from "@badabhai/validators";

// The ENGINE'S closed set of turn kinds, not a wire copy of it (#706). Importing the value is what
// makes "the two cannot drift" a fact rather than a test — see `question_kind` below.
import { TURN_KINDS } from "./conversation-state";

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
    /**
     * A recorded clip, already uploaded and registered as a `voice_notes` row.
     *
     * ONLY THE ID CROSSES. Not the storage path, not the duration, not the transcript — every one
     * of those is read from the row server-side, because a caller who could name the path could
     * have arbitrary audio fetched and billed to them, and a caller who could name the duration
     * could walk past the 30-second cap that keeps this on a single provider call.
     */
    z.object({ kind: z.literal("spoken"), voice_note_id: uuidSchema }),
  ]),
});
export type ProfilingAnswerDto = z.infer<typeof ProfilingAnswerSchema>;

/**
 * A correction: change an answer the engine has already settled and moved past.
 *
 * THE WIRE SHAPE THE REVIEW SCREEN'S ⟲ NEEDED AND DID NOT HAVE (#700). It is deliberately
 * `ProfilingAnswerSchema` minus the question-on-screen guard and plus a required key, because the
 * two routes are opposites in exactly one respect:
 *
 *  - `POST /answer` 409s when `question_key` is NOT the question on screen. That guard is what
 *    stops a timed-out retry landing on the next question.
 *  - `POST /correct` requires that the question is NOT on screen — it must already be SETTLED. A
 *    question still in front of the worker is the turn loop's business, and answering it through
 *    here would spend no ask budget and record no turn.
 *
 * `question_key` is non-nullable here, where the answer route allows null: the disambiguation turn
 * belongs to no pack, and there is no such thing as correcting it after the fact — the pack it
 * pinned has already decided every question that followed.
 *
 * THE SAME FOUR ANSWER SHAPES, on purpose. #632 specifies the correction affordance as chips →
 * mic → typing, in that order; supporting a subset would leave a worker who cannot type able to
 * see a wrong value and unable to fix it, which is the whole failure this route exists to prevent.
 */
export const ProfilingCorrectionSchema = z.object({
  session_id: uuidSchema,
  question_key: z
    .string()
    .regex(/^[a-z_]+$/)
    .max(40),
  answer: ProfilingAnswerSchema.shape.answer,
});
export type ProfilingCorrectionDto = z.infer<typeof ProfilingCorrectionSchema>;

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
  /**
   * The "none of these" escape, as a FLAG rather than as copy the client has to recognise (#706).
   *
   * The chat surface got this in #704 and this one did not, which left the escape hatch —
   * "Kuch aur" — addressable only by matching display text against a literal duplicating
   * `DISAMBIGUATION_ESCAPE_LABEL`, with no shared source and nothing binding the two. A copy
   * change would silently strand whatever branch the client wrote against it, and this is the
   * surface where the escape is the option a confused worker most needs to find.
   *
   * DEFAULTED, not required: additive to a schema a shipped client already reads, so a client
   * predating it is unaffected and every pack option (which never sets it) reads `false`.
   */
  is_none_of_above: z.boolean().default(false),
});

const ProfilingQuestionSchema = z.object({
  /** Null on the disambiguation turn, which belongs to no pack. */
  question_key: z.string().nullable(),
  /**
   * WHAT KIND of question this is — the thing a client was otherwise obliged to infer (#706).
   *
   * `z.enum(TURN_KINDS)` AND NOT A SECOND ENUM. The engine's closed set is the wire's closed set
   * here, so there is no containment to police and no way for the two to drift; the chat surface
   * declares a superset only because `question_kind` shipped there before `TurnKind` existed.
   *
   * Without it the only way to recognise a disambiguation turn was `question_key === null` — an
   * implicit contract reverse-engineered from a comment, and precisely the shape that let the chat
   * surface render a trade list in the horizontal chip scroller until #695. On this surface the
   * worker is being READ TO: "which of these did you mean?" and "what work do you do?" are
   * different interactions, and a client that cannot tell them apart cannot speak them differently.
   *
   * `close` IS DECLARED AND UNREACHABLE HERE, which is not an oversight. A completed turn becomes
   * `{ kind: "done" }` one level up, so no question step ever carries it — but re-deriving a
   * narrower enum for that would be the second declaration this field exists to avoid.
   *
   * DEFAULTED to `ask`, so a client predating the field is unaffected.
   */
  question_kind: z.enum(TURN_KINDS).default("ask"),
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

/** Declared AFTER `ProfilingReviewRowSchema` because it embeds it — these are values, not types. */
export const ProfilingCorrectionResponseSchema = z.object({
  session_id: uuidSchema,
  question_key: z.string(),
  /**
   * The corrected row as the review screen should now draw it — the same shape a review row has,
   * so the client redraws one line rather than re-fetching the whole screen on a 2G link.
   */
  row: ProfilingReviewRowSchema,
  /** Corrections this session has taken, so a client can show the cap approaching. */
  correction_count: z.number().int().positive(),
  /**
   * Whether a profile had already been built when this landed.
   *
   * TRUE MEANS THE STORED ANSWER IS NOW RIGHT AND THE BUILT PROFILE IS STALE. The correction is
   * durable either way, and an extraction still sitting in the queue reads the corrected state —
   * but re-running one that has already COMPLETED crosses three deliberate dedupe guards (#700),
   * and that is a separate ruling. Surfaced rather than silently decided.
   */
  profile_rebuild_required: z.boolean(),
});
export type ProfilingCorrectionResponse = z.infer<typeof ProfilingCorrectionResponseSchema>;

export const FinalizeProfilingResponseSchema = z.object({
  session_id: uuidSchema,
  /** True once the interview is durably committed — the client's "profile is being built". */
  committed: z.boolean(),
});
export type FinalizeProfilingResponse = z.infer<typeof FinalizeProfilingResponseSchema>;
