"use server";

import { z } from "zod";
import { e164PhoneSchema } from "@badabhai/validators";
import { adminFetch } from "../../../lib/admin-http";
import { describeAdminActionError } from "../../../lib/describe-admin-error";
import type {
  AdminActionFailure,
  AdminActionSuccess,
} from "../../../lib/admin-action-result";
import {
  COMPANY_AGENCY_TYPES,
  COMPANY_KINDS,
  COMPANY_REASON_CODES,
  COMPANY_SIZE_BANDS,
  COMPANY_VERIFICATION_STATUSES,
  type CompanyChangesPayload,
  type CompanyKind,
  type CompanyReasonCode,
} from "../../../lib/company-vocabulary";

/**
 * Company record writes (A9, #2579; API #2564).
 *
 * Every write is a governed action: a closed `reason_code`, a written `reason_text` of 15–500
 * characters, the SESSION admin as actor (never a body id), and one `admin.action_performed`
 * event from the API. The Server Action repeats the shape floor so a malformed form gets plain
 * English; the API remains the authority.
 */

const REASON_MIN = 15;
const REASON_MAX = 500;

const reasonText = z.string().trim().min(REASON_MIN).max(REASON_MAX);
const reasonShape = {
  reason_code: z.enum(COMPANY_REASON_CODES),
  reason_text: reasonText,
} as const;

const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const gstin = z
  .string()
  .trim()
  .toUpperCase()
  .regex(GSTIN_PATTERN, "Enter a valid GSTIN");

const cityList = z.array(z.string().trim().min(1).max(80)).max(50);

