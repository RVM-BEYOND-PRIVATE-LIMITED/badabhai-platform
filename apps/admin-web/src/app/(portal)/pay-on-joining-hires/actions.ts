"use server";

import { z } from "zod";
import { adminFetch, isAdminRequestError } from "../../../lib/admin-http";
import { describeAdminActionError } from "../../../lib/describe-admin-error";
import type {
  AdminActionFailure,
  AdminActionSuccess,
} from "../../../lib/admin-action-result";
import {
  PAY_ON_JOINING_ALREADY_RECORDED,
  PAY_ON_JOINING_NOTE_MAX,
  PAY_ON_JOINING_SWITCHED_OFF,
  rupeesToPaise,
} from "../../../lib/pay-on-joining-vocabulary";

/**
 * The pay-on-joining hire record's governed writes (#2753 item 11).
 *
 * Every form value is validated here before anything is sent. The body carries ONLY the twelve
 * fields the API accepts: the partner's share (`partner_share_percent`, `partner_share_paise`),
 * the derived `payment_state` and the admin ids are never sent, because the API's body schemas
 * are strict and refuse them.
 */

const date = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
  .refine((value) => {
    const ms = Date.parse(`${value}T00:00:00.000Z`);
    if (Number.isNaN(ms) || Number(value.slice(0, 4)) < 1) return false;
    return new Date(ms).toISOString().slice(0, 10) === value;
  }, "not a valid date");

const uuid = z.string().uuid();

const bodySchema = z
  .object({
    factory_payer_id: uuid,
    job_posting_id: uuid.nullable(),
    worker_id: uuid,
    partner_payer_id: uuid.nullable(),
    joined_on: date,
    stay_checked_on: date.nullable(),
    stayed_30_days: z.boolean().nullable(),
    fee_paise: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    invoiced_on: date.nullable(),
    factory_paid_on: date.nullable(),
    partner_paid_on: date.nullable(),
    note: z.string().trim().min(1).max(PAY_ON_JOINING_NOTE_MAX).nullable(),
  })
  .strict();

type HireBody = z.infer<typeof bodySchema>;

const writeResultSchema = z.object({
  hire: z.object({ id: z.string() }),
  changed: z.boolean(),
});

export interface PayOnJoiningHireInput {
  factoryPayerId: string;
  workerId: string;
  jobPostingId?: string | null;
  partnerPayerId?: string | null;
  joinedOn: string;
  stayCheckedOn?: string | null;
  stayed30Days?: boolean | null;
  /** The fee as typed in rupees; converted to integer paise before it is sent. */
  feeRupees: string;
  invoicedOn?: string | null;
  factoryPaidOn?: string | null;
  partnerPaidOn?: string | null;
  note?: string | null;
}

export type PayOnJoiningHireOutcome = AdminActionSuccess | AdminActionFailure;

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed === "" ? null : trimmed;
}

/** The one accepted body, built from the form's values. */
function toBody(input: PayOnJoiningHireInput): HireBody | { error: string } {
  const feePaise = rupeesToPaise(input.feeRupees);
  if (feePaise === null) {
    return { error: "Enter the fee in rupees, with at most two decimal places." };
  }
  return {
    factory_payer_id: input.factoryPayerId.trim(),
    job_posting_id: blankToNull(input.jobPostingId),
    worker_id: input.workerId.trim(),
    partner_payer_id: blankToNull(input.partnerPayerId),
    joined_on: input.joinedOn.trim(),
    stay_checked_on: blankToNull(input.stayCheckedOn),
    stayed_30_days: input.stayed30Days ?? null,
    fee_paise: feePaise,
    invoiced_on: blankToNull(input.invoicedOn),
    factory_paid_on: blankToNull(input.factoryPaidOn),
    partner_paid_on: blankToNull(input.partnerPaidOn),
    note: blankToNull(input.note),
  };
}

function ruleError(body: HireBody): string | null {
  if ((body.stay_checked_on === null) !== (body.stayed_30_days === null)) {
    return "Enter both the 30-day check date and its outcome, or neither.";
  }
  if (body.partner_paid_on !== null && body.partner_payer_id === null) {
    return "Add the partner before recording when the partner was paid.";
  }
  if (body.partner_payer_id !== null && body.partner_payer_id === body.factory_payer_id) {
    return "The partner must be a different company from the factory.";
  }
  return null;
}

function validate(input: PayOnJoiningHireInput): HireBody | { error: string } {
  const built = toBody(input);
  if ("error" in built) return built;
  const parsed = bodySchema.safeParse(built);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the hire details." };
  }
  const rule = ruleError(parsed.data);
  return rule === null ? parsed.data : { error: rule };
}

/** POST /admin/pay-on-joining-hires — record one hire. A duplicate is the API's 409. */
export async function createPayOnJoiningHireAction(
  input: PayOnJoiningHireInput,
): Promise<PayOnJoiningHireOutcome> {
  const parsed = validate(input);
  if ("error" in parsed) return { ok: false, error: parsed.error };
  try {
    const res = await adminFetch("/admin/pay-on-joining-hires", {
      method: "POST",
      body: parsed,
      schema: writeResultSchema,
    });
    return {
      ok: true,
      changed: res.changed,
      message: "Hire recorded.",
    };
  } catch (err) {
    if (isAdminRequestError(err) && err.status === 409) {
      return { ok: false, error: PAY_ON_JOINING_ALREADY_RECORDED };
    }
    if (isAdminRequestError(err) && err.status === 404) {
      return { ok: false, error: PAY_ON_JOINING_SWITCHED_OFF };
    }
    return { ok: false, error: describeAdminActionError(err) };
  }
}

/** PATCH /admin/pay-on-joining-hires/:id — edit it. */
export async function updatePayOnJoiningHireAction(
  id: string,
  input: PayOnJoiningHireInput,
): Promise<PayOnJoiningHireOutcome> {
  if (!uuid.safeParse(id).success) {
    return { ok: false, error: "That hire id is not valid, so nothing was sent." };
  }
  const parsed = validate(input);
  if ("error" in parsed) return { ok: false, error: parsed.error };
  try {
    const res = await adminFetch(
      `/admin/pay-on-joining-hires/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: parsed,
        schema: writeResultSchema,
      },
    );
    return {
      ok: true,
      changed: res.changed,
      message: res.changed ? "Hire record saved." : "No change — the record already matched.",
    };
  } catch (err) {
    if (isAdminRequestError(err) && err.status === 404) {
      return { ok: false, error: PAY_ON_JOINING_SWITCHED_OFF };
    }
    return { ok: false, error: describeAdminActionError(err) };
  }
}
