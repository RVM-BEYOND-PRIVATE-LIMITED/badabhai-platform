import { z } from "zod";
import { uuidSchema } from "@badabhai/validators";
import { ACTION_TYPES, ACTION_TARGET_TYPES, ACTION_SOURCE_SURFACES } from "@badabhai/event-schema";

/** A bounded, non-PII context bag (primitives only; short strings). */
const contextSchema = z
  .record(z.string().min(1).max(40), z.union([z.string().max(120), z.number(), z.boolean()]))
  .refine((o) => Object.keys(o).length <= 20, { message: "context may have at most 20 keys" });

/** One worker behavioural action to record. */
export const RecordActionSchema = z
  .object({
    worker_id: uuidSchema,
    action_type: z.enum(ACTION_TYPES),
    target_type: z.enum(ACTION_TARGET_TYPES).optional(),
    target_id: uuidSchema.optional(),
    /** Client-reported time the action happened (supports offline batch flush). */
    client_occurred_at: z.string().datetime({ offset: true }).optional(),
    source_surface: z.enum(ACTION_SOURCE_SURFACES).optional(),
    context: contextSchema.optional(),
  })
  // A target_id is meaningless without knowing what it points at. (target_type
  // alone is fine, e.g. "resume" downloaded where the client has no resume id.)
  .refine((a) => a.target_id == null || a.target_type != null, {
    message: "target_id requires target_type",
    path: ["target_type"],
  });
export type RecordActionDto = z.infer<typeof RecordActionSchema>;

/**
 * A batch of actions. Offline-tolerant clients buffer actions while offline and
 * flush them in one call on reconnect — recorded in a single DB round-trip.
 */
export const RecordActionsBatchSchema = z.object({
  actions: z.array(RecordActionSchema).min(1).max(100),
});
export type RecordActionsBatchDto = z.infer<typeof RecordActionsBatchSchema>;
