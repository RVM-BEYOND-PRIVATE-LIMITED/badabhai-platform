import { Inject, Injectable } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import { type Database, workerOccupations } from "@badabhai/db";

import { DATABASE } from "../database/database.module";

/**
 * READS AND WRITES `worker_occupation` (migration 0114) — the secondary-occupations page.
 *
 * ═══ THE SAME SEAM THE LANGUAGES / QUALIFICATIONS REPOSITORIES DRAW ═══
 *
 * Repeatable, worker-owned, ordered rows under a uniqueness constraint on `(worker_id,
 * sort_order)` — the shape that forces delete-then-insert inside ONE transaction rather than an
 * upsert, because re-submitting a list with a row removed collides on every position after it.
 *
 * Rows are closed `role_*` ids and an integer position: no free text, no name, no phone. Nothing
 * here crosses the AI boundary.
 */
@Injectable()
export class WorkerOccupationsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * REPLACE this worker's secondary-occupation rows, in ONE transaction.
   *
   * THE SUBMITTED ORDER IS THE DISPLAY ORDER, never sorted by id — re-deriving would reshuffle
   * rows between reads and make the stored list disagree with what the worker chose.
   *
   * Returns the count the event needs and whether anything was replaced — facts only the
   * transaction can know.
   */
  async replaceForWorker(
    workerId: string,
    roleIds: readonly string[],
  ): Promise<{ occupationsWritten: number; replacedExisting: boolean }> {
    return this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: workerOccupations.id })
        .from(workerOccupations)
        .where(eq(workerOccupations.workerId, workerId));
      const replacedExisting = existing.length > 0;

      await tx.delete(workerOccupations).where(eq(workerOccupations.workerId, workerId));
      if (roleIds.length > 0) {
        await tx.insert(workerOccupations).values(
          roleIds.map((roleId, index) => ({
            workerId,
            roleId,
            sortOrder: index,
          })),
        );
      }

      return { occupationsWritten: roleIds.length, replacedExisting };
    });
  }

  /**
   * APPEND secondary occupations captured by the CHAT (Layer A elicitation, qp_universal@4), and
   * only when the worker has no `worker_occupation` rows at all.
   *
   * The same guard and the same reasoning as `WorkerQualificationsRepository.appendTrainingIfEmpty`:
   * the occupations page owns the ordered list once it has written; the chat contributes only when
   * the worker has no page answer. Returns the number of rows written (0 when skipped).
   */
  async appendIfEmpty(workerId: string, roleIds: readonly string[]): Promise<number> {
    if (roleIds.length === 0) return 0;
    return this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: workerOccupations.id })
        .from(workerOccupations)
        .where(eq(workerOccupations.workerId, workerId))
        .limit(1);
      if (existing.length > 0) return 0;
      await tx.insert(workerOccupations).values(
        roleIds.map((roleId, index) => ({
          workerId,
          roleId,
          sortOrder: index,
        })),
      );
      return roleIds.length;
    });
  }

  /** One worker's secondary-occupation role ids, in the worker's own order. */
  async loadForWorker(workerId: string): Promise<string[]> {
    const rows = await this.db
      .select({ roleId: workerOccupations.roleId })
      .from(workerOccupations)
      .where(eq(workerOccupations.workerId, workerId))
      .orderBy(asc(workerOccupations.sortOrder));
    return rows.map((row) => row.roleId);
  }
}
