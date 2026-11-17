import { z } from "zod";
import { POJ_NOTE_MAX_CHARS } from "@badabhai/db";
import {
  POJ_PAYMENT_STATES,
  type PojHireField,
  type PojPaymentState,
} from "@badabhai/event-schema";
import { ADMIN_ENTITIES_PAGE_DEFAULT, ADMIN_ENTITIES_PAGE_MAX } from "../admin/admin-entities.dto";
import { containsHardIdentifier } from "../common/hard-identifier";

/**
 * #2753 item 11 — the admin contract for the pay-on-joining pilot's hire record.
 *
 *   GET   /admin/pay-on-joining-hires        keyset page, filter by factory, partner, paid state
 *   POST  /admin/pay-on-joining-hires        record a hire
 *   PATCH /admin/pay-on-joining-hires/:id    edit it
 *
 * Every body is `.strict()`: the partner's share (`partner_share_percent`, `partner_share_paise`)
 * is NOT a field here, so a client that sends one is refused with a 400 rather than ignored. The
 * server copies the percent from the setting at create time and computes the share on every fee
 * change. Money is integer paise; dates are calendar days (`YYYY-MM-DD`).
 *
 * No `reason_text` and no Idempotency-Key, on purpose. The record IS the admin's statement (and
 * carries its own `note`); the admin write convention takes an idempotency key only for a money
 * MOVEMENT (`POST /admin/payers/:id/credits`), and nothing here moves money. A retried create is
 * refused by the unique key (`409`), and a repeated edit changes nothing the second time.
 */

/**
 * A calendar date as Postgres `date` stores it: `YYYY-MM-DD`, a day that exists (2026-02-30 is
 * refused, never rolled over), year 1 or later.
 */
export const PojDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
  .refine((s) => {
    const ms = Date.parse(`${s}T00:00:00.000Z`);
    if (Number.isNaN(ms) || Number(s.slice(0, 4)) < 1) return false;
    return new Date(ms).toISOString().slice(0, 10) === s;
  }, "not a valid date");

/**
 * A fee in integer paise: whole, never negative, and a SAFE integer, so the share computation's
 * BigInt product and the database's bigint arithmetic both stay exact. No business ceiling: the
 * pilot's fees are hand-agreed, and coding a limit would be a pricing rule nobody made.
 */
export const FeePaiseSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/**
 * The admin's note: up to 500 characters of their own words, stored on the row only — never
 * logged, never on an event, never on `audit_logs`. It must not become a contact sink either, so a
 * phone, an email, a PAN, an Aadhaar or another hard identifier is refused, as on every admin
 * free-text field.
 */
export const PojNoteSchema = z
  .string()
  .trim()
  .min(1, "Send null to clear the note")
  .max(POJ_NOTE_MAX_CHARS, `Note must be at most ${POJ_NOTE_MAX_CHARS} characters`)
  .refine((value) => containsHardIdentifier(value) === null, {
    message: "Note must not contain a phone number, an email or another hard identifier",
  });

const id = z.string().uuid();

/**
 * Every field an admin writes, keyed EXACTLY as the event's `changed_fields` keys
 * (`POJ_HIRE_FIELDS`): the `satisfies` makes a key missing from either side a compile error.
 * Nullable here means "may be cleared"; the create body makes the required four non-optional.
 */
const hireFieldsShape = {
  factory_payer_id: id,
  job_posting_id: id.nullable(),
  worker_id: id,
  partner_payer_id: id.nullable(),
  joined_on: PojDateSchema,
  stay_checked_on: PojDateSchema.nullable(),
  stayed_30_days: z.boolean().nullable(),
  fee_paise: FeePaiseSchema,
  invoiced_on: PojDateSchema.nullable(),
  factory_paid_on: PojDateSchema.nullable(),
  partner_paid_on: PojDateSchema.nullable(),
  note: PojNoteSchema.nullable(),
} satisfies Record<PojHireField, z.ZodType>;

