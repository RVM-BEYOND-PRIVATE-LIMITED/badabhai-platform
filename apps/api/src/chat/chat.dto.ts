import { z } from "zod";
import { MESSAGE_DIRECTIONS } from "@badabhai/types";
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
  blocked: z.boolean(),
  is_mock: z.boolean(),
  suggested_followups: z.array(z.string()).default([]),
  asked_question_id: z.string().nullable().default(null),
  extraction_ready: z.boolean().default(false),
  // CHAT-UE-1: ESSENTIAL topics not yet answered, in ESSENTIAL_TOPICS order;
  // topic ids only, never PII; additive. empty = complete ONLY when
  // `blocked` is false — a blocked turn carries no state (the real service
  // fails closed with updated_state null) and degrades to [], which means
  // "unknown", not "complete". Clients must gate on `blocked` before reading it.
  unanswered_essentials: z.array(z.string()).default([]),
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
  created_at: z.string(),
});
export const SessionMessagesResponseSchema = z.object({
  // OLDEST FIRST — chronological, the order a chat thread is drawn in. The
  // repository read already guarantees it (`listMessages` takes the newest
  // CHAT_HISTORY_MAX then reverses); the service must not re-sort.
  messages: z.array(SessionMessageSchema),
});
export type SessionMessagesResponse = z.infer<typeof SessionMessagesResponseSchema>;
