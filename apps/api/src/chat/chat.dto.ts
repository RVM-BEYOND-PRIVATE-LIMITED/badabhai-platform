import { z } from "zod";
import { uuidSchema, nonEmptyMessageSchema, safeTextSchema } from "@badabhai/validators";

export const StartSessionSchema = z.object({
  worker_id: uuidSchema,
});
export type StartSessionDto = z.infer<typeof StartSessionSchema>;

export const PostMessageSchema = z.object({
  session_id: uuidSchema,
  worker_id: uuidSchema,
  // non-empty and bounded; the AI service pseudonymizes before any LLM call.
  text: nonEmptyMessageSchema.pipe(safeTextSchema(4000)),
});
export type PostMessageDto = z.infer<typeof PostMessageSchema>;
