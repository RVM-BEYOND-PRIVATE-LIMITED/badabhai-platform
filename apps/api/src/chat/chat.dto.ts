import { z } from "zod";
import { MESSAGE_DIRECTIONS } from "@badabhai/types";
import { ANSWER_TYPES } from "@badabhai/ai-contracts";
import { uuidSchema, nonEmptyMessageSchema, safeTextSchema } from "@badabhai/validators";

/**
 * Starting a session needs nothing from the body: the worker is taken from the
 * authenticated session (WorkerAuthGuard), never from a client-supplied id.
 */
export const StartSessionSchema = z.object({});
export type StartSessionDto = z.infer<typeof StartSessionSchema>;

export const PostMessageSchema = z.object({
  session_id: uuidSchema,
  // non-empty and bounded; the AI service pseudonymizes before any LLM call.
  text: nonEmptyMessageSchema.pipe(safeTextSchema(4000)),
  /**
   * The client's id for THIS physical send — the reply cache's evidence, not its guess (#931).
   *
   * See `ProfilingAnswerSchema.submission_id` for the defect, the on-device symptom and why an
   * absent id is legal while a malformed one is not. The rule is identical on both submission
   * routes because both funnel through `ChatService.runTurn`, and a rule that held on only one of
   * them would be a second reply cache wearing the first one's name.
   */
  submission_id: uuidSchema.optional(),
});
export type PostMessageDto = z.infer<typeof PostMessageSchema>;

/**
 * Outbound shape of POST /chat/message (CHAT-UE-1). Mirrors the return object
 * `ChatService.postMessage` constructs field-by-field at step 7 — the schema is
 * the outbound boundary check, validated with `safeParse` so a malformed value
 * can never 500 a live chat turn (it degrades, logged, to the explicitly
 * constructed object).
 */
