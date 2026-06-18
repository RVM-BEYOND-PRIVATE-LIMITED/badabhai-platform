import { ForbiddenException } from "@nestjs/common";

/**
 * Tenant-isolation chokepoint (ADR-0019 Decision C) — the single place that decides
 * "may THIS payer touch THIS row?". Every payer-facing data access MUST pass the
 * authenticated payer's id through one of these helpers so a payer can only ever
 * reach their own rows (payer↔payer isolation). This is the **app-layer** control
 * that ships first + is horizontal-authz tested; **DB-enforced RLS is the open-GA
 * launch gate** (Q5 / ADR-0004) — defense in depth, not a replacement.
 *
 * No-oracle: a cross-tenant access is a flat 403 regardless of whether the row
 * exists-but-belongs-to-another payer or the ids merely differ — an attacker learns
 * nothing about other tenants' data from the response (mirrors the disclosure spine's
 * neutral-response rule).
 */

/** Throw 403 unless `rowPayerId` is exactly the authenticated payer's id. */
export function assertPayerOwns(authPayerId: string, rowPayerId: string): void {
  if (!authPayerId || authPayerId !== rowPayerId) {
    throw new ForbiddenException("Resource does not belong to the authenticated payer");
  }
}

/** Assert EVERY row in a list belongs to the payer (defense-in-depth for list reads). */
export function assertOwnedRows<T extends { payerId: string }>(
  authPayerId: string,
  rows: readonly T[],
): readonly T[] {
  for (const row of rows) assertPayerOwns(authPayerId, row.payerId);
  return rows;
}

/**
 * The single-resource read chokepoint: fetch a payer-owned row, then enforce
 * ownership before returning it. A not-found row returns `undefined` (the caller
 * surfaces a neutral 404); a found-but-other-tenant row throws 403 — so neither a
 * direct fetch nor an IDOR can leak another payer's data.
 */
export async function readOwnedById<T extends { payerId: string }>(
  authPayerId: string,
  fetch: () => Promise<T | undefined>,
): Promise<T | undefined> {
  const row = await fetch();
  if (row === undefined) return undefined;
  assertPayerOwns(authPayerId, row.payerId);
  return row;
}
