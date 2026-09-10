import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import {
  type Database,
  workerResumeImports,
  type WorkerResumeImport,
  type NewWorkerResumeImport,
} from "@badabhai/db";
import { DATABASE } from "../../database/database.module";

/**
 * Reads and writes for `worker_resume_import` (ADR-0041, phase RI-1).
 *
 * EVERY READ IS WORKER-SCOPED, and there is no `findById` without one. That is not politeness
 * about layering — this row points at a document holding a worker's employers and past salaries,
 * so a repository method that could fetch one by id alone is a method a controller could reach
 * with an id from a request body. The type system is doing the ownership check here: you cannot
 * ask this class a question that omits the worker.
 */
@Injectable()
export class ResumeImportRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async create(input: NewWorkerResumeImport): Promise<WorkerResumeImport> {
    const inserted = await this.db.insert(workerResumeImports).values(input).returning();
    const row = inserted[0];
    if (!row) throw new Error("Failed to create résumé import");
    return row;
  }

  /**
   * One import, but only this worker's.
   *
   * `undefined` covers both "no such row" and "not yours", deliberately — the caller turns both
   * into the same 404 so the route is not an existence oracle for another worker's imports.
   */
  async findForWorker(id: string, workerId: string): Promise<WorkerResumeImport | undefined> {
    const rows = await this.db
      .select()
      .from(workerResumeImports)
      .where(and(eq(workerResumeImports.id, id), eq(workerResumeImports.workerId, workerId)))
      .limit(1);
    return rows[0];
  }

  /** This worker's most recent import, if any. Served by `wri_worker_recent_idx`. */
  async findLatestForWorker(workerId: string): Promise<WorkerResumeImport | undefined> {
    const rows = await this.db
      .select()
      .from(workerResumeImports)
      .where(eq(workerResumeImports.workerId, workerId))
      .orderBy(desc(workerResumeImports.createdAt))
      .limit(1);
    return rows[0];
  }

  /**
   * Has this exact object already been registered?
   *
   * The unique index on `storage_key` would refuse a second row anyway; this exists so the
   * confirm route can answer a retry with the ORIGINAL row instead of a 500 from a constraint
   * violation. A client on a weak connection that PUTs, times out reading our response, and
   * retries the confirm is the ordinary case, not the adversarial one.
   */
  async findByStorageKey(storageKey: string): Promise<WorkerResumeImport | undefined> {
    const rows = await this.db
      .select()
      .from(workerResumeImports)
      .where(eq(workerResumeImports.storageKey, storageKey))
      .limit(1);
    return rows[0];
  }
}
