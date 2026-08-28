import { Inject, Injectable } from "@nestjs/common";
import { asc, eq, inArray } from "drizzle-orm";
import { type Database, workerEmployment, workerEmploymentRole } from "@badabhai/db";

import { DATABASE } from "../database/database.module";
import { PiiCryptoService } from "../common/pii-crypto.service";
import type { WorkerEmploymentRecord } from "../resume/resume-employment-rows";

/**
 * READS `worker_employment` for the résumé's Zone 4. READ ONLY, ON PURPOSE.
 *
 * THE WRITER IS BLOCKED AND THE READER IS NOT. Work history is captured by a post-interview
 * form the worker types, and how that surface asks for it is an open owner ruling — a role pack
 * cannot carry it (MAX_ENGINE_ASKS is 24 and a multi-employer loop needs roughly six keys per
 * employer). Shipping the reader first means the capture surface, whenever it lands, flips
 * workers over one at a time: this returns `[]` for everyone today, `resume-render-input.ts`
 * falls back to the tag-derived line, and the first worker who fills the form gets the designed
 * block on their next render with no cutover, no backfill and no migration.
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
