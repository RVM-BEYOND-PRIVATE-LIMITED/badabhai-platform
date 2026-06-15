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

/** Coarse, PII-free job fields surfaced in the feed + ops reads. */
export interface FeedJob {
  id: string;
  tradeKey: Job["tradeKey"];
  title: string;
  city: string;
  area: string | null;
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
   */
  async findOpenJobs(limit: number): Promise<FeedJob[]> {
    return this.db
      .select({
        id: jobs.id,
        tradeKey: jobs.tradeKey,
        title: jobs.title,
        city: jobs.city,
        area: jobs.area,
      })
      .from(jobs)
      .where(eq(jobs.status, "open"))
      .orderBy(asc(jobs.createdAt), asc(jobs.id))
      .limit(limit);
  }

  /** A single job by id, or undefined (used to 404 unknown jobIds — no oracle). */
  async findJobById(id: string): Promise<Job | undefined> {
    const rows = await this.db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
    return rows[0];
  }

  /**
   * Upsert the worker's decision for a job, keyed on the unique (worker_id,
   * job_id). On conflict it OVERWRITES action/reason/source_surface/rank and bumps
   * updated_at — last-write-wins (ADR-0009 §2). A double-tap or a flip
   * (apply↔skip) therefore lands on a SINGLE row reflecting the latest intent; no
   * duplicate row is ever created. The audit history of every tap still lives in
   * the events spine.
   */
  async upsertDecision(input: UpsertApplicationInput): Promise<Application> {
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
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to upsert application");
    return row;
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
      .orderBy(asc(applications.createdAt));
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
      .orderBy(asc(applications.createdAt));
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
