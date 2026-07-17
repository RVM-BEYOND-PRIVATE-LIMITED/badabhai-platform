import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { type Database, type Job, type JobNeededBy, type JobShift, jobs } from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/**
 * The EXPLICIT worker-visible column set — exactly what
 * {@link JobsRepository.findWorkerVisibleJobById} selects, nothing more.
 */
export interface WorkerVisibleJobRow {
  id: string;
  tradeKey: Job["tradeKey"];
  title: string;
  city: string;
  area: string | null;
  payMin: number | null;
  payMax: number | null;
  minExperienceYears: number | null;
  maxExperienceYears: number | null;
  neededBy: JobNeededBy | null;
  shift: JobShift | null;
  description: string | null;
  benefits: string[] | null;
  requirements: string[] | null;
}

/**
 * Drizzle data access for the worker-scoped job detail read (ADR-0024 final
 * addendum, 2026-07-16). Pure data access only — the neutral 404 and the wire
 * mapping live in the service.
 */
@Injectable()
export class JobsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * ONE open job by id, EXPLICIT column projection (never `select *`): exactly
   * the ADR-0024 final-addendum SHOW set. `payer_id` (the opaque employer/agency
   * owner ref), `status`, `applicants_received`, and `created_at`/`updated_at`
   * are NEVER selected — the owner ref must never ride a worker-authed read path
   * (§2 / ADR-0024 "HIDE — employer identity, entirely"), and the rest are
   * internal bookkeeping, not worker-visible content.
   *
   * `status = 'open'` is IN THE WHERE: a CLOSED job is invisible on the worker
   * path by design and resolves to the SAME neutral 404 as an unknown id — no
   * closed-vs-unknown oracle.
   */
  async findWorkerVisibleJobById(jobId: string): Promise<WorkerVisibleJobRow | undefined> {
    const [row] = await this.db
      .select({
        id: jobs.id,
        tradeKey: jobs.tradeKey,
        title: jobs.title,
        city: jobs.city,
        area: jobs.area,
        payMin: jobs.payMin,
        payMax: jobs.payMax,
        minExperienceYears: jobs.minExperienceYears,
        maxExperienceYears: jobs.maxExperienceYears,
        neededBy: jobs.neededBy,
        shift: jobs.shift,
        description: jobs.description,
        benefits: jobs.benefits,
        requirements: jobs.requirements,
      })
      .from(jobs)
      .where(and(eq(jobs.id, jobId), eq(jobs.status, "open")))
      .limit(1);
    return row;
  }
}
