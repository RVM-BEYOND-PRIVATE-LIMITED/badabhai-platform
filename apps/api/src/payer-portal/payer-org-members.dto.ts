import { z } from "zod";

/**
 * Invite a teammate to the caller's org (ADR-0027 / B5.3). `email` is the invitee's login
 * email (encrypted at rest by the service — never logged/evented). `org_role` is restricted
 * to `recruiter` in B5.3: the founder is the sole `owner`, and inviting a co-owner /
 * transferring ownership is a separate, later capability (avoids the sole-owner-removes-self
 * class of edge cases). No `org_id`/`invited_by` in the body — both come from the verified
 * session + resolved org (XB-A).
 */
export const InviteMemberSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  org_role: z.enum(["recruiter"]).default("recruiter"),
});
export type InviteMemberDto = z.infer<typeof InviteMemberSchema>;

/**
 * Accept a teammate invite (ADR-0027 / B5.4). The body carries ONLY the single-use raw
 * `token` from the accept link — no org_id / member_id (both are resolved from the token,
 * server-side). The accepting principal is the authenticated payer (PayerAuthGuard); the
 * service additionally binds the accept to that payer's own verified email (defense-in-depth
 * on a leaked token). Bounded length so a garbage body is rejected before any DB hit.
 */
export const AcceptInviteSchema = z.object({
  token: z.string().trim().min(16).max(200),
});
export type AcceptInviteDto = z.infer<typeof AcceptInviteSchema>;
