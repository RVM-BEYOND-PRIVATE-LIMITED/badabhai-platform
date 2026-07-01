import "server-only";
import { z } from "zod";
import { payerFetch } from "./payer-http";
import type { OrgRole } from "./auth/org-roles";

/**
 * LIVE payer org-member directory (ADR-0027 / B5.5) — wired to the self-serve org API
 * (B5.3/B5.4): `GET/POST /payer/org/members`, `DELETE /payer/org/members/:id`, and
 * `POST /payer/org/invites/accept`.
 *
 * TENANCY (XB-A): every call binds to the SERVER-HELD session (the payer JWT that
 * {@link payerFetch} attaches from the httpOnly cookie); the org is resolved server-side from
 * that identity. This module NEVER sends an org id or another member's payer id — only the
 * invitee email (invite), the opaque member id in the PATH (remove), or the invite token
 * (accept). PII: the API returns emails ALREADY MASKED (`h•••@domain`); the raw email is sent
 * only on invite and is never persisted/logged/echoed here.
 */

const orgRoleSchema = z.enum(["owner", "recruiter"]);
const orgMemberStatusSchema = z.enum(["invited", "active", "removed"]);

/** The API's masked member view (ids + role + status + MASKED email — no raw PII). */
const orgMemberWireSchema = z.object({
  member_id: z.string(),
  org_role: orgRoleSchema,
  status: orgMemberStatusSchema,
  email_masked: z.string(),
  invited_at: z.string(),
  is_self: z.boolean(),
});
const orgMemberListWireSchema = z.array(orgMemberWireSchema);
const removeResultWireSchema = z.object({
  member_id: z.string(),
  status: z.literal("removed"),
});

export type OrgMemberStatus = z.infer<typeof orgMemberStatusSchema>;

/** A member row as the Team UI renders it — faceless: masked email, no raw PII. */
export interface OrgMemberView {
  memberId: string;
  orgRole: OrgRole;
  status: OrgMemberStatus;
  /** Server-masked email label (e.g. `h•••@acme.example`) — never the raw address. */
  emailMasked: string;
  invitedAt: string;
  /** True for the caller's own row (the UI marks it and hides its Remove affordance). */
  isSelf: boolean;
}

/** The neutral result of a member mutation. A union so the action code stays exhaustive. */
export type OrgMemberMutationResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

function toView(w: z.infer<typeof orgMemberWireSchema>): OrgMemberView {
  return {
    memberId: w.member_id,
    orgRole: w.org_role,
    status: w.status,
    emailMasked: w.email_masked,
    invitedAt: w.invited_at,
    isSelf: w.is_self,
  };
}

/**
 * List the caller's OWN org members (masked). Bound to the server-held session's org — a client
 * never supplies an org id. Any member may read (the API allows it); the page-level
 * {@link import("./auth/org-roles").requireOwner} gate decides who reaches the management UI.
 */
export async function listOrgMembers(): Promise<OrgMemberView[]> {
  const rows = await payerFetch("/payer/org/members", { schema: orgMemberListWireSchema });
  return rows.map(toView);
}

/**
 * Invite a teammate as a RECRUITER (the only invitable role today — co-owner/transfer is a later
 * capability; the API rejects `owner`). Sends only the invitee email; the org + actor come from
 * the session. A failure is reported NEUTRALLY (no status code / body leaked — no-oracle, no PII).
 */
export async function inviteOrgMember(input: { email: string }): Promise<OrgMemberMutationResult> {
  try {
    await payerFetch("/payer/org/members", {
      method: "POST",
      body: { email: input.email, org_role: "recruiter" },
      schema: orgMemberWireSchema,
    });
    return { ok: true, message: "Invite sent." };
  } catch {
    return { ok: false, error: "Could not send that invite. Check the email and try again." };
  }
}

/**
 * Remove a teammate by opaque member id (owner-only, enforced server-side). The id rides the
 * PATH; no org id is sent. A no-oracle failure (unknown/owner/foreign member) is reported
 * neutrally.
 */
export async function removeOrgMember(input: {
  memberId: string;
}): Promise<OrgMemberMutationResult> {
  try {
    await payerFetch(`/payer/org/members/${encodeURIComponent(input.memberId)}`, {
      method: "DELETE",
      schema: removeResultWireSchema,
    });
    return { ok: true, message: "Member removed." };
  } catch {
    return { ok: false, error: "Could not remove that member." };
  }
}

/**
 * Accept a teammate invite with the single-use token from the accept link. The accepting
 * identity is the session payer (the token never carries who accepts); a bad/expired/mismatched
 * token is reported NEUTRALLY. On success the caller becomes an active member of the inviting org.
 */
export async function acceptOrgInvite(input: {
  token: string;
}): Promise<OrgMemberMutationResult> {
  try {
    await payerFetch("/payer/org/invites/accept", {
      method: "POST",
      body: { token: input.token },
      schema: orgMemberWireSchema,
    });
    return { ok: true, message: "You've joined the team." };
  } catch {
    return { ok: false, error: "That invite link is invalid or has expired." };
  }
}
