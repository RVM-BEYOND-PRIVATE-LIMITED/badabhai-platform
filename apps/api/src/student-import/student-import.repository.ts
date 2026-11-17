import { and, eq, exists, notExists, sql } from "drizzle-orm";
import {
  studentImportRows,
  workerConsents,
  workerCredentials,
  workerDevices,
  workerOrigins,
  workers,
  type Database,
} from "@badabhai/db";
import { eraseLoginKeyedRows } from "../common/login-keyed-rows";

/**
 * #2887 — the import rollback's ONE way to remove a worker row (a listed exit path,
 * `workers/worker-exit-paths.static.test.ts`). The caller writes `worker.account_deleted` on the
 * same transaction.
 */
export class StudentImportRepository {
  /**
   * Deletes the worker ONLY when the import run `batchId` created him and he is still a row he
   * never used: still `pending` (never signed in), origin institute/rvm, created by that run (its
   * ledger row says so), with no PIN, no trusted device, and no consent row other than the
   * import's own (`campus_import:` version). Anything else is a person using BadaBhai, and stays.
   * His profile, skills, consent, markers, subject and visibility go with the row (cascades), and
   * his login-keyed rows are erased with it (#2837). Returns false when nothing was deleted.
   */
  async deleteImportCreatedPendingWorker(
    tx: Database,
    workerId: string,
    batchId: string,
  ): Promise<boolean> {
    const rows = await tx
      .delete(workers)
      .where(
        and(
          eq(workers.id, workerId),
          eq(workers.status, "pending"),
          exists(
            tx
              .select({ one: sql`1` })
              .from(workerOrigins)
              .where(
                and(
                  eq(workerOrigins.workerId, workerId),
                  eq(workerOrigins.kind, "institute"),
                  eq(workerOrigins.ref, "rvm"),
                ),
              ),
          ),
          exists(
            tx
              .select({ one: sql`1` })
              .from(studentImportRows)
              .where(
                and(
                  eq(studentImportRows.batchId, batchId),
                  eq(studentImportRows.workerId, workerId),
                  eq(studentImportRows.workerCreated, true),
                ),
              ),
          ),
          notExists(
            tx
              .select({ one: sql`1` })
              .from(workerConsents)
              .where(
                and(
                  eq(workerConsents.workerId, workerId),
                  sql`${workerConsents.consentVersion} NOT LIKE 'campus\\_import:%'`,
                ),
              ),
          ),
          notExists(
            tx
              .select({ one: sql`1` })
              .from(workerCredentials)
              .where(eq(workerCredentials.workerId, workerId)),
          ),
          notExists(
            tx
              .select({ one: sql`1` })
              .from(workerDevices)
              .where(eq(workerDevices.workerId, workerId)),
          ),
        ),
      )
      .returning({ id: workers.id });
    if (rows.length === 0) return false;
    await eraseLoginKeyedRows(tx, { kind: "worker", id: workerId });
    return true;
  }
}