const profileShape = {
  gst_number: gstin.nullable(),
  address: z.string().trim().min(1).max(500).nullable(),
  website: z.string().trim().url().max(200).regex(/^https?:\/\//, "Website must be http(s)").nullable(),
  phone: e164PhoneSchema.nullable(),
  email: z.string().trim().toLowerCase().email().max(254).nullable(),
  contact_person: z.string().trim().min(1).max(120).nullable(),
  verification_status: z.enum(COMPANY_VERIFICATION_STATUSES),
  industry: z.string().trim().min(1).max(80).nullable(),
  company_size: z.enum(COMPANY_SIZE_BANDS).nullable(),
  hiring_locations: cityList,
  agency_type: z.enum(COMPANY_AGENCY_TYPES).nullable(),
  operating_cities: cityList,
  recruiter_count: z.number().int().min(0).max(100_000).nullable(),
} as const;

const changesObject = z
  .object({
    org_name: z.string().trim().min(1).max(200).optional(),
    ...profileShape,
  })
  .partial()
  .strict();

const changesSchema = changesObject.refine((value) => Object.keys(value).length > 0, {
  message: "No fields to change",
});

export type CompanyChangesInput = z.input<typeof changesSchema>;

const createSchema = z
  .object({
    kind: z.enum(COMPANY_KINDS),
    org_name: z.string().trim().min(1).max(200),
    email: z.string().trim().toLowerCase().email().max(254).optional(),
    phone: e164PhoneSchema.optional(),
    reason_code: z.enum(COMPANY_REASON_CODES),
    reason_text: reasonText,
    profile: changesObject.omit({ org_name: true }).optional(),
  })
  .strict()
  .refine((value) => value.email !== undefined || value.phone !== undefined, {
    message: "Enter an email or an E.164 phone number for the company's first login.",
  });

export interface CreateCompanyInput {
  kind: CompanyKind;
  orgName: string;
  email?: string;
  phone?: string;
  reasonCode: CompanyReasonCode;
  reasonText: string;
  profile?: Omit<CompanyChangesPayload, "org_name">;
}

export interface CompanyWriteSuccess extends AdminActionSuccess {
  companyId: string;
}

export interface CreateCompanySuccess extends CompanyWriteSuccess {
  loginId: string;
}

export type CompanyWriteOutcome = CompanyWriteSuccess | AdminActionFailure;
export type CreateCompanyOutcome = CreateCompanySuccess | AdminActionFailure;

const writeResultSchema = z.object({ company_id: z.string(), changed: z.boolean() });

const createResultSchema = z.object({
  company_id: z.string(),
  login: z.object({
    payer_id: z.string(),
    login_id: z.string(),
    temporary_password: z.string(),
    must_change_password: z.literal(true),
  }),
});

/** POST /admin/companies — the company record and its first login, in one transaction. */
export async function createCompanyAction(input: CreateCompanyInput): Promise<CreateCompanyOutcome> {
  const parsed = createSchema.safeParse({
    kind: input.kind,
    org_name: input.orgName,
    email: input.email || undefined,
    phone: input.phone || undefined,
    reason_code: input.reasonCode,
    reason_text: input.reasonText,
    ...(input.profile && Object.keys(input.profile).length > 0 ? { profile: input.profile } : {}),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the company details." };
  }
  try {
    const res = await adminFetch("/admin/companies", {
      method: "POST",
      body: parsed.data,
      schema: createResultSchema,
    });
    return {
      ok: true,
      changed: true,
      companyId: res.company_id,
      loginId: res.login.login_id,
      temporaryPassword: res.login.temporary_password,
      message: `Created ${parsed.data.org_name} and its first login (${res.login.login_id}).`,
    };
  } catch (err) {
    return { ok: false, error: describeAdminActionError(err) };
  }
}

/** PATCH /admin/companies/:id — send only the fields the operator changed. */
export async function updateCompanyAction(
  companyId: string,
  changes: CompanyChangesInput,
  reason: { reasonCode: CompanyReasonCode; reasonText: string },
): Promise<CompanyWriteOutcome> {
  const parsedChanges = changesSchema.safeParse(changes);
  if (!parsedChanges.success) {
    return { ok: false, error: parsedChanges.error.issues[0]?.message ?? "Check the company details." };
  }
  const parsedReason = z.object(reasonShape).safeParse({
    reason_code: reason.reasonCode,
    reason_text: reason.reasonText,
  });
  if (!parsedReason.success) {
    return {
      ok: false,
      error: `Explain the reason in at least ${REASON_MIN} characters.`,
    };
  }
  try {
    const res = await adminFetch(`/admin/companies/${encodeURIComponent(companyId)}`, {
      method: "PATCH",
      body: { ...parsedReason.data, changes: parsedChanges.data },
      schema: writeResultSchema,
    });
    return {
      ok: true,
      changed: res.changed,
      companyId: res.company_id,
      message: res.changed ? "Company record saved." : "No change — the record already matched.",
    };
  } catch (err) {
    return { ok: false, error: describeAdminActionError(err) };
  }
}

/** POST /admin/companies/:id/archive — the T3 write; every login is archived with a reason. */
export async function archiveCompanyAction(
  companyId: string,
  reason: { reasonCode: CompanyReasonCode; reasonText: string },
): Promise<CompanyWriteOutcome> {
  return companyTransition(companyId, "archive", reason);
}

/** POST /admin/companies/:id/restore — returns every archived login to its previous status. */
export async function restoreCompanyAction(
  companyId: string,
  reason: { reasonCode: CompanyReasonCode; reasonText: string },
): Promise<CompanyWriteOutcome> {
  return companyTransition(companyId, "restore", reason);
}

async function companyTransition(
  companyId: string,
  action: "archive" | "restore",
  reason: { reasonCode: CompanyReasonCode; reasonText: string },
): Promise<CompanyWriteOutcome> {
  const parsedReason = z.object(reasonShape).safeParse({
    reason_code: reason.reasonCode,
    reason_text: reason.reasonText,
  });
  if (!parsedReason.success) {
    return {
      ok: false,
      error: `Explain the reason in at least ${REASON_MIN} characters.`,
    };
  }
  try {
    const res = await adminFetch(
      `/admin/companies/${encodeURIComponent(companyId)}/${action}`,
      { method: "POST", body: parsedReason.data, schema: writeResultSchema },
    );
    return {
      ok: true,
      changed: res.changed,
      companyId: res.company_id,
      message:
        action === "archive"
          ? res.changed
            ? "Company archived. Every login is off the platform and its sessions ended."
            : "Already archived — no change."
          : res.changed
            ? "Company restored. Every login returns to the status it held before the archive."
            : "Not archived — no change.",
    };
  } catch (err) {
    return { ok: false, error: describeAdminActionError(err) };
  }
}

