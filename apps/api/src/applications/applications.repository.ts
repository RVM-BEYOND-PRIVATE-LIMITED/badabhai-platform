import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  type Database,
  type Application,
  type Job,
  type ApplicationAction,
  type SkipReason,
  type SourceSurface,
  applications,
  jobs,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import { OPS_LIST_CAP } from "../common/pagination";

/** Coarse, PII-free job fields surfaced in the feed + ops reads. */
export interface FeedJob {
  id: string;
  tradeKey: Job["tradeKey"];
  title: string;
  city: string;
  area: string | null;
  // The experience window the job targets (years). NULLABLE both ends — a blank is
  // "unbounded on that side", never a zero. PII-FREE: year counts (schema.ts §
  // demand-side ranking signals), never an employer or a worker identity.
  minExperienceYears: number | null;
  maxExperienceYears: number | null;
  // Additive worker-visible fields (ADR-0024 final addendum, 2026-07-16): the pay
  // band AS STORED (band columns, never an exact salary) + the coarse shift enum.
  // NULLABLE, PII-FREE by the schema's own classification (pay bands / timing
  // enums — never an employer identity). Same §8 argument as the experience window.
  payMin: number | null;
  payMax: number | null;
  shift: Job["shift"];
}

/** An application row joined with its (coarse, PII-free) job fields. */
export interface ApplicationWithJob {
  jobId: string;
  tradeKey: Job["tradeKey"];
  title: string;
  city: string;
  area: string | null;
  action: ApplicationAction;
  reason: SkipReason | null;
  sourceSurface: SourceSurface;
  rank: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The fields an apply/skip upsert writes (worker/job identify the row). */
export interface UpsertApplicationInput {
  workerId: string;
  jobId: string;
  action: ApplicationAction;
  reason: SkipReason | null;
  sourceSurface: SourceSurface;
  rank: number | null;
}

/**
 * Drizzle data access for the alpha swipe-to-apply surface (ADR-0009). Pure data
 * access only — no business logic, no event emission (those live in the service).
 */
@Injectable()
export class ApplicationsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Open jobs in a DETERMINISTIC order (created_at asc, id tiebreak) so the feed
   * page + its 1-based `rank` are stable across calls and environments.
   *
   * TD73: excludes jobs the worker has already applied to via a NOT EXISTS anti-join
   * on applications (worker_id, job_id, action='applied'). The unique index
   * `applications_worker_job_uq` on (worker_id, job_id) covers this anti-join.
   * Skip exclusion requires an explicit product call (the client currently re-serves
   * skipped jobs forever — see the issue).
   */
  async findOpenJobs(workerId: string, limit: number): Promise<FeedJob[]> {
    return this.db
      .select({
        id: jobs.id,
        tradeKey: jobs.tradeKey,
        title: jobs.title,
        city: jobs.city,
        area: jobs.area,
        minExperienceYears: jobs.minExperienceYears,
        maxExperienceYears: jobs.maxExperienceYears,
        payMin: jobs.payMin,
        payMax: jobs.payMax,
        shift: jobs.shift,
      })
      .from(jobs)
      // TD73: exclude applied jobs server-side. The unique (worker_id, job_id)
      // index makes this anti-join fast even at scale.
      .where(
        and(
          eq(jobs.status, "open"),
          sql`NOT EXISTS (
            SELECT 1 FROM ${applications}
            WHERE ${applications.workerId} = ${workerId}
              AND ${applications.jobId} = ${jobs.id}
              AND ${applications.action} = 'applied'
          )`,
        ),
      )
      // LOCATION SEAM: when the location feature lands, an OPTIONAL city/coords
      // filter goes HERE, default-off so the feed stays liberal until a worker
      // opts into a location. Do NOT implement it now — the alpha feed returns
      // every open job with no location filter (see the worker-app Filters sheet).
      .orderBy(asc(jobs.createdAt), asc(jobs.id))
      .limit(limit);
  }

