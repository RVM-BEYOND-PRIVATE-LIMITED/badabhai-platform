import type { UnlockStatus } from "@badabhai/db";
import type { UnlockProjection } from "./unlocks.repository";

/**
 * #2033 — what a PAYER may see of their own unlocks (GET /payer/unlocks).
 *
 * The payer contract (payer-web `unlockProjectionWireSchema`) defines exactly four states. The
 * stored lifecycle has two more that are INTERNAL: `requested` (an attempt, never a grant) and
 * `denied` (the audit row of a fail-closed gate — listing it would tell the payer a deny
 * happened, the oracle the neutral body exists to close, ADR-0010 §D4). Those rows never leave
 * the API on the payer route. The ops route (`GET /unlocks`, InternalServiceGuard) is unchanged.
 */
export const PAYER_UNLOCK_STATUSES = ["granted", "revealed", "expired", "revoked"] as const;
export type PayerUnlockStatus = (typeof PAYER_UNLOCK_STATUSES)[number];

/**
 * The STORED statuses a payer row may come from. `revoked` is in the payer contract but no
 * writer stores it today; it is listed in {@link PAYER_UNLOCK_STATUSES} so the contract stays
 * whole, and is absent here because `UnlockStatus` has no such value.
 */
export const PAYER_VISIBLE_STORED_STATUSES = [
  "granted",
  "revealed",
  "expired",
] as const satisfies readonly UnlockStatus[];

type PayerVisibleStoredStatus = (typeof PAYER_VISIBLE_STORED_STATUSES)[number];

/** The payer-route projection: the ops projection with the status narrowed to the contract. */
export interface PayerUnlockProjection extends Omit<UnlockProjection, "status"> {
  status: PayerUnlockStatus;
}

const isPayerVisible = (status: UnlockStatus): status is PayerVisibleStoredStatus =>
  (PAYER_VISIBLE_STORED_STATUSES as readonly UnlockStatus[]).includes(status);

/**
 * The status a payer sees. Nothing writes `expired` to the row when the 14-day window lapses,
 * so a live status (`granted` / `revealed`) whose `expires_at` is at or before `now` reads
 * `expired` — the same boundary the grant path uses (a grant is live only while
 * `expires_at > now`). Returns null for a status the payer may not see (fail closed: an
 * unknown or internal status is dropped, never passed through).
 */
export function payerUnlockStatus(
  status: UnlockStatus,
  expiresAt: Date | null,
  now: Date,
): PayerUnlockStatus | null {
  if (!isPayerVisible(status)) return null;
  if (status === "expired") return "expired";
  if (expiresAt !== null && expiresAt.getTime() <= now.getTime()) return "expired";
  return status;
}

/** Project stored rows onto the payer contract, dropping every row the payer may not see. */
export function toPayerUnlocks(
  rows: readonly UnlockProjection[],
  now: Date,
): PayerUnlockProjection[] {
  const out: PayerUnlockProjection[] = [];
  for (const row of rows) {
    const status = payerUnlockStatus(row.status, row.expires_at, now);
    if (status !== null) out.push({ ...row, status });
  }
  return out;
}
