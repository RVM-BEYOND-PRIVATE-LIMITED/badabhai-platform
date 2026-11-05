"use server";

import { z } from "zod";
import { e164PhoneSchema, emailSchema } from "@badabhai/validators";
import { adminFetch } from "../../../lib/admin-http";
import { describeAdminActionError } from "../../../lib/describe-admin-error";
import { shortId } from "../../../lib/format";
import type { AdminActionOutcome } from "../../../lib/admin-action-result";
import { ACCOUNT_TYPES } from "../../../lib/account-labels";

/**
 * Payer login management writes (#2578, built on #2563).
 *
 * Every write carries a closed `reason_code` and a written `reason_text` of 15–500 characters
 * (`AdminPayerLoginsController` / `admin-payer-logins.dto.ts`). The reason is committed with the
 * credential change and the value-free `admin.action_performed` event; the temporary password
 * itself is returned ONLY in the response that minted it.
 */

const REASON_MIN = 15;
const REASON_MAX = 500;

const reasonSchema = z.string().trim().min(REASON_MIN).max(REASON_MAX);

const loginIdSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .refine(
    (v) => emailSchema.safeParse(v).success || e164PhoneSchema.safeParse(v).success,
    "Enter a valid email or an E.164 phone number (for example +919876543210).",
  );

const createInputSchema = z
  .object({
    loginId: loginIdSchema,
    type: z.enum(ACCOUNT_TYPES),
    orgName: z.string().trim().min(1).max(200).optional(),
    orgId: z.string().uuid().optional(),
    reason: reasonSchema,
  })
  .refine(
    (v) => (v.type === "team_member" ? Boolean(v.orgId) : Boolean(v.orgName)),
    "Choose an organisation for this login.",
  );

export type CreateLoginInput = z.input<typeof createInputSchema>;

const createResultSchema = z.object({
  payer_id: z.string(),
  login_id: z.string(),
  temporary_password: z.string(),
  must_change_password: z.literal(true),
});

const issueResultSchema = z.object({
  payer_id: z.string(),
  temporary_password: z.string(),
  must_change_password: z.literal(true),
});

const revokeResultSchema = z.object({
  payer_id: z.string(),
  changed: z.boolean(),
});

function contactFor(loginId: string): { email: string } | { phone: string } {
  const email = emailSchema.safeParse(loginId);
  return email.success ? { email: email.data.toLowerCase() } : { phone: loginId };
}

/** Create an owner login (company/agency) or a team member under an existing org. */
export async function createPayerLoginAction(
  input: CreateLoginInput,
): Promise<AdminActionOutcome> {
  const parsed = createInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the login details." };
  }
  const dto = parsed.data;
  const contact = contactFor(dto.loginId);

  const body =
    dto.type === "team_member"
      ? {
          ...contact,
          member_of_org_id: dto.orgId,
          org_role: "recruiter" as const,
          reason_code: "login_created" as const,
          reason_text: dto.reason,
        }
      : {
          ...contact,
          role: dto.type === "agency_owner" ? ("agent" as const) : ("employer" as const),
          org_name: dto.orgName,
          reason_code: "login_created" as const,
          reason_text: dto.reason,
        };

  try {
    const res = await adminFetch("/admin/payers", {
      method: "POST",
      body,
      schema: createResultSchema,
    });
    return {
      ok: true,
      changed: true,
      message: `Created the login for ${res.login_id} (${shortId(res.payer_id)}).`,
      temporaryPassword: res.temporary_password,
    };
  } catch (err) {
    return { ok: false, error: describeAdminActionError(err) };
  }
}

/** Issue a fresh one-time password for an existing login. */
export async function issueTemporaryPasswordAction(
  payerId: string,
  reason: string,
): Promise<AdminActionOutcome> {
  const parsedId = z.string().uuid().safeParse(payerId);
  if (!parsedId.success) return { ok: false, error: "That account id is not valid." };
  const parsedReason = reasonSchema.safeParse(reason);
  if (!parsedReason.success) {
    return { ok: false, error: `Explain the reason in at least ${REASON_MIN} characters.` };
  }

  try {
    const res = await adminFetch(
      `/admin/payers/${encodeURIComponent(parsedId.data)}/password/temporary`,
      {
        method: "POST",
        body: {
          reason_code: "password_issued",
          reason_text: parsedReason.data,
        },
        schema: issueResultSchema,
      },
    );
    return {
      ok: true,
      changed: true,
      message: `Issued a new temporary password for ${shortId(res.payer_id)}.`,
      temporaryPassword: res.temporary_password,
    };
  } catch (err) {
    return { ok: false, error: describeAdminActionError(err) };
  }
}

/** Revoke password sign-in; the emailed-code door stays open. */
export async function revokePayerPasswordAction(
  payerId: string,
  reason: string,
): Promise<AdminActionOutcome> {
  const parsedId = z.string().uuid().safeParse(payerId);
  if (!parsedId.success) return { ok: false, error: "That account id is not valid." };
  const parsedReason = reasonSchema.safeParse(reason);
  if (!parsedReason.success) {
    return { ok: false, error: `Explain the reason in at least ${REASON_MIN} characters.` };
  }

  try {
    const res = await adminFetch(
      `/admin/payers/${encodeURIComponent(parsedId.data)}/password/revoke`,
      {
        method: "POST",
        body: {
          reason_code: "password_revoked",
          reason_text: parsedReason.data,
        },
        schema: revokeResultSchema,
      },
    );
    return {
      ok: true,
      changed: res.changed,
      message: res.changed
        ? "Password sign-in revoked; the emailed code still works."
        : "Already revoked — no change.",
    };
  } catch (err) {
    return { ok: false, error: describeAdminActionError(err) };
  }
}
