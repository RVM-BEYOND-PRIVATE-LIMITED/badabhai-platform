import { Inject, Injectable } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import { type Database, workerLanguages } from "@badabhai/db";

import { DATABASE } from "../database/database.module";
import type { WorkerLanguageRecord } from "../resume/resume-qualification-rows";

/**
 * READS AND WRITES `worker_language` (migration 0110) — the finishing form's Languages page.
 *
 * ═══ THE SAME SEAM `WorkerQualificationsRepository` DRAWS, FOR THE SAME REASON ═══
 *
 * Repeatable, worker-owned, ordered rows under a uniqueness constraint on `(worker_id,
 * sort_order)` — the shape that forces delete-then-insert inside ONE transaction rather than an
 * upsert. `worker_attributes` holds exactly one `languages` list per worker; this endpoint owns
 * many rows, so it takes the qualifications seam rather than the preferences one.
 *
 * ═══ NO ENCRYPTION, AND THAT IS 0110's RULING RESTATED ═══
 *
 * A language slug and three booleans are not identity and not an employment record. The rows
 * never cross the AI boundary: the sheet composes them deterministically in
 * `resume-qualification-rows.ts`.
 */
@Injectable()
export class WorkerLanguagesRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * REPLACE this worker's language rows, in ONE transaction.
   *
   * DELETE-ALL-THEN-INSERT, NOT AN UPSERT — identical argument to the qualifications repository:
   * `wl_worker_sort_uq` is UNIQUE on `(worker_id, sort_order)`, so re-submitting a list where the
   * worker removed the second of three collides on every position after it. A replace is one
   * statement and cannot leave the list half-updated.
   *
   * THE SUBMITTED ORDER IS THE DISPLAY ORDER, never derived and never sorted by slug — re-deriving
   * would reshuffle rows between renders and make every regenerated PDF a false diff.
   *
   * Returns the count the event needs and whether anything was replaced — facts only the
   * transaction can know.
   */
  async replaceForWorker(
    workerId: string,
    languages: readonly {
      language: string;
      canSpeak: boolean;
      canRead: boolean;
      canWrite: boolean;
    }[],
  ): Promise<{ languagesWritten: number; replacedExisting: boolean }> {
    return this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: workerLanguages.id })
        .from(workerLanguages)
        .where(eq(workerLanguages.workerId, workerId));
      const replacedExisting = existing.length > 0;

      await tx.delete(workerLanguages).where(eq(workerLanguages.workerId, workerId));
      if (languages.length > 0) {
        await tx.insert(workerLanguages).values(
          languages.map((l, index) => ({
            workerId,
            language: l.language,
            canSpeak: l.canSpeak,
            canRead: l.canRead,
            canWrite: l.canWrite,
            sortOrder: index,
          })),
        );
      }

      return { languagesWritten: languages.length, replacedExisting };
    });
  }

  /**
   * One worker's language rows in DISPLAY ORDER.
   *
   * ORDERED BY `sort_order`, NEVER BY `language` — the schema's decision, restated so a future
   * reader does not "fix" it: the worker chose the order and a re-render must reproduce it.
   *
   * The shape is `WorkerLanguageRecord`, the same pure composition input the qualifications
   * reader returns, so the render path treats all three credential lists identically.
   */
  async loadForResume(workerId: string): Promise<WorkerLanguageRecord[]> {
    const rows = await this.db
      .select({
        language: workerLanguages.language,
        canSpeak: workerLanguages.canSpeak,
        canRead: workerLanguages.canRead,
        canWrite: workerLanguages.canWrite,
      })
      .from(workerLanguages)
      .where(eq(workerLanguages.workerId, workerId))
      .orderBy(asc(workerLanguages.sortOrder));
    return rows;
  }
}
