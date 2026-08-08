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

// ---------------------------------------------------------------------------
// The worker-authenticated shape (#694)
// ---------------------------------------------------------------------------

/**
 * The most a batch may carry, shared by the wire schema and the rate-limit cost.
 *
 * Named rather than inlined so the two cannot disagree: the cap on ONE request and the cap on an
 * hour of them are the same bound at different scales, and a literal in each place is how those
 * drift.
 */
export const WORKER_ACTIONS_BATCH_MAX = 100;

/**
 * One action recorded BY THE WORKER THEMSELVES — the same shape as {@link RecordActionSchema}
 * with `worker_id` removed.
 *
 * NO `worker_id`, AND `.strict()` SO SENDING ONE IS A 400 RATHER THAN A NO-OP. The acting worker
 * comes from the bearer token via `@CurrentWorker`, never from the body (the #435 precedent). A
 * permissive schema that merely IGNORED a supplied `worker_id` would be equally safe and much
 * worse to reason about: a client could ship code that believes it is attributing an action to
 * someone, and nothing would ever tell it otherwise. Rejecting makes the contract legible at the
 * first request instead of at an analytics post-mortem.
 *
 * ON `target_id`. It is carried unverified, and that is deliberate rather than overlooked: it is a
 * LABEL on the worker's own action, never an access path. `actor` and `subject` are both stamped
 * from the token, so a worker naming someone else's resume here cannot attribute engagement to
 * them, read anything, or change anything — the only outcome is a self-inflicted wrong label on
 * their own row. The two voice-form signals this route exists for send no target at all.
 */
export const WorkerRecordActionSchema = z
  .object({
    action_type: z.enum(ACTION_TYPES),
    target_type: z.enum(ACTION_TARGET_TYPES).optional(),
    target_id: uuidSchema.optional(),
    /** Client-reported time the action happened — the whole point of a buffered flush. */
    client_occurred_at: z.string().datetime({ offset: true }).optional(),
    source_surface: z.enum(ACTION_SOURCE_SURFACES).optional(),
    context: contextSchema.optional(),
  })
  .strict()
  // Same refinement as the internal schema: a target_id is meaningless without knowing what it
  // points at. (target_type alone is fine — "resume" downloaded, where the client has no id.)
  .refine((a) => a.target_id == null || a.target_type != null, {
    message: "target_id requires target_type",
    path: ["target_type"],
  });
export type WorkerRecordActionDto = z.infer<typeof WorkerRecordActionSchema>;

/**
 * A worker's buffered batch, flushed on reconnect or at session end.
 *
 * The bound is the SAME 100 the internal route allows. It is a size bound only — the rate bound
 * is per worker per hour and counts ACTIONS, because a size cap alone lets one caller send
 * unlimited full batches.
 */
export const WorkerRecordActionsBatchSchema = z
  .object({
    actions: z.array(WorkerRecordActionSchema).min(1).max(WORKER_ACTIONS_BATCH_MAX),
  })
  .strict();
export type WorkerRecordActionsBatchDto = z.infer<typeof WorkerRecordActionsBatchSchema>;
