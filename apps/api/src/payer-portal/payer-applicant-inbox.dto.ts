import { z } from "zod";
import { uuidSchema } from "@badabhai/validators";
import type { ApplicantRowDto } from "../reach/reach.dto";
import type { MatchCandidateRowDto } from "../match/match-candidates.service";
import { decodeInboxCursor, INBOX_CURSOR_MAX_LENGTH } from "./payer-applicant-inbox.cursor";

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
 * NO `stage`, DELIBERATELY: the per-posting feed exposes no stage. Its New / Shortlist / Passed
 * board is client-local state in payer-web (`applicant-actions.tsx` — "nothing persisted"), and
 * no table or event records one, so there is nothing a server filter could read. `.strict()`
 * turns `?stage=` into a 400 instead of a filter that silently does nothing; a persisted stage is
 * a product ruling plus a schema change, not a query parameter.
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
export type PayerApplicantInboxQueryDto = z.infer<typeof PayerApplicantInboxQuerySchema>;

/** Which table the row's posting lives in — the two sources the per-posting route serves. */
export type InboxPostingKind = "agency_job" | "company_posting";

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
 */
export type InboxApplicantRowDto =
  | (ApplicantRowDto & { posting: InboxPostingRefDto<"agency_job"> })
  | (MatchCandidateRowDto & { posting: InboxPostingRefDto<"company_posting"> });

export interface PayerApplicantInboxDto {
  applicants: InboxApplicantRowDto[];
  /** Pass back as `?cursor=` for the next page; `null` when this page is the last. */
  nextCursor: string | null;
}
