import "server-only";
import { z } from "zod";
import { payerFetch } from "./payer-http";
import { PayerConflictError } from "./payer-errors";
import { orgRoleWireSchema } from "./contracts";
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

const orgMemberStatusSchema = z.enum(["invited", "active", "removed"]);

/** The API's masked member view (ids + role + status + MASKED email — no raw PII). */
const orgMemberWireSchema = z.object({
  member_id: z.string(),
  org_role: orgRoleWireSchema,
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
 * The server's neutral 409 for an accept that would break a membership invariant (ADR-0053
 * §3.5 / #2154: already in a team, anchors a team, or a vertical-role mismatch).
 *
 * MATCHED ON THE MESSAGE, not on a reason code, because the API deliberately sends none: the
 * whole point of the refusal is that the caller cannot tell WHICH invariant failed.
 *
 * A DISTINCTIVE PHRASE rather than the whole sentence, normalised to letters and digits: the
 * server today says "This invite can't be accepted with this account", and neither the
 * contraction, an apostrophe nor a trailing full stop may silently drop this branch. No other
 * refusal on this route says "accepted with this account" — the already-used 409 and the
 * wrong-account 403 read nothing like it. A miss degrades to the generic neutral line, which is
 * still safe copy: this can read as less specific, never as misleading.
 */
const INVITE_NOT_ACCEPTABLE_SERVER_MARKER = "accepted with this account";

/** What the worker-facing copy says instead. Names no invariant and no organisation (#2193). */
export const INVITE_NOT_ACCEPTABLE_COPY =
  "You cannot join this team with this account. You may already be part of another team, or " +
  "you own a team. Ask the person who invited you to use a different email.";

const normalise = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

function isInviteNotAcceptable(error: unknown): boolean {
  if (!(error instanceof PayerConflictError)) return false;
  if (error.detail === null) return false;
  return normalise(error.detail).includes(INVITE_NOT_ACCEPTABLE_SERVER_MARKER);
}

/**
 * Accept a teammate invite with the single-use token from the accept link. The accepting
 * identity is the session payer (the token never carries who accepts); a bad/expired/mismatched
 * token is reported NEUTRALLY. On success the caller becomes an active member of the inviting org.
 *
 * #2193 — ONE refusal is now told apart: the 409 the server raises when the ACCOUNT, not the
 * link, is the problem. "That invite link is invalid or has expired" sent such a payer to the
 * inviter for a fresh link, which would fail identically forever. Every other failure — the
 * 404 invalid/expired token, the 403 wrong account, the already-used 409, a transport error —
 * keeps the existing neutral line, so nothing else about this surface changes.
 *
 * Neither branch reveals which invariant failed or names an organisation (ADR-0053 §3.5).
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
  } catch (err) {
    if (isInviteNotAcceptable(err)) {
      return { ok: false, error: INVITE_NOT_ACCEPTABLE_COPY };
    }
    return { ok: false, error: "That invite link is invalid or has expired." };
  }
}
