"use server";

import { z } from "zod";
import { requireOwner, type OrgRole } from "../../../lib/auth/org-roles";
import { inviteOrgMember, removeOrgMember } from "../../../lib/org-members";

/**
 * Owner-only TEAM (user-management) Server Actions — org-RBAC scaffold.
 *
 * DEFENCE-IN-DEPTH: every action RE-ASSERTS {@link requireOwner} server-side, so a Recruiter who
 * forges a direct call gets a neutral 404 — the page gate is NOT the only check (the gate is the
 * decision, never the nav). The data source is a STUB (no org/member API yet), so these are
 * no-ops that return a neutral "not yet available". XB-A: the org is the SERVER-HELD session;
 * the client supplies only a (validated) email / opaque member id, never an org id.
 *
 * PII: the invited email is validated then handed to the (future) API; it is never logged or
 * persisted here, and never echoed back in a result message.
 */

const emailSchema = z.string().email().max(254);
const orgRoleSchema = z.enum(["owner", "recruiter"]);
const memberIdSchema = z.string().min(1).max(200);

export type TeamActionResult = { ok: boolean; message: string };

export async function inviteMemberAction(input: {
  email: string;
  orgRole: string;
}): Promise<TeamActionResult> {
  await requireOwner(); // server gate — a non-Owner gets a neutral 404 (no-oracle)
  const email = emailSchema.safeParse(input.email);
  const role = orgRoleSchema.safeParse(input.orgRole);
  if (!email.success || !role.success) {
    // Neutral validation message — never echoes the offending value (PII).
    return { ok: false, message: "Enter a valid email and choose a role." };
  }
  const res = await inviteOrgMember({ email: email.data, orgRole: role.data as OrgRole });
  return res.ok ? { ok: true, message: res.message } : { ok: false, message: res.error };
}

export async function removeMemberAction(input: { memberId: string }): Promise<TeamActionResult> {
  await requireOwner(); // server gate — a non-Owner gets a neutral 404 (no-oracle)
  const id = memberIdSchema.safeParse(input.memberId);
  if (!id.success) {
    return { ok: false, message: "Invalid member." };
  }
  const res = await removeOrgMember({ memberId: id.data });
  return res.ok ? { ok: true, message: res.message } : { ok: false, message: res.error };
}
