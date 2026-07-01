"use server";

import { z } from "zod";
import { requireOwner } from "../../../lib/auth/org-roles";
import { requirePayer } from "../../../lib/auth";
import { inviteOrgMember, removeOrgMember, acceptOrgInvite } from "../../../lib/org-members";

/**
 * TEAM (user-management) Server Actions (ADR-0027 / B5.5), wired to the LIVE org API.
 *
 * DEFENCE-IN-DEPTH: the write actions RE-ASSERT {@link requireOwner} server-side, so a Recruiter
 * who forges a direct call gets a neutral 404 — the page gate is NOT the only check. XB-A: the org
 * is the SERVER-HELD session; the client supplies only a (validated) email / opaque member id /
 * invite token, never an org id. The invited email is validated then handed to the API; it is
 * never logged, persisted, or echoed back in a result message (PII). The accept action is a MEMBER
 * action (any logged-in payer joining the org they were invited to), so it gates on
 * {@link requirePayer}, not owner.
 */

const emailSchema = z.string().email().max(254);
const memberIdSchema = z.string().min(1).max(200);
const tokenSchema = z.string().min(16).max(200);

export type TeamActionResult = { ok: boolean; message: string };

export async function inviteMemberAction(input: { email: string }): Promise<TeamActionResult> {
  await requireOwner(); // server gate — a non-Owner gets a neutral 404 (no-oracle)
  const email = emailSchema.safeParse(input.email);
  if (!email.success) {
    // Neutral validation message — never echoes the offending value (PII).
    return { ok: false, message: "Enter a valid email address." };
  }
  const res = await inviteOrgMember({ email: email.data });
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

export async function acceptInviteAction(input: { token: string }): Promise<TeamActionResult> {
  await requirePayer(); // must be a logged-in payer; the API binds the invite to their identity
  const token = tokenSchema.safeParse(input.token);
  if (!token.success) {
    return { ok: false, message: "That invite link is invalid or has expired." };
  }
  const res = await acceptOrgInvite({ token: token.data });
  return res.ok ? { ok: true, message: res.message } : { ok: false, message: res.error };
}
