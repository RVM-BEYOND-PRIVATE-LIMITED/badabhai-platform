import type { PayerSessionOrgClaim } from "./payer-session.service";
import type { PayerTenantScopeService } from "./payer-tenant-scope.service";

/**
 * #2079 — resolve the `org_id`/`org_role` claim to bake into a payer JWT at a REFRESH (the
 * explicit `POST /payer/refresh` and `PayerAuthGuard`'s rolling `x-session-token`), from the
 * payer's CURRENT acting org — {@link PayerTenantScopeService.resolveActingOrg}, the same
 * choice `PayerOrgRoleGuard` and the tenant scope make (ADR-0053 §3.2).
 *
 * FAIL-SAFE TO LEAST PRIVILEGE, not fail-closed: the claim is a display hint (the server-side
 * authority is `PayerOrgRoleGuard`'s per-request DB read), so a resolve error or a missing
 * membership yields `undefined` → the fresh token simply carries NO org claim, which every
 * reader treats as `recruiter`. Refusing the refresh over a hint would log the payer out for
 * nothing; granting a stale `owner` would be wrong — omitting is the only safe answer.
 */
export async function resolveSessionOrgClaim(
  tenancy: Pick<PayerTenantScopeService, "resolveActingOrg">,
  payerId: string,
): Promise<PayerSessionOrgClaim | undefined> {
  try {
    const org = await tenancy.resolveActingOrg(payerId);
    return org ? { orgId: org.orgId, orgRole: org.orgRole } : undefined;
  } catch {
    return undefined;
  }
}
