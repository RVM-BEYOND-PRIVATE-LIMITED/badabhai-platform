"use server";

import { z } from "zod";
import { emailSchema } from "@badabhai/validators";
import { adminFetch } from "../../../lib/admin-http";
import { describeAdminActionError } from "../../../lib/describe-admin-error";
import { ADMIN_ROLES, ROLE_LABELS, type AdminRole } from "../../../lib/auth/capabilities";
import { shortId } from "../../../lib/format";
import type { AdminActionOutcome } from "../../../lib/admin-action-result";

/**
 * Admin-user lifecycle actions (`manage_admins`, super_admin only server-side —
 * `AdminActionsController`'s admin routes). All four mirror the L1 self-guards
 * `AdminActionsService` enforces (never demote/suspend/MFA-reset yourself, never the last
 * active super_admin): the UI hides those controls on the caller's own row (`is_self`)
 * BEFORE a request ever fires, and `describeAdminActionError` surfaces the server's own
 * rejection text verbatim on the rare race where one is still hit.
 */

const resultSchema = z.object({ target_id: z.string(), changed: z.boolean() });
const roleEnum = z.enum(ADMIN_ROLES);

const inviteInputSchema = z.object({ email: emailSchema, role: roleEnum });
const inviteResultSchema = z.object({ admin_id: z.string() });

export async function inviteAdminAction(input: {
  email: string;
  role: AdminRole;
}): Promise<AdminActionOutcome> {
  const parsed = inviteInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Enter a valid work email and choose a role." };

  try {
    const res = await adminFetch("/admin/admins", {
      method: "POST",
      body: { email: parsed.data.email, role: parsed.data.role },
      schema: inviteResultSchema,
    });
    return {
      ok: true,
      changed: true,
      message: `Invited ${shortId(res.admin_id)} as ${ROLE_LABELS[parsed.data.role]}.`,
    };
  } catch (err) {
    return { ok: false, error: describeAdminActionError(err) };
  }
}

export async function changeAdminRoleAction(
  targetAdminId: string,
  role: AdminRole,
): Promise<AdminActionOutcome> {
  const parsedRole = roleEnum.safeParse(role);
  if (!parsedRole.success) return { ok: false, error: "Choose a role." };

  try {
    const res = await adminFetch(`/admin/admins/${encodeURIComponent(targetAdminId)}/role`, {
      method: "PATCH",
      body: { role: parsedRole.data },
      schema: resultSchema,
    });
    return {
      ok: true,
      changed: res.changed,
      message: res.changed
        ? `Role changed to ${ROLE_LABELS[parsedRole.data]}.`
        : "Already that role — no change.",
    };
  } catch (err) {
    return { ok: false, error: describeAdminActionError(err) };
  }
}

export async function resetAdminMfaAction(targetAdminId: string): Promise<AdminActionOutcome> {
  try {
    const res = await adminFetch(`/admin/admins/${encodeURIComponent(targetAdminId)}/mfa/reset`, {
      method: "POST",
      schema: resultSchema,
    });
    return {
      ok: true,
      changed: res.changed,
      message: res.changed
        ? "Second factor reset. They will enrol a new one at their next sign-in."
        : "No second factor was enrolled — nothing to reset.",
    };
  } catch (err) {
    return { ok: false, error: describeAdminActionError(err) };
  }
}

export async function suspendAdminAction(targetAdminId: string): Promise<AdminActionOutcome> {
  try {
    const res = await adminFetch(`/admin/admins/${encodeURIComponent(targetAdminId)}/suspend`, {
      method: "POST",
      schema: resultSchema,
    });
    return {
      ok: true,
      changed: res.changed,
      message: res.changed ? "Admin suspended." : "Already suspended — no change.",
    };
  } catch (err) {
    return { ok: false, error: describeAdminActionError(err) };
  }
}
