import { z } from "zod";
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