  /** A single OPEN job by id, or undefined (used to 404 unknown/closed jobs — no oracle). */
  async findJobById(id: string): Promise<Job | undefined> {
    const rows = await this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, id), eq(jobs.status, "open")))
      .limit(1);
    return rows[0];
  }

  /**
   * Upsert the worker's decision for a job, keyed on the unique (worker_id,
   * job_id). On conflict it OVERWRITES action/reason/source_surface/rank and bumps
   * updated_at — last-write-wins (ADR-0009 §2). A double-tap or a flip
   * (apply↔skip) therefore lands on a SINGLE row reflecting the latest intent; no
   * duplicate row is ever created. The audit history of every tap still lives in
   * the events spine.
   *
   * Returns the row plus `inserted`: TRUE only when this call created a NEW row,
   * FALSE when it hit ON CONFLICT DO UPDATE. We read this off the Postgres `xmax`
   * system column — `(xmax = 0)` is TRUE for a fresh INSERT and FALSE for a row
   * touched by the conflict UPDATE — so the caller can count genuine first applies
   * without a separate read (race-safe, single round-trip). PII-free: a boolean.
   */
  async upsertDecision(input: UpsertApplicationInput): Promise<Application & { inserted: boolean }> {
    const rows = await this.db
      .insert(applications)
      .values({
        workerId: input.workerId,
        jobId: input.jobId,
        action: input.action,
        reason: input.reason,
        sourceSurface: input.sourceSurface,
        rank: input.rank,
      })
      .onConflictDoUpdate({
        target: [applications.workerId, applications.jobId],
        set: {
          action: input.action,
          reason: input.reason,
          sourceSurface: input.sourceSurface,
          rank: input.rank,
          updatedAt: sql`now()`,
        },
      })
      .returning({
        id: applications.id,
        jobId: applications.jobId,
        workerId: applications.workerId,
        action: applications.action,
        reason: applications.reason,
        sourceSurface: applications.sourceSurface,
        rank: applications.rank,
        createdAt: applications.createdAt,
        updatedAt: applications.updatedAt,
        // `(xmax = 0)` ⇒ this RETURNING row came from the INSERT, not the UPDATE.
        inserted: sql<boolean>`(xmax = 0)`,
      });
    const row = rows[0];
    if (!row) throw new Error("Failed to upsert application");
    return row;
  }

  /**
   * Atomically bump a job's denormalized applies counter by exactly 1 (ADR-0009
   * swipe-to-apply rollup). Single in-SQL UPDATE — no read-modify-write in app
   * code, so it is race-safe under concurrent applies with no transaction or
   * advisory lock needed (modeled on `unlocks.incrementReveal`). The caller gates
   * this to genuine first-time applies; the CHECK (applicants_received >= 0) holds
   * trivially since we only ever add. PII-free: an integer count.
   */
  async incrementApplicantsReceived(jobId: string): Promise<number> {
    const rows = await this.db
      .update(jobs)
      .set({
        applicantsReceived: sql`${jobs.applicantsReceived} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(jobs.id, jobId))
      .returning({ applicantsReceived: jobs.applicantsReceived });
    const count = rows[0]?.applicantsReceived;
    if (count === undefined) throw new Error("Failed to increment applicants_received");
    return count;
  }

  /**
   * Applicants for a job (ops read). PII-FREE projection — worker_id only, NEVER
   * a name/phone. Newest decision first.
   */
  async findApplicantsByJob(jobId: string): Promise<Application[]> {
    return this.db
      .select()
      .from(applications)
      .where(eq(applications.jobId, jobId))
      .orderBy(asc(applications.createdAt))
      .limit(OPS_LIST_CAP); // bound an otherwise-unbounded ops read
  }

  /**
   * A worker's decisions (ops read), joined to the coarse, PII-free job fields
   * (trade/title/city/area — never employer or pay). Oldest first.
   */
  async findApplicationsByWorker(workerId: string): Promise<ApplicationWithJob[]> {
    return this.db
      .select({
        jobId: applications.jobId,
        tradeKey: jobs.tradeKey,
        title: jobs.title,
        city: jobs.city,
        area: jobs.area,
        action: applications.action,
        reason: applications.reason,
        sourceSurface: applications.sourceSurface,
        rank: applications.rank,
        createdAt: applications.createdAt,
        updatedAt: applications.updatedAt,
      })
      .from(applications)
      .innerJoin(jobs, eq(applications.jobId, jobs.id))
      .where(eq(applications.workerId, workerId))
      .orderBy(asc(applications.createdAt))
      .limit(OPS_LIST_CAP); // bound an otherwise-unbounded ops read
  }

  /**
   * A single worker's decision for a single job, or undefined. Not required by the
   * routes (the upsert is self-contained) but handy for assertions/tests; kept
   * minimal so it does not invite business logic into the repository.
   */
  async findDecision(workerId: string, jobId: string): Promise<Application | undefined> {
    const rows = await this.db
      .select()
      .from(applications)
      .where(and(eq(applications.workerId, workerId), eq(applications.jobId, jobId)))
      .limit(1);
    return rows[0];
  }
}
