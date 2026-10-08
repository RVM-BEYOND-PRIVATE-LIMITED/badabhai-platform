import { ForbiddenException } from "@nestjs/common";
import type { TenantKey } from "./payer-tenant-scope";

/**
 * Tenant-isolation chokepoint (ADR-0019 Decision C) — the single place that decides
 * "may THIS tenant touch THIS row?". Every payer-facing data access MUST pass the
 * resolved tenant key through one of these helpers so a payer can only ever reach
 * their tenant's rows (tenant↔tenant isolation). This is the **app-layer** control
 * that ships first + is horizontal-authz tested; **DB-enforced RLS is the open-GA
 * launch gate** (Q5 / ADR-0004) — defense in depth, not a replacement.
 *
 * ADR-0053 §5.2 rule 6: the comparison is the row's tenant-key column against
 * `scope.tenantKey` — the branded {@link TenantKey} only the resolver
 * (`PayerTenantScopeService.resolve`) can produce, never a raw id from a body, path
 * or JWT. With `PAYER_ORG_TENANCY_MODE` off the key IS the session payer, so these
 * helpers behave exactly as before; on, it is the acting org's anchor.
 *
 * No-oracle: a cross-tenant access is a flat 403 regardless of whether the row
 * exists-but-belongs-to-another tenant or the ids merely differ — an attacker learns
 * nothing about other tenants' data from the response (mirrors the disclosure spine's
 * neutral-response rule).
 */

/** Throw 403 unless `rowTenantKey` is exactly the resolved tenant key. */
export function assertPayerOwns(tenant: TenantKey, rowTenantKey: string): void {
  if (!tenant || tenant !== rowTenantKey) {
    throw new ForbiddenException("Resource does not belong to the authenticated payer");
  }
}

/** Assert EVERY row in a list belongs to the tenant (defense-in-depth for list reads). */
export function assertOwnedRows<T extends { payerId: string }>(
  tenant: TenantKey,
  rows: readonly T[],
): readonly T[] {
  for (const row of rows) assertPayerOwns(tenant, row.payerId);
  return rows;
}

/**
 * The single-resource read chokepoint: fetch a tenant-owned row, then enforce
 * ownership before returning it. A not-found row returns `undefined` (the caller
 * surfaces a neutral 404); a found-but-other-tenant row throws 403 — so neither a
 * direct fetch nor an IDOR can leak another tenant's data.
 */
export async function readOwnedById<T extends { payerId: string }>(
  tenant: TenantKey,
  fetch: () => Promise<T | undefined>,
): Promise<T | undefined> {
  const row = await fetch();
  if (row === undefined) return undefined;
  assertPayerOwns(tenant, row.payerId);
  return row;
}
