import { z } from "zod";
import { uuidSchema } from "@badabhai/validators";
import { APPLICANT_STAGES, type ApplicantPostingKind, type ApplicantStage } from "@badabhai/types";

/**
 * The ONE body every not-settable stage gets — an unknown posting, another payer's posting, and a
 * worker who is not on the posting's applicant feed. It is the body the feeds' own neutral 404
 * carries (`GET /payer/reach/jobs/:jobId/applicants`, `PayerApplicantsService.listForOwned`), so
 * the route cannot be used to tell any of those cases apart (no existence oracle).
 */
export const APPLICANT_NOT_FOUND = "Job not found";

/** A stage on the payer's New / Shortlist / Passed board (`APPLICANT_STAGES`). */
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
