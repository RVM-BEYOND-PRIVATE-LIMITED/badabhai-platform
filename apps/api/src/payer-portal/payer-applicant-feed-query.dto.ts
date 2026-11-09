import { z } from "zod";
import { APPLICANT_STAGES } from "@badabhai/types";

/**
 * The values `GET /payer/reach/jobs/:jobId/applicants?stage=` accepts while
 * `PAYER_APPLICANT_STAGES_ENABLED` is on (#2737).
 *
 * `all` is the saved board's own view: every applicant, each row labelled with its
 * stage (payer-web's New / Shortlist / Passed tabs ask for it). The three real stages
 * narrow the feed to that one stage. Absent means `new` — the actionable feed of
 * applicants nobody has handled yet, so a rejected or selected applicant is gone on
 * the next read regardless of which client is asking.
 */
export const APPLICANT_FEED_STAGES = Object.freeze([...APPLICANT_STAGES, "all"] as const);
export type ApplicantFeedStage = (typeof APPLICANT_FEED_STAGES)[number];

/**
 * The per-posting feed query while the flag is on. Unknown keys are ignored exactly as
 * this route ignored every query parameter before `stage` existed; `payer_id` has no
 * slot and is never read (the verified session payer is the identity, XB-A).
 */
export const PayerApplicantFeedQuerySchema = z.object({
  stage: z.enum(APPLICANT_FEED_STAGES).default("new"),
});

/** The validated query (`stage` is optional only for the flag-off branch, which returns `{}`). */
export type PayerApplicantFeedQueryDto = z.input<typeof PayerApplicantFeedQuerySchema>;
