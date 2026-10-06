import { z } from "zod";
import { uuidSchema } from "@badabhai/validators";
import { matchSkillIdSchema } from "../match/match.dto";

/** Ops route param — the target agency job id (uuid), never a body id. */
export const OpsAgencyJobParamSchema = z.object({ jobId: uuidSchema }).strict();
export type OpsAgencyJobParamDto = z.infer<typeof OpsAgencyJobParamSchema>;

/**
 * `PUT /ops/agency-jobs/:jobId/match-skills` (ADR-0050 §6.1 step 2, #1983) — the FULL desired
 * set of `mskill_*` ids for one agency job. `[]` resets it to "not chosen yet".
 *
 * SHAPE only here (the shared `matchSkillIdSchema`). Closed-set membership and the runtime
 * `match_config.max_skills_per_posting` cap are enforced in the service by the same
 * `MatchSkillsService.validateSelection` the agency form and the posting form use. `.max(50)` is
 * an anti-abuse request-size bound, not the business cap. `.strict()`: no actor or payer id can
 * ride the body — the actor is the authenticated admin session.
 */
export const OpsSetAgencyJobMatchSkillsSchema = z
  .object({ match_skill_ids: z.array(matchSkillIdSchema).max(50) })
  .strict();
export type OpsSetAgencyJobMatchSkillsDto = z.infer<typeof OpsSetAgencyJobMatchSkillsSchema>;
