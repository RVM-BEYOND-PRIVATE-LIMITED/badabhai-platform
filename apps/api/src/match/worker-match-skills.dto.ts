import { z } from "zod";

import { matchSkillIdSchema } from "./match.dto";

/**
 * E4 — the WORKER's own match-skills surface. The payer's counterpart lives in
 * `match.dto.ts`; keeping the two apart is deliberate, because a worker write and a payer
 * write must not share a validation boundary by accident.
 *
 * Validity here is SHAPE (`mskill_*`), because the closed vocabulary lives in
 * `@badabhai/taxonomy` and is checked in `WorkerSkillsService`. A shape-valid id outside the
 * closed set is a 400; a closed-set id the worker does not hold is a 404 — two different
 * questions, answered in two different places, on purpose.
 */

/** The `:skillId` path parameter of the single-skill toggle. */
export const MatchSkillIdParamSchema = matchSkillIdSchema;
export type MatchSkillIdParam = z.infer<typeof MatchSkillIdParamSchema>;

/**
 * `PUT /workers/me/match-skills/:skillId/wants` — the worker's own yes/no.
 *
 * `wants` is the RESULTING state, not a toggle: sending it twice means what sending it once
 * meant, which is what makes the route idempotent (and why it is a PUT). Strict, so a client
 * cannot smuggle a `worker_id` or a second skill id into the body.
 */
export const SetMatchSkillWantsSchema = z
  .object({
    wants: z.boolean(),
  })
  .strict();
export type SetMatchSkillWantsDto = z.infer<typeof SetMatchSkillWantsSchema>;
