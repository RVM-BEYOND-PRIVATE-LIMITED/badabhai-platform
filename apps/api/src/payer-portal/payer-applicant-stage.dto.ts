import type { BadRequestException } from "@nestjs/common";
import { z } from "zod";
import { uuidSchema } from "@badabhai/validators";
import {
  APPLICANT_STAGES,
  APPLICANT_STAGES_V1,
  type ApplicantPostingKind,
  type ApplicantStage,
} from "@badabhai/types";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";

/**
 * The ONE body every not-settable stage gets — an unknown posting, another payer's posting, and a
 * worker who is not on the posting's applicant feed. It is the body the feeds' own neutral 404
 * carries (`GET /payer/reach/jobs/:jobId/applicants`, `PayerApplicantsService.listForOwned`), so
 * the route cannot be used to tell any of those cases apart (no existence oracle).
 */
export const APPLICANT_NOT_FOUND = "Job not found";

/**
 * A stage on the payer's board (`APPLICANT_STAGES`): New / Shortlist / Passed and, from #2747,
 * the outcome stages Selected / Hired. Whether this company may WRITE an outcome stage is the
 * service's question (`OUTCOME_STAGES_ROLLOUT`); every read reports a stored one as itself.
 */
export const ApplicantStageSchema = z.enum(APPLICANT_STAGES);

/**
 * `PUT /payer/reach/jobs/:jobId/applicants/:workerId/stage` route params. `jobId` is the id the
 * per-posting feed takes — an agency `jobs` id or a company `job_postings` id; the server resolves
 * which, exactly as the feed does. Both are syntax-checked here (a malformed id is a 400 and never
 * reaches a query); whether they mean anything is the service's no-oracle question.
 */
export const ApplicantStageParamsSchema = z
  .object({ jobId: uuidSchema, workerId: uuidSchema })
  .strict();
export type ApplicantStageParamsDto = z.infer<typeof ApplicantStageParamsSchema>;

/**
 * The body: the stage to put the applicant in. `.strict()` — there is no slot for a payer id
 * (the payer is the verified session, XB-A), a posting kind (the server resolves it) or a note.
 * `new` moves an applicant back to New.
 */
export const SetApplicantStageSchema = z.object({ stage: ApplicantStageSchema }).strict();
export type SetApplicantStageDto = z.infer<typeof SetApplicantStageSchema>;

/** The body as it was before #2747: the first three stages only. */
const SetApplicantStageV1Schema = z.object({ stage: z.enum(APPLICANT_STAGES_V1) }).strict();

/**
 * The 400 an outcome stage gets while `OUTCOME_STAGES_ROLLOUT` is off for the company: EXACTLY the
 * body the route gave `selected` or `hired` before #2747 (the same pipe over the old body
 * schema), so a company without the switch sees today's API word for word.
 */
export function outcomeStageRefusal(stage: ApplicantStage): BadRequestException {
  try {
    new ZodValidationPipe(SetApplicantStageV1Schema).transform({ stage });
  } catch (err) {
    return err as BadRequestException;
  }
  throw new Error(`outcomeStageRefusal: "${stage}" is one of the first three stages`);
}

/**
 * The response — the same for a change and for a no-op, so a retry reads exactly like the first
 * success (`changed` is the only difference). `previousStage` is what the board held before this
 * request (`new` for an applicant nobody had moved).
 */
export interface SetApplicantStageResponseDto {
  postingId: string;
  /** Which table `postingId` is in — the same value the inbox reports as `posting.kind`. */
  postingKind: ApplicantPostingKind;
  workerId: string;
  stage: ApplicantStage;
  previousStage: ApplicantStage;
  /** `false` when the applicant already held `stage`: nothing was written and no event emitted. */
  changed: boolean;
}
