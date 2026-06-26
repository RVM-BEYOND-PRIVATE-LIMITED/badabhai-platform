import "server-only";
import type { OrgRole } from "./auth/org-roles";

/**
 * STUB org-member directory for the Owner user-management scaffold (org-RBAC).
 *
 * // STUB / TODO: there is NO org/member API yet — do NOT treat {@link OrgMemberView} as the
 * // backend contract. Wire to Divyanshu's org API (list / invite / remove members) when it
 * // lands (XB-A: every call binds to the SERVER-HELD session's org; a client never supplies an
 * // org id or another member's id).
 *
 * Until then there is no directory to read, so {@link listOrgMembers} returns an EMPTY list and
 * the invite/remove operations are NO-OPS that report a neutral "not yet available". This keeps
 * the Owner UI fully scaffolded (form + list + per-row remove) with ZERO fabricated members.
 *
 * PII: members are referenced by an OPAQUE id + a coarse label + the org role only — never an
 * email/phone/name at rest here. The invite email is validated by the action then handed to the
 * (future) API; it is never persisted or logged on this surface.
 */

/** A scaffold member row. STUB shape — the backend DTO will REPLACE this when the org API lands. */
export interface OrgMemberView {
  /** Opaque member id (NOT the account payer_id). Supplied by the org API later. */
  memberId: string;
  /** Coarse, non-PII display label (e.g. a masked handle). Never a raw email/phone/name. */
  label: string;
  orgRole: OrgRole;
}

/** The neutral result of a (stubbed) member mutation. A union so the action code is final. */
export type OrgMemberMutationResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

const NOT_WIRED =
  "Member management isn't available yet — it activates when the org directory API lands.";

/**
 * STUB: list the caller's OWN org members. Returns `[]` (no directory yet). Bound to the
 * server-held session's org when the backend lands; never accepts a client org id.
 */
export async function listOrgMembers(): Promise<OrgMemberView[]> {
  // STUB: replace with `payerFetch("/payer/org/members", { schema })` when the org API lands.
  return [];
}

/**
 * STUB: invite a member by (already-validated) email + org role. No-op today — reports the
 * neutral not-wired result. The email is NOT persisted/logged here (PII); it is only forwarded.
 */
export async function inviteOrgMember(_input: {
  email: string;
  orgRole: OrgRole;
}): Promise<OrgMemberMutationResult> {
  // STUB: replace with `payerFetch("/payer/org/members", { method: "POST", body: { email, orgRole } })`.
  return { ok: false, error: NOT_WIRED };
}

/** STUB: remove a member by opaque id. No-op today — reports the neutral not-wired result. */
export async function removeOrgMember(_input: {
  memberId: string;
}): Promise<OrgMemberMutationResult> {
  // STUB: replace with `payerFetch("/payer/org/members/:id", { method: "DELETE" })`.
  return { ok: false, error: NOT_WIRED };
}
