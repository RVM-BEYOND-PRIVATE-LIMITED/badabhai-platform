import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { type Database, workerConsents, type WorkerConsent, type NewWorkerConsent } from "@badabhai/db";
import { DATABASE } from "../database/database.module";

@Injectable()
export class ConsentRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async create(input: NewWorkerConsent): Promise<WorkerConsent> {
    const inserted = await this.db.insert(workerConsents).values(input).returning();
    const row = inserted[0];
    if (!row) throw new Error("Failed to create consent record");
    return row;
  }

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
   * Stamp `revokedAt` on the worker's latest consent row (append-only — the row
   * is never deleted). A re-consent inserts a fresh row, so this is a single-
   * touch invalidation of the CURRENT latest row only.
   */
  async withdraw(workerId: string): Promise<void> {
    const latest = await this.findLatestByWorker(workerId);
    if (!latest || latest.revokedAt !== null) return;
    await this.db
      .update(workerConsents)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(workerConsents.id, latest.id)));
  }
}