export const PostMessageResponseSchema = z.object({
  session_id: uuidSchema,
  reply: z.string(),
  /**
   * `reply` in DEVANAGARI, for read-aloud only (#896) — never displayed, never echoed back.
   *
   * WHY THE SHOWN STRING CANNOT BE SPOKEN. `reply` is romanized Hinglish ("…resume banate
   * hain") and no on-device voice pronounces it: a `hi-IN` voice is built for Devanagari and
   * mangles the Latin, an `en-IN` voice reads it as English. Verified on device. A worker who
   * cannot read the screen has no way to catch either failure, so the spoken string has to be
   * in the script the voice expects.
   *
   * SAME CONTENT, DIFFERENT SCRIPT — not a translation and not a summary. The two strings say
   * the same sentence, so a worker who reads and a worker who listens answer the same question.
   *
   * OPTIONAL IN THE STRICT SENSE: ABSENT, never null, when no Devanagari is authored for this
   * reply yet. The client falls back to speaking `reply`, which is exactly today's behaviour, so
   * the corpus can fill in progressively without a client release. See `question-tts-text.ts`.
   */
  tts_text: z.string().optional(),
  blocked: z.boolean(),
  is_mock: z.boolean(),
  suggested_followups: z.array(z.string()).default([]),
  /**
   * The SAME options as `suggested_followups`, with the two fields a label cannot carry (#695).
   *
   * WHAT WAS WRONG WITH LABELS ALONE. `toPackOption` builds
   * `{option_key, label_text, value, implies_skill_id, is_none_of_above}` and the response
   * flattened it to `options.map(o => o.label_text)` — so the client addressed everything by
   * display copy, and matched the "none of these" escape against a hardcoded `'Kuch aur'`
   * literal duplicating `DISAMBIGUATION_ESCAPE_LABEL` with no shared source and no binding test.
   * It degraded safely (the escape styled as an ordinary option) but it is a magic string
   * standing in for a flag the server already holds.
   *
   * ALONGSIDE, NOT INSTEAD. `suggested_followups` is unchanged and still authoritative for
   * rendering order; a client that predates this field sees no difference at all.
   *
   * THE SUBMIT PATH IS UNCHANGED, AND MUST STAY THAT WAY. `identify.service.ts` resolves a
   * disambiguation tap by NORMALIZED-LABEL comparison against the stored offer, and states that
   * `option_key` "is never read back". Sending keys back on submit would break disambiguation
   * outright. This carries the key so the client can *reason and style* without string-matching
   * copy — it is not an address to answer at.
   *
   * `value` and `implies_skill_id` are deliberately NOT here: neither is renderable, and
   * `implies_skill_id` is a taxonomy internal with no business on a worker's device.
   */
  suggested_options: z
    .array(
      z.object({
        option_key: z.string(),
        label_text: z.string(),
        /** The escape hatch, as a FLAG rather than as copy the client has to recognise. */
        is_none_of_above: z.boolean(),
      }),
    )
    .default([]),
  asked_question_id: z.string().nullable().default(null),
  extraction_ready: z.boolean().default(false),
  // CHAT-UE-1: ESSENTIAL topics not yet answered, in ESSENTIAL_TOPICS order;
  // topic ids only, never PII; additive. empty = complete ONLY when
  // `blocked` is false — a blocked turn carries no state (the real service
  // fails closed with updated_state null) and degrades to [], which means
  // "unknown", not "complete". Clients must gate on `blocked` before reading it.
  unanswered_essentials: z.array(z.string()).default([]),
  /**
   * This session is FINISHED and will accept no further messages.
   *
   * WHY THE CLIENT NEEDS TO BE TOLD. Flush-at-end introduced a terminal session state
   * that did not exist before: `finalizeInterview` sets `chat_sessions.status = 'ended'`,
   * and every later POST gets a closing line instead of a turn. The app caches its
   * session id in memory and `ensureSession()` short-circuits on it, so without a signal
   * it keeps posting into a dead session for the rest of the process — which silently
   * kills two shipped affordances: the "start a fresh chat" button on the Resume and
   * Profile tabs, and the "Chat pe wapas jaayein" the profile preview offers when a
   * profile comes out thin. The worker is told to go say more, and cannot.
   *
   * ADDITIVE + defaulted false, so a client that predates it sees no change. The client
   * contract is: on `true`, drop the cached session id — the next entry into chat opens
   * a new session rather than posting into the ended one.
   */
  session_ended: z.boolean().default(false),
  /**
   * What KIND of turn this is (OIE Phase 8). Additive, defaulted, and safe for every
   * existing client — `ChatReply.fromJson` ignores unknown keys.
   *
   * `disambiguate` is the one that earns its place: the client currently renders every
   * `suggested_followups` list as a horizontal scroller, which is right for "pick a chip or
   * type instead" and wrong for "which of these four trades are you", where the chip a worker
   * taps becomes their answer of record verbatim. The Frontend issue raised by this phase asks
   * for a single-select list on this value; until then the scroller still works.
   */
  question_kind: z.enum(["ask", "disambiguate", "clarify", "close"]).default("ask"),
  /**
   * Whether the worker may TYPE this answer, or must choose one of `suggested_options`.
   *
   * A NEW FIELD RATHER THAN A `question_kind` VALUE, deliberately. `question_kind` is the only
   * rendering switch shipped clients read, and adding a value to it would change behaviour for
   * builds that have never heard of it — `ChatReply.fromJson` would hand an unrecognised kind to
   * a `switch` written when there were four. This defaults to `text`, so a client that predates
   * it sees a byte-identical body and keeps its keyboard.
   *
   * THE SERVER STILL ACCEPTS TYPED TEXT ON AN `options_only` TURN, and must keep doing so. Every
   * shipped build renders the TextField regardless, so treating this as a validation rather than
   * an instruction would dead-end the experience loop for every worker who has not updated —
   * which is why `LlmTurnService` runs a typed "haan ji" through `parseAffirmation` instead.
   *
   * Two turns set it: the experience loop's Yes/No gate, and a model turn that offers a closed
   * set. Everything the deterministic engine serves is `text`.
   */
  input_mode: z.enum(["text", "options_only"]).default("text"),
  /**
   * Answered / total for the pinned pack, or null when no pack is resolved yet.
   *
   * IMPOSSIBLE UNDER THE LLM PATH, which is why it is new rather than overdue: the model
   * invented each question as it went, so nothing anywhere knew how many were left. A
   * deterministic engine reading a versioned pack knows exactly, and a visible finish line is
   * the biggest single lever on completion rate for low-literacy users.
   */
  progress: z
    .object({ answered: z.number().int().nonnegative(), total: z.number().int().nonnegative() })
    .nullable()
    .default(null),
  /**
   * The worker's trade in their OWN language, once retrieval pins it — the "you have been
   * understood" moment, and the first point in the conversation where the platform proves it
   * heard them. Never `label_en`: "Metal Working Machine Tool Setters and Operators" is not a
   * thing anyone has ever called themselves.
   */
  occupation_label: z.string().nullable().default(null),
  /**
   * What the engine WOULD serve next, keyed by the answer that would produce it — so a client on
   * 2G can render the next question on the tap instead of on the round trip.
   *
   * Keys are `option_key`s of the question currently on screen, plus `__declined` for "nahi pata".
   * A key that is absent simply has no prediction; the whole field is `null` whenever prediction
   * would not be exact (a close, a disambiguation, a free-text question).
   *
   * ADVISORY, AND THE CLIENT CONTRACT SAYS SO. The next real `POST /chat/message` response is
   * authoritative: if it disagrees with what was rendered early, the client replaces it. Nothing
   * here may be treated as an answer of record, and the submit path is unchanged — a worker's tap
   * still goes to the server exactly as before. Rendering early is a display optimisation, not a
   * second engine.
   *
   * WHY THE SERVER COMPUTES IT. Selection depends on the predicate AST, the ask ceilings, the
   * turn window and the settled-ness of every prior answer — and on a pack that is not known
   * until retrieval pins the worker's trade through a vector search. A client-side engine would
   * be a third implementation free to disagree silently.
   *
   * Additive and defaulted, so a client that predates it sees a byte-identical body.
   */
  lookahead: z
    .record(
      z.object({
        question_key: z.string().nullable(),
        /** `close` means the prediction is that the interview ends on this answer. */
        question_kind: z.enum(["ask", "close"]),
        prompt_text: z.string(),
        /** `prompt_text` in Devanagari for read-aloud (#896); absent when unauthored. */
        tts_text: z.string().optional(),
        why_text: z.string().nullable(),
        // THE SAME CLOSED SET the voice form uses for the identical field. An open `z.string()`
        // here would let a contract mismatch reach a client as a value it cannot switch on,
        // rather than failing at the boundary where it can be seen.
        answer_type: z.enum(ANSWER_TYPES).nullable(),
        options: z.array(
          z.object({
            option_key: z.string(),
            label_text: z.string(),
            is_none_of_above: z.boolean(),
          }),
        ),
        progress: z.object({
          answered: z.number().int().nonnegative(),
          total: z.number().int().nonnegative(),
        }),
        /**
         * The turn this prediction is FOR (#766 item 4) — what lets a client detect a stale one
         * instead of trusting it until the real response contradicts it. A re-pin between turns
         * invalidates every entry, and on the voice form a stale prediction is SPOKEN rather than
         * merely repainted.
         */
        turn: z.number().int().nonnegative(),
      }),
    )
    .nullable()
    .default(null),
});
export type PostMessageResponse = z.infer<typeof PostMessageResponseSchema>;

