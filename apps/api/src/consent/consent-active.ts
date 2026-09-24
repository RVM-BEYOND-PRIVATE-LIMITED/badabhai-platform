import type { ConsentPurpose } from "@badabhai/types";

import type { ConsentRepository } from "./consent.repository";

/**
 * Does this worker hold an ACTIVE consent right now — optionally one that names `purpose`?
 *
 * THE OFF-REQUEST TWIN OF `ConsentGuard` (ADR-0043). The guard stands in front of every worker
 * route; nothing stands in front of a queue job. The résumé-history chain — an accepted chat
 * update is extracted, confirmed and regenerated minutes after the worker's "Haan" — runs entirely
 * off the request path, so each AI step on it asks this first. The rule is the guard's own: the
 * worker's LATEST `worker_consents` row exists and is not revoked, and, when a purpose is named,
 * carries it.
 *
 * FAILS CLOSED. No repository (a caller built without one), no row, a revoked row, a missing
 * purpose, or a read that throws — every one of them is "no".
 */
export async function hasActiveConsent(
  consents: Pick<ConsentRepository, "findLatestByWorker"> | undefined,
  workerId: string,
  purpose?: ConsentPurpose,
): Promise<boolean> {
  if (!consents) return false;
  try {
    const latest = await consents.findLatestByWorker(workerId);
    if (!latest || latest.revokedAt !== null) return false;
    if (purpose === undefined) return true;
    return Array.isArray(latest.purposes) && latest.purposes.includes(purpose);
  } catch {
    return false;
  }
}
