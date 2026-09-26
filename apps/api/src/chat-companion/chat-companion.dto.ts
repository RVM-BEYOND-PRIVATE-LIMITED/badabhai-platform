import { z } from "zod";
import { nonEmptyMessageSchema, safeTextSchema, uuidSchema } from "@badabhai/validators";
import { PostMessageResponseSchema } from "../chat/chat.dto";

/**
 * `POST /chat/companion/message` body. The same text rules as `POST /chat/message` — non-empty,
 * bounded, safe — and the same optional per-send `submission_id` (the event's dedupe key). No
 * session id: the companion has no session; the worker comes from the bearer token.
 */
export const CompanionMessageSchema = z.object({
  text: nonEmptyMessageSchema.pipe(safeTextSchema(4000)),
  submission_id: uuidSchema.optional(),
});
export type CompanionMessageDto = z.infer<typeof CompanionMessageSchema>;

/**
 * One companion turn. DELIBERATELY THE CHAT REPLY'S OWN SHAPE MINUS `session_id`, so the worker
 * app parses it with the parser it already has (`ChatReply.fromJson` reads named keys only and
 * never `session_id`) and draws it with the widgets it already has. Plus:
 *   - `mode: "companion"` — the discriminant;
 *   - `digest_key` — a short hash of the facts the turn was composed from, so a tab refocus can
 *     tell "nothing changed" from "your counts moved" without comparing copy.
 *
 * `.strict()` because this wire is new and no shipped client depends on its leniency: a field
 * that is not declared here is a leak, and the service fails closed on it rather than sending it.
 */
export const CompanionTurnSchema = PostMessageResponseSchema.omit({ session_id: true })
  .extend({
    mode: z.literal("companion"),
    digest_key: z.string().min(1).max(64).optional(),
  })
  .strict();
export type CompanionTurn = z.infer<typeof CompanionTurnSchema>;

/** Not a companion worker (or the flag is off): the app runs today's chat. */
export const CompanionInterviewSchema = z.object({ mode: z.literal("interview") }).strict();
export type CompanionInterview = z.infer<typeof CompanionInterviewSchema>;

/** `GET /chat/companion`. */
export const CompanionOpenResponseSchema = z.discriminatedUnion("mode", [
  CompanionInterviewSchema,
  CompanionTurnSchema,
]);
export type CompanionOpenResponse = z.infer<typeof CompanionOpenResponseSchema>;
