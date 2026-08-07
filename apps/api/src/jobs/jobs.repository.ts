import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import {
  type Database,
  type Job,
  type JobNeededBy,
  type JobShift,
  jobs,
  jobPostings,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/**
 * The EXPLICIT worker-visible column set — exactly what
 * {@link JobsRepository.findWorkerVisibleJobById} selects, nothing more.
 */
export interface WorkerVisibleJobRow {
  id: string;
  // NULL for a V1 posting: `job_postings` has no `trade_key` (it carries a free-text
  // `role_title` only). Legacy `jobs` rows always have one.
  tradeKey: Job["tradeKey"] | null;
  title: string;
  // NULL for a V1 posting whose coarse `city` bucket was never filled in
  // (`job_postings.city` is nullable). Legacy `jobs.city` is NOT NULL, so a legacy
  // row always has one. DELIBERATELY NOT back-filled from `job_postings.location_label`
  // — see the fallback query below.
  city: string | null;
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
    const [legacy] = await this.db
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
    if (legacy) return legacy;

    // V1 (ADR-0036): the feed serves `job_postings`, so a tapped/applied job id is a
    // POSTING id, not a legacy `jobs.id` — the query above misses it and the detail
    // screen was left with only the light title/place it was handed. Fall back to the
    // OPEN posting and project the SAME worker-visible, PII-free SHOW set. Fields the
    // posting doesn't carry are NULL (never invented): `trade_key`, `area`, the
    // experience window, `benefits`, `requirements`, and `city` when the coarse bucket
    // is unset. `status = 'open'` keeps the SAME neutral-404 no-oracle rule.
    // `org_label` / `payer_id` are NEVER selected (employer identity, HIDE — ADR-0024/§2).
    //
    // `city` IS NOT BACK-FILLED FROM `location_label`, deliberately. `job_postings.city`
    // is the COARSE, matchable city bucket ("Pune"); `location_label` is 200 chars of
    // poster-typed free text that is explicitly EXEMPT from the PII heuristic
    // (job-postings.dto.ts) and may name the site or the employer ("Near <Employer> gate
    // 3"). Promoting it into a worker-visible field would put payer free text on the
    // worker path — the same call match-feed.service.ts already made for `area`
    // ("inventing one from `location_label` would put payer free text on a worker card").
    // A NULL city is the honest answer; the client already hides the row.
    const [posting] = await this.db
      .select({
        id: jobPostings.id,
        tradeKey: sql<Job["tradeKey"] | null>`NULL`,
        title: jobPostings.roleTitle,
        city: jobPostings.city,
        area: sql<string | null>`NULL`,
        payMin: jobPostings.payMin,
        payMax: jobPostings.payMax,
        minExperienceYears: sql<number | null>`NULL`,
        maxExperienceYears: sql<number | null>`NULL`,
        neededBy: jobPostings.neededBy,
        shift: jobPostings.shift,
        description: jobPostings.description,
        benefits: sql<string[] | null>`NULL`,
        requirements: sql<string[] | null>`NULL`,
      })
      .from(jobPostings)
      .where(and(eq(jobPostings.id, jobId), eq(jobPostings.status, "open")))
      .limit(1);
    return posting;
  }
}
