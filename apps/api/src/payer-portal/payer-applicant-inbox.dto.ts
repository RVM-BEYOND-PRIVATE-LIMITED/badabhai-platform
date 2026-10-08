import { z } from "zod";
import { uuidSchema } from "@badabhai/validators";
import type { ApplicantPostingKind, ApplicantStage } from "@badabhai/types";
import type { ApplicantRowDto } from "../reach/reach.dto";
import type { MatchCandidateRowDto } from "../match/match-candidates.service";
import { decodeInboxCursor, INBOX_CURSOR_MAX_LENGTH } from "./payer-applicant-inbox.cursor";
import { ApplicantStageSchema } from "./payer-applicant-stage.dto";

/** Page size when the caller names none — the payer list convention (ledger: 1..50, default 20). */
export const INBOX_DEFAULT_LIMIT = 20;
/** The largest page one request can read. */
export const INBOX_MAX_LIMIT = 50;

/**
 * `GET /payer/reach/applicants` query. Every key is optional; absent = the first page of every
 * applicant to every posting the SESSION payer owns.
 *
 * NO `payer_id`, ANYWHERE: the payer is the verified session (XB-A). `.strict()` makes a
 * smuggled `payer_id`/`payerId` a 400 rather than a silently ignored key.
 *
 * NO `stage` IN THIS SCHEMA: it is the query while `PAYER_APPLICANT_STAGES_ENABLED` is OFF, and
 * with the flag off nothing persists a stage, so `?stage=` stays the 400 it always was rather than
 * a filter that silently does nothing. With the flag on the route validates with
 * {@link PayerApplicantInboxStagedQuerySchema} instead (`PayerApplicantInboxQueryPipe` picks).
 */
export const PayerApplicantInboxQuerySchema = z
  .object({
    /**
     * Only this posting's applicants. Matches a company posting or an agency job id the session
     * payer owns. An unknown id and another payer's id return the SAME empty page an owned
     * posting with no applicants returns (no existence oracle; see the service).
     */
    postingId: uuidSchema.optional(),
    limit: z.coerce.number().int().min(1).max(INBOX_MAX_LIMIT).default(INBOX_DEFAULT_LIMIT),
    /**
     * The previous page's `nextCursor`, passed back untouched. Absent or empty = the first page.
     * Decoded and validated HERE: a value the server did not mint is a 400 and never reaches a
     * query. A repeated param is an array and also a 400.
     */
    cursor: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z
        .string()
        .max(INBOX_CURSOR_MAX_LENGTH)
        .transform((raw, ctx) => {
          const cursor = decodeInboxCursor(raw);
          if (cursor === null) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: "cursor is malformed" });
            return z.NEVER;
          }
          return cursor;
        })
        .optional(),
    ),
  })
  .strict();

/**
 * The query while `PAYER_APPLICANT_STAGES_ENABLED` is ON (owner ruling 2026-10-07): the base
 * query plus an optional `stage` filter over the saved New / Shortlist / Passed board.
 *
 * `stage=new` matches an applicant with NO stored stage as well as one moved back to `new` — the
 * board's own rule. The filter composes with `postingId` and with the keyset cursor: it narrows
 * the same total order (`created_at DESC, id DESC`) without changing it, so a cursor minted under
 * any filter is a valid position under any other — it carries a position, never a filter. Change
 * the filter, start from the first page (an applicant moved between pages is shown or skipped by
 * the stage he holds when his page is read, never twice).
 */
export const PayerApplicantInboxStagedQuerySchema = PayerApplicantInboxQuerySchema.extend({
  stage: ApplicantStageSchema.optional(),
}).strict();

/** The validated query either schema yields (`stage` only ever set while the flag is on). */
export type PayerApplicantInboxQueryDto = z.infer<typeof PayerApplicantInboxStagedQuerySchema>;

/** Which table the row's posting lives in — the two sources the per-posting route serves. */
export type InboxPostingKind = ApplicantPostingKind;

/**
 * The posting a row belongs to. `id` is the id the per-posting route
 * (`GET /payer/reach/jobs/:jobId/applicants`) and the unlock's `job_id` context take; `title` is
 * the payer's OWN title for it (`jobs.title` / `job_postings.role_title`) — the payer's data,
 * never a worker's, and never in an event.
 */
export interface InboxPostingRefDto<K extends InboxPostingKind = InboxPostingKind> {
  id: string;
  title: string;
  kind: K;
}

/**
 * One inbox row: EXACTLY the per-posting feed row for that applicant — the legacy weighted row
 * for an agency job, the V1 candidate row for a company posting, built by the same code — plus
 * `posting`. Nothing else: `rank` (and, on an agency row, `hot`) is the applicant's position on
 * HIS POSTING's list, not his position in this inbox, which is newest-first.
 *
 * `stage` (owner ruling 2026-10-07) is present on every row while `PAYER_APPLICANT_STAGES_ENABLED`
 * is on — the same value the per-posting feed shows for him — and absent while it is off.
 */
export type InboxApplicantRowDto =
  | (ApplicantRowDto & { posting: InboxPostingRefDto<"agency_job">; stage?: ApplicantStage })
  | (MatchCandidateRowDto & {
      posting: InboxPostingRefDto<"company_posting">;
      stage?: ApplicantStage;
    });

export interface PayerApplicantInboxDto {
  applicants: InboxApplicantRowDto[];
  /** Pass back as `?cursor=` for the next page; `null` when this page is the last. */
  nextCursor: string | null;
}
