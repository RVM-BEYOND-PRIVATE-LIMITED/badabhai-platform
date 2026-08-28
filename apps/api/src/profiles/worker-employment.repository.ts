import { Inject, Injectable } from "@nestjs/common";
import { asc, eq, inArray } from "drizzle-orm";
import { type Database, workerEmployment, workerEmploymentRole } from "@badabhai/db";

import { DATABASE } from "../database/database.module";
import { PiiCryptoService } from "../common/pii-crypto.service";
import type { WorkerEmploymentRecord } from "../resume/resume-employment-rows";

/**
 * READS AND WRITES `worker_employment` for the résumé's Zone 4.
 *
 * The reader shipped first, deliberately, while the capture surface was an open owner ruling.
 * That ruling landed (R4 Q1: a post-interview form, four employers, one role each), so the
 * writer is here now — and the staged order paid off exactly as intended: workers flip over one
 * at a time as they fill the form, with no cutover, no backfill and no migration.
 *
 * ONE ROUND TRIP PER LEVEL, NOT ONE PER EMPLOYER. Two statements — the employments, then every
 * role for all of them via `IN (...)` — rather than an N+1 over at most five employers. Not a
 * join, because a join would multiply the encrypted employer name across its role rows and this
 * decrypts once per employment.
 *
 * DEGRADES TO ABSENCE, NEVER TO A FAILED RENDER: an employer name whose token will not decrypt
 * drops THAT employment and keeps the rest. A rotated key must cost a line, never the PDF.
 */
@Injectable()
export class WorkerEmploymentRepository {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly pii: PiiCryptoService,
  ) {}

  /**
   * REPLACE this worker's whole history, in one transaction.
   *
   * DELETE-ALL-THEN-INSERT, NOT AN UPSERT, and the schema forces it: `we_worker_sort_uq` is
   * UNIQUE on `(worker_id, sort_order)`, so re-submitting a form where the worker deleted the
   * second of three employers collides on every position after it. Positional upserts would
   * need a two-phase shuffle to stay legal; a replace is one statement and cannot leave the
   * table half-updated.
   *
   * ROLES CASCADE. `worker_employment_role.employment_id` is ON DELETE CASCADE, so the roles go
   * with their employment and there is no orphan sweep to forget.
   *
   * TAKES CIPHERTEXT, NEVER PLAINTEXT. `employerNameEnc` arrives already encrypted — the same
   * split as `updateFullName`. A repository that could encrypt is a repository that could
   * forget to.
   *
   * Returns whether it replaced an existing history, which the event needs and only the
   * transaction can know.
   */
  async replaceForWorker(
    workerId: string,
    rows: readonly {
      employerNameEnc: string;
      employerCity: string | null;
      employerState: string | null;
      startYm: string | null;
      endYm: string | null;
      durationStated: boolean;
      role: {
        roleLabel: string;
        startYm: string | null;
        endYm: string | null;
        workDone: string | null;
      };
    }[],
  ): Promise<{ replacedExisting: boolean }> {
    return this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: workerEmployment.id })
        .from(workerEmployment)
        .where(eq(workerEmployment.workerId, workerId));

      await tx.delete(workerEmployment).where(eq(workerEmployment.workerId, workerId));
      if (rows.length === 0) return { replacedExisting: existing.length > 0 };

      const inserted = await tx
        .insert(workerEmployment)
        .values(
          rows.map((r, index) => ({
            workerId,
            employerNameEnc: r.employerNameEnc,
            employerCity: r.employerCity,
            employerState: r.employerState,
            startYm: r.startYm,
            endYm: r.endYm,
            durationStated: r.durationStated,
            // The FORM's order is the display order, most recent first. Never derived from the
            // dates: two jobs can start in the same month, and a worker whose dates are unstated
            // still described them in an order.
            sortOrder: index,
          })),
        )
        .returning({ id: workerEmployment.id });

      await tx.insert(workerEmploymentRole).values(
        inserted.map((employment, index) => ({
          employmentId: employment.id,
          roleLabel: rows[index]!.role.roleLabel,
          startYm: rows[index]!.role.startYm,
          endYm: rows[index]!.role.endYm,
          workDone: rows[index]!.role.workDone,
          sortOrder: 0,
        })),
      );

      return { replacedExisting: existing.length > 0 };
    });
  }

  /**
   * One worker's history in DISPLAY ORDER (most recent first).
   *
   * ORDERED BY `sort_order`, NEVER BY DATE, and that is the schema's decision restated here so a
   * future reader does not "fix" it: two jobs can start in the same month, and a worker whose
   * dates are unstated still described them in an order. Sorting by date would reshuffle rows
   * between renders and make every regenerated PDF a false diff.
   */
  async loadForResume(workerId: string): Promise<WorkerEmploymentRecord[]> {
    const employments = await this.db
      .select({
        id: workerEmployment.id,
        employerNameEnc: workerEmployment.employerNameEnc,
        employerCity: workerEmployment.employerCity,
        employerState: workerEmployment.employerState,
        startYm: workerEmployment.startYm,
        endYm: workerEmployment.endYm,
        durationStated: workerEmployment.durationStated,
      })
      .from(workerEmployment)
      .where(eq(workerEmployment.workerId, workerId))
      .orderBy(asc(workerEmployment.sortOrder));

    if (employments.length === 0) return [];

    const roles = await this.db
      .select({
        employmentId: workerEmploymentRole.employmentId,
        roleLabel: workerEmploymentRole.roleLabel,
        startYm: workerEmploymentRole.startYm,
        endYm: workerEmploymentRole.endYm,
        workDone: workerEmploymentRole.workDone,
      })
      .from(workerEmploymentRole)
      .where(
        inArray(
          workerEmploymentRole.employmentId,
          employments.map((e) => e.id),
        ),
      )
      .orderBy(asc(workerEmploymentRole.sortOrder));

    const byEmployment = new Map<string, WorkerEmploymentRecord["roles"][number][]>();
    for (const role of roles) {
      const bucket = byEmployment.get(role.employmentId) ?? [];
      bucket.push({
        roleLabel: role.roleLabel,
        startYm: role.startYm,
        endYm: role.endYm,
        workDone: role.workDone,
      });
      byEmployment.set(role.employmentId, bucket);
    }

    const out: WorkerEmploymentRecord[] = [];
    for (const e of employments) {
      let employer: string;
      try {
        employer = this.pii.decrypt(e.employerNameEnc);
      } catch {
        // NEVER LOG THE TOKEN OR THE ERROR DETAIL — the same contract the name and the phone
        // already have. The employment is dropped rather than printed with a placeholder: an
        // employer field is never blank and is never invented (§11 #4), so a name we cannot
        // read is a row we cannot honestly render.
        continue;
      }
      if (!employer.trim()) continue;
      out.push({
        employer,
        employerCity: e.employerCity,
        employerState: e.employerState,
        startYm: e.startYm,
        endYm: e.endYm,
        durationStated: e.durationStated,
        roles: byEmployment.get(e.id) ?? [],
      });
    }
    return out;
  }
}
