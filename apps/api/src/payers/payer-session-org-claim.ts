import type { PayerOrgsRepository } from "./payer-orgs.repository";
import type { PayerSessionOrgClaim } from "./payer-session.service";

/**
 * #2079 — resolve the `org_id`/`org_role` claim to bake into a payer JWT at a REFRESH (the
 * explicit `POST /payer/refresh` and `PayerAuthGuard`'s rolling `x-session-token`), from the
 * payer's CURRENT active membership in `payer_members`.
 *
 * FAIL-SAFE TO LEAST PRIVILEGE, not fail-closed: the claim is a display hint (the server-side
 * authority is `PayerOrgRoleGuard`'s per-request DB read), so a resolve error or a missing
 * membership yields `undefined` → the fresh token simply carries NO org claim, which every
 * reader treats as `recruiter`. Refusing the refresh over a hint would log the payer out for
 * nothing; granting a stale `owner` would be wrong — omitting is the only safe answer.
 */
export async function resolveSessionOrgClaim(
  orgs: Pick<PayerOrgsRepository, "resolveOrgForPayer">,
  payerId: string,
): Promise<PayerSessionOrgClaim | undefined> {
  try {
    const org = await orgs.resolveOrgForPayer(payerId);
    return org ? { orgId: org.orgId, orgRole: org.orgRole } : undefined;
  } catch {
    return undefined;
  }
}
