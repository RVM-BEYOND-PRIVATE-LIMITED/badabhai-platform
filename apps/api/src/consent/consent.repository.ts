import { Inject, Injectable } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import { type Database, workerConsents, type WorkerConsent, type NewWorkerConsent } from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/**
 * The SINGLE source of truth for "does this worker currently have ACCEPTED consent?".
 *
 * TRUE iff the worker's LATEST `worker_consents` row EXISTS and is NOT revoked
 * (`revokedAt === null`). This is EXACTLY the admit rule of `ConsentGuard` (a missing row OR a
 * revoked row ⇒ not accepted), factored into one pure predicate so the guard, the derived
 * PII-free `consent_accepted` flag on the auth responses, and every future caller cannot DRIFT
 * apart — the worker-app's returning-worker routing decision stays byte-for-byte identical to
 * the server-side gate. Keep this the ONLY definition of "consented".
 *
 * Note it is INTENTIONALLY stricter than `ConsentNotRevokedGuard` (the session-resume gate),
 * which ADMITS a never-consented worker; `consent_accepted` mirrors `ConsentGuard` (the
 * profiling gate), not the resume gate.
 */
export function isConsentAccepted(latest: WorkerConsent | undefined): boolean {
  return latest !== undefined && latest.revokedAt === null;
}

@Injectable()
export class ConsentRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async create(input: NewWorkerConsent): Promise<WorkerConsent> {
    const inserted = await this.db.insert(workerConsents).values(input).returning();
    const row = inserted[0];
    if (!row) throw new Error("Failed to create consent record");
    return row;
  }

  // ---------------------------------------------------------------------------
  // INVARIANT (finding #176 — WorkerAuthGuard slide is NOT consent-gated).
  //
  // ANY future writer that sets `worker_consents.revokedAt` (a DPDP consent-withdrawal
  // endpoint / `ConsentService.withdraw()`) MUST call `SessionService.revokeAll(workerId)` in
  // the SAME unit of work. Reason: the `WorkerAuthGuard` slide/re-mint extends a live session on
  // every [W] route WITHOUT reading consent (a per-request Postgres read on the hot path was
  // deliberately rejected — perf/deadlock). So a still-alive session belonging to a worker who
  // just withdrew consent would SELF-RENEW indefinitely — a launch-gate for the withdrawal
  // endpoint. Today the ONLY revoker is account-deletion, which already calls `revokeAll` FIRST
  // (see account-deletion.service.ts + its ordering regression test), so no revoked-but-alive
  // worker can exist yet. Do NOT add a revoke writer here without also wiring `revokeAll`.
  // ---------------------------------------------------------------------------

  /**
   * The worker's most recent consent record (by acceptedAt), or undefined if the
   * worker has never consented. `worker_consents` is append-only — a revoke sets
   * `revokedAt` on the row rather than deleting it — so the LATEST row is the
   * current consent state. Used by {@link ConsentGuard} to gate worker actions.
   */
  async findLatestByWorker(workerId: string): Promise<WorkerConsent | undefined> {
    const rows = await this.db
      .select()
      .from(workerConsents)
      .where(eq(workerConsents.workerId, workerId))
      .orderBy(desc(workerConsents.acceptedAt))
      .limit(1);
    return rows[0];
  }

  /**
   * Whether the worker currently has ACCEPTED (not-revoked) consent — the EXACT predicate
   * {@link ConsentGuard} admits on ({@link isConsentAccepted} over {@link findLatestByWorker}).
   * Used to derive the additive, PII-free `consent_accepted` flag on the auth responses so the
   * worker-app can gate a returning worker's routing (→ /consent) with the SAME rule the server
   * enforces. Returns ONLY the boolean — never consent text/version/timestamps (no PII).
   */
  async hasAcceptedConsent(workerId: string): Promise<boolean> {
    return isConsentAccepted(await this.findLatestByWorker(workerId));
  }
}
