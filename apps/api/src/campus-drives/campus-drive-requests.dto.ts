import { z } from "zod";
import { e164PhoneSchema } from "@badabhai/validators";
import type { CampusDriveRequestStatus } from "@badabhai/db";
import {
  BranchIdSchema,
  CampusDateSchema,
  CampusIdempotencyKeySchema,
} from "../campus-link/campus-link.contract";
import { DRIVE_CURSOR_MAX_LENGTH, decodeDriveCursor } from "./campus-drive-cursor";

/**
 * #2746 PR 6 — the company's campus-drive request routes (`/payer/campus-drive-requests`): the
 * wire contract. Bounds are the table's CHECKs (`campus_drive_requests`, migration 0162), so a
 * valid body can never become a 23514 at the insert.
 */

/** `cdr_branch_ids_chk`: at most 50 RVM location ids. */
export const DRIVE_MAX_BRANCHES = 50;
/** The largest location id `rvm_targeting_options` stores (`rto_branch_ref_chk`: ten digits). */
export const DRIVE_MAX_BRANCH_ID = 9_999_999_999;
/** `cdr_openings_chk`. */
export const DRIVE_MAX_OPENINGS = 1000;
/** `cdr_roles_note_chk`. */
export const DRIVE_ROLES_NOTE_MAX = 1000;
/** A person's name: the admin company record's `contact_person` bound. */
export const DRIVE_CONTACT_NAME_MAX = 120;

/** The company list's page size. */
export const DRIVE_LIST_DEFAULT_LIMIT = 20;
export const DRIVE_LIST_MAX_LIMIT = 100;

/**
 * The `Idempotency-Key` header of `POST /payer/campus-drive-requests`: REQUIRED, and in the Campus
 * key charset (`cdr_idempotency_key_chk`), so a missing or malformed key is a 400 before anything
 * runs — never a 23502 / 23514 at the insert.
 */
export const DriveIdempotencyKeySchema = CampusIdempotencyKeySchema;

/**
 * `POST /payer/campus-drive-requests`. STRICT: an unknown key is a 400, so a client cannot believe
 * it set something BadaBhai ignores. `payer_id` and `created_by` are never in the body: both come
 * from the session.
 *
 *   - `job_posting_id`: optional, one of the company's OWN postings (checked in the query with the
 *     tenant key; anything else is the house 404). Its audience is not required to include RVM
 *     students: the posting is context for the roles, not the drive.
 *   - `branch_ids`: RVM location ids, each an ACTIVE branch option (`rvm_targeting_options`);
 *     `[]` (the default) = any branch. Stored sorted and de-duplicated.
 *   - `preferred_from` ≤ `preferred_to`, both calendar dates; neither before today in India
 *     (checked by the service, which owns the clock).
 *   - `roles_note`: free text, hidden characters removed, refused when it holds a phone number,
 *     an email or another hard identifier: the contact goes in its own fields.
 *   - `contact_name`, `contact_phone`: the person the placement team calls. The phone is E.164,
 *     the payer surfaces' house form (`+919876543210`). Both stored only as AES ciphertext.
 */
export const PayerCreateCampusDriveRequestSchema = z
  .strictObject({
    job_posting_id: z.string().uuid().optional(),
    branch_ids: z
      .array(BranchIdSchema.max(DRIVE_MAX_BRANCH_ID))
      .max(DRIVE_MAX_BRANCHES)
      .default([]),
    preferred_from: CampusDateSchema,
    preferred_to: CampusDateSchema,
    openings: z.number().int().min(1).max(DRIVE_MAX_OPENINGS),
    roles_note: z.string().trim().min(1).max(DRIVE_ROLES_NOTE_MAX).optional(),
    contact_name: z.string().trim().min(1).max(DRIVE_CONTACT_NAME_MAX),
    contact_phone: e164PhoneSchema,
  })
  .refine((b) => b.preferred_from <= b.preferred_to, {
    message: "preferred_to must be on or after preferred_from",
    path: ["preferred_to"],
  });
export type PayerCreateCampusDriveRequestDto = z.infer<typeof PayerCreateCampusDriveRequestSchema>;

/** `GET /payer/campus-drive-requests`: newest first, keyset-paged. */
export const PayerListCampusDriveRequestsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(DRIVE_LIST_MAX_LIMIT).default(DRIVE_LIST_DEFAULT_LIMIT),
  /** The previous page's `next_cursor`, untouched. A value the server did not mint is a 400. */
  cursor: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z
      .string()
      .max(DRIVE_CURSOR_MAX_LENGTH)
      .transform((raw, ctx) => {
        const cursor = decodeDriveCursor("company", raw);
        if (cursor === null) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "cursor is malformed" });
          return z.NEVER;
        }
        return cursor;
      })
      .optional(),
  ),
});
export type PayerListCampusDriveRequestsQueryDto = z.infer<
  typeof PayerListCampusDriveRequestsQuerySchema
>;

/**
 * One request as its company reads it. The contact comes back only as the company entered it,
 * and only in part: the name, and the phone's last four digits (the `GET /payer/me` house rule for
 * a payer's own phone). `null` once erased. `decided_by_ref` (a Campus staff id) and `is_test`
 * are not shown to the company.
 */
export interface PayerCampusDriveRequestView {
  id: string;
  job_posting_id: string | null;
  branch_ids: number[];
  preferred_from: string;
  preferred_to: string;
  openings: number;
  roles_note: string | null;
  contact: { name: string; phone_last4: string } | null;
  status: CampusDriveRequestStatus;
  /** The drive's date, while `scheduled` and once `completed`. */
  scheduled_on: string | null;
  /** Campus's id for the drive, as the placement team sent it with `scheduled`. */
  campus_drive_ref: string | null;
  /** The placement team's note on its latest decision (a decline's reason), as written. */
  decision_reason: string | null;
  decided_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

/** `GET /payer/campus-drive-requests`. */
export interface PayerCampusDriveRequestPage {
  drive_requests: PayerCampusDriveRequestView[];
  /** Pass back as `?cursor=` for the next page; `null` when this page is the last. */
  next_cursor: string | null;
}