/**
 * `POST /chat/session` response.
 *
 * `opening_text` is the one-shot composite opener and is OPTIONAL in the strict
 * sense: when CHAT_ONE_SHOT_OPENER_ENABLED is off, or the AI service cannot supply
 * it, the key is ABSENT rather than null. A client that predates the flag sees a
 * byte-identical body.
 */
export const StartSessionResponseSchema = z.object({
  session_id: uuidSchema,
  status: z.string(),
  started_at: z.union([z.string(), z.date()]),
  opening_text: z.string().optional(),
  /**
   * `opening_text` in Devanagari for read-aloud (#896) — the first thing a worker ever hears.
   *
   * Until this existed the client had to carry its own hard-coded Devanagari opener, because
   * turn one is the one question never served through the reply path. That copy could only
   * drift from the server's; served here, both sides read one string. Absent when
   * `opening_text` is absent, or when no twin is authored for it.
   */
  opening_tts_text: z.string().optional(),
});
export type StartSessionResponse = z.infer<typeof StartSessionResponseSchema>;

/**
 * Route param for `GET /chat/sessions/:sessionId/messages` (#349). The id arrives
 * in the URL, so it is ATTACKER-CONTROLLED: this schema only proves it is a UUID.
 * Ownership is proved separately in `ChatService.listMessages` — parsing is not
 * permission (same split as the body-supplied session id in #435).
 */
export const SessionMessagesParamSchema = z.object({ sessionId: uuidSchema });
export type SessionMessagesParamDto = z.infer<typeof SessionMessagesParamSchema>;

/**
 * Outbound shape of `GET /chat/sessions/:sessionId/messages` (#349 — transcript
 * hydration). THE VICTIM: with persistent auth, >5 minutes backgrounded re-locks
 * the app; the worker unlocks, lands back on chat, and sees an EMPTY thread
 * because ChatBloc is a locator factory whose transcript lives only in memory —
 * their ten answers are still in `chat_messages`, just not on screen.
 *
 * DELIBERATELY NARROW: three fields, nothing else. `chat_messages` also carries
 * ids, worker_id, message_type, voice_note_id and a metadata JSONB — none of which
 * the client needs to redraw bubbles, so none of which this contract names. The
 * service maps row → this shape field-by-field rather than spreading the row, so a
 * future column cannot silently join the response.
 */
export const SessionMessageSchema = z.object({
  direction: z.enum(MESSAGE_DIRECTIONS),
  // Nullable by construction, not by accident: a voice message exists as a row
  // before its transcript lands (`body_text` still NULL). The client renders the
  // bubble as pending rather than dropping the turn.
  body_text: z.string().nullable(),
  /**
   * `body_text` in Devanagari for read-aloud (#896) — assistant lines only, absent otherwise.
   *
   * A REPLAYED question has to read aloud as correctly as a live one: the worker who unlocks
   * the app and taps the speaker on turn three is the same worker, and the transcript is the
   * only copy they have. Resolved by looking the stored `body_text` up in the sidecar, which is
   * why that table is keyed by reply text — the durable row carries no question_key, and its
   * `metadata` JSONB is a closed slug set that must never hold worker-authored text.
   *
   * NEVER on an inbound line. Those are the worker's own words, already in whatever script they
   * typed, and nothing reads them back to them.
   */
  tts_text: z.string().optional(),
  created_at: z.string(),
});
export const SessionMessagesResponseSchema = z.object({
  // OLDEST FIRST — chronological, the order a chat thread is drawn in. The
  // repository read already guarantees it (`listMessages` takes the newest
  // CHAT_HISTORY_MAX then reverses); the service must not re-sort.
  messages: z.array(SessionMessageSchema),
});
export type SessionMessagesResponse = z.infer<typeof SessionMessagesResponseSchema>;
