import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray } from "drizzle-orm";
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
   * {@link findLatestByWorker}'s row with ONLY the two columns the consent rule reads — `purposes`
   * and `revokedAt` — selected the same way (latest by `acceptedAt`). For a reader that must not pull
   * the row's other columns (`ip_hash`, `user_agent`): the free-chat probe (ADR-0051 §10 R36), which
   * hands it to `hasActiveConsent` through a `LatestConsentReader`.
   */
  async findLatestStateByWorker(
    workerId: string,
  ): Promise<Pick<WorkerConsent, "purposes" | "revokedAt"> | undefined> {
    const rows = await this.db
      .select({ purposes: workerConsents.purposes, revokedAt: workerConsents.revokedAt })
      .from(workerConsents)
      .where(eq(workerConsents.workerId, workerId))
      .orderBy(desc(workerConsents.acceptedAt))
      .limit(1);
    return rows[0];
  }

  /**
   * {@link findLatestStateByWorker} for many workers in ONE read (#2753 item 13): each worker's
   * LATEST row by `acceptedAt`, `purposes` and `revokedAt` only. A worker with no row is absent
   * from the map. For the model-training gate (`model-training-gate.ts`), which asks about a
   * whole batch of workers at once.
   */
  async findLatestStatesByWorkers(
    workerIds: readonly string[],
  ): Promise<Map<string, Pick<WorkerConsent, "purposes" | "revokedAt">>> {
    if (workerIds.length === 0) return new Map();
    const rows = await this.db
      .selectDistinctOn([workerConsents.workerId], {
        workerId: workerConsents.workerId,
        purposes: workerConsents.purposes,
        revokedAt: workerConsents.revokedAt,
      })
      .from(workerConsents)
      .where(inArray(workerConsents.workerId, [...workerIds]))
      .orderBy(workerConsents.workerId, desc(workerConsents.acceptedAt));
    return new Map(
      rows.map((r) => [r.workerId, { purposes: r.purposes, revokedAt: r.revokedAt }]),
    );
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
      .set({ revokedAt: new Date() })
      .where(and(eq(workerConsents.id, latest.id)));
  }
}