/** POST /admin/pay-on-joining-hires — the factory, the worker, the joining date and the fee. */
export const CreatePojHireSchema = z
  .object({
    factory_payer_id: hireFieldsShape.factory_payer_id,
    worker_id: hireFieldsShape.worker_id,
    joined_on: hireFieldsShape.joined_on,
    fee_paise: hireFieldsShape.fee_paise,
    job_posting_id: hireFieldsShape.job_posting_id.optional(),
    partner_payer_id: hireFieldsShape.partner_payer_id.optional(),
    stay_checked_on: hireFieldsShape.stay_checked_on.optional(),
    stayed_30_days: hireFieldsShape.stayed_30_days.optional(),
    invoiced_on: hireFieldsShape.invoiced_on.optional(),
    factory_paid_on: hireFieldsShape.factory_paid_on.optional(),
    partner_paid_on: hireFieldsShape.partner_paid_on.optional(),
    note: hireFieldsShape.note.optional(),
  })
  .strict();
export type CreatePojHireDto = z.infer<typeof CreatePojHireSchema>;

/**
 * PATCH /admin/pay-on-joining-hires/:id — any of the fields, at least one. `null` clears a field
 * that can be empty; the factory, the worker, the joining date and the fee cannot be cleared. A fee
 * change recomputes the share with the percent STORED on the row, never today's setting.
 */
export const UpdatePojHireSchema = z
  .object(hireFieldsShape)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to change" });
export type UpdatePojHireDto = z.infer<typeof UpdatePojHireSchema>;

/** `:id` — the hire record's id. */
export const PojHireParamsSchema = z.object({ id }).strict();
export type PojHireParamsDto = z.infer<typeof PojHireParamsSchema>;

/**
 * GET /admin/pay-on-joining-hires. Keyset paging on `(created_at, id)` DESC with the admin entity
 * page bounds (`cursor`, `limit` 1..100, default 50). `paid` is the derived payment state.
 */
export const ListPojHiresQuerySchema = z
  .object({
    factory_payer_id: id.optional(),
    partner_payer_id: id.optional(),
    paid: z.enum(POJ_PAYMENT_STATES).optional(),
    cursor: z.string().min(1).max(256).optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(ADMIN_ENTITIES_PAGE_MAX)
      .optional()
      .default(ADMIN_ENTITIES_PAGE_DEFAULT),
  })
  .strict();
export type ListPojHiresQueryDto = z.infer<typeof ListPojHiresQuerySchema>;

// ----- responses: ids, dates and paise integers --------------------------------------------

/**
 * One hire record. Ids only for the factory, the partner, the job and the worker: no list in the
 * admin API decrypts a payer name under this capability (names are `read_identity`'s, behind
 * `AdminIdentityService`, on the Companies surface), so this one does not either.
 */
export interface PojHireView {
  id: string;
  factory_payer_id: string;
  job_posting_id: string | null;
  worker_id: string;
  partner_payer_id: string | null;
  joined_on: string;
  stay_checked_on: string | null;
  stayed_30_days: boolean | null;
  fee_paise: number;
  /** The setting as it stood when the hire was recorded. */
  partner_share_percent: number;
  /** floor(fee_paise * partner_share_percent / 100), computed by the server. */
  partner_share_paise: number;
  invoiced_on: string | null;
  factory_paid_on: string | null;
  partner_paid_on: string | null;
  note: string | null;
  /** Derived from the dates: `awaiting_factory`, `partner_due` or `settled`. */
  payment_state: PojPaymentState;
  created_by_admin_id: string;
  updated_by_admin_id: string;
  created_at: Date;
  updated_at: Date;
}

/** A write's answer: the record as it now stands; `changed` is false for an edit that moved nothing. */
export interface PojHireWriteResult {
  hire: PojHireView;
  changed: boolean;
}
