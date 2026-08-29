import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray } from "drizzle-orm";
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
      /**
       * One or more stints, in DISPLAY order (most recent first) — see `sortOrder` below.
       * A single-role employment is a one-element array and writes the identical row it did
       * when this took one `role`.
       */
      roles: readonly {
        roleLabel: string;
        startYm: string | null;
        endYm: string | null;
        workDone: string | null;
      }[];
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
        inserted.flatMap((employment, index) =>
          rows[index]!.roles.map((role, roleIndex) => ({
            employmentId: employment.id,
            roleLabel: role.roleLabel,
            startYm: role.startYm,
            endYm: role.endYm,
            workDone: role.workDone,
            // THE SUBMITTED ORDER, never derived from the dates — the same rule the employment
            // `sortOrder` follows one statement up, and for the same reason: a promotion in the
            // same month as its predecessor has no date to sort by, and re-deriving would
            // reshuffle stints between renders and make every regenerated PDF a false diff.
            sortOrder: roleIndex,
          })),
        ),
      );

      return { replacedExisting: existing.length > 0 };
    });
  }

  /**
   * Store the model's rephrasing of one or more stints (#1350).
   *
   * WRITES ONLY `work_done_polished`. The worker's own `work_done` is never touched — it is the
   * system of record, the fallback whenever this column is null, and what makes the section-8
   * override reversible by changing which column the renderer reads.
   *
   * ONE STATEMENT PER STINT rather than a CASE expression: the set is at most a handful of rows
   * (four employers, a stint or two each), and a readable loop beats a clever update nobody can
   * check. Runs in a transaction so a partial write cannot leave half a history polished.
   */
  async savePolishedDescriptions(byRoleId: ReadonlyMap<string, string>): Promise<void> {
    if (byRoleId.size === 0) return;
    await this.db.transaction(async (tx) => {
      for (const [id, polished] of byRoleId) {
        await tx
          .update(workerEmploymentRole)
          .set({ workDonePolished: polished })
          .where(eq(workerEmploymentRole.id, id));
      }
    });
  }

  /**
   * Record the worker's choice of description source for ONE employment (#1354).
   *
   * OWNERSHIP IS PROVED IN THE STATEMENT, not checked before it. The employment id comes from
   * the client, so the UPDATE joins back to `worker_employment` and filters on `worker_id`:
   * a worker passing somebody else's employment id updates zero rows and is told nothing about
   * whether it exists. A read-then-write would be the same query twice with a race between
   * them, and a `WHERE id = ?` alone is the IDOR this codebase's authz review exists to catch.
   *
   * PER EMPLOYMENT, THOUGH THE COLUMN IS PER ROLE. The sheet prints ONE work line per employer
   * — `workLine` joins the distinct descriptions across that employer's stints — so one line is
   * what a worker sees and one decision is what they can meaningfully make. Setting the flag on
   * every stint of the employment keeps the data model honest (the text lives on the stint)
   * without inventing a choice the UI cannot present.
   *
   * Returns how many stints were updated: zero means not this worker's employment, and the
   * caller turns that into a 404 rather than a 403 — no existence oracle.
   */
  async setPolishDeclined(
    workerId: string,
    employmentId: string,
    declined: boolean,
  ): Promise<number> {
    const updated = await this.db
      .update(workerEmploymentRole)
      .set({ workDonePolishDeclined: declined })
      .where(
        and(
          eq(workerEmploymentRole.employmentId, employmentId),
          // The join that proves ownership. `inArray` over a subquery rather than a SQL join,
          // because Drizzle's update builder takes a WHERE and not a FROM.
          inArray(
            workerEmploymentRole.employmentId,
            this.db
              .select({ id: workerEmployment.id })
              .from(workerEmployment)
              .where(eq(workerEmployment.workerId, workerId)),
          ),
        ),
      )
      .returning({ id: workerEmploymentRole.id });
    return updated.length;
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
        workDonePolished: workerEmploymentRole.workDonePolished,
        workDonePolishDeclined: workerEmploymentRole.workDonePolishDeclined,
        id: workerEmploymentRole.id,
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
        id: role.id,
        roleLabel: role.roleLabel,
        startYm: role.startYm,
        endYm: role.endYm,
        workDone: role.workDone,
        workDonePolished: role.workDonePolished,
        workDonePolishDeclined: role.workDonePolishDeclined,
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
