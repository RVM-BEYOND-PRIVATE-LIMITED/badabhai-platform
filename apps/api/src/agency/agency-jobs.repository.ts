import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import {
  type Database,
  jobs,
  type Job,
  type NewJob,
  type JobStatus,
  type TradeKey,
  type JobNeededBy,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/**
 * The patch shape for an agency job edit — coarse, non-PII columns only. `updatedAt` is
 * always set by the service. Excludes `id`, `payerId`, `createdAt` (immutable / owner).
 */
export type AgencyJobUpdate = Partial<
  Pick<
    NewJob,
    | "tradeKey"
    | "title"
    | "city"
    | "area"
    | "payMin"
    | "payMax"
    | "minExperienceYears"
    | "maxExperienceYears"
    | "neededBy"
    | "status"
  >
> & { updatedAt: Date };

/** Input for creating an owned job. `payerId` is the SESSION payer (stamped server-side). */
export interface CreateAgencyJobInput {
  payerId: string;
  tradeKey: TradeKey;
  title: string;
  city: string;
  area: string | null;
  payMin: number | null;
  payMax: number | null;
  minExperienceYears: number | null;
  maxExperienceYears: number | null;
  neededBy: JobNeededBy | null;
}

/**
 * Data access for the `jobs` ENTITY write path (ADR-0022 — the FIRST jobs-write service;
 * distinct from `job_postings`). Every read is OWNER-SCOPED: an `:jobId` is always fetched
 * with the payer-id in the WHERE so a cross-tenant row is never even returned (the
 * app-layer tenant chokepoint, defense-in-depth with the row's `payer_id` re-check via
 * `readOwnedById`/`assertOwnedRows` in the service). NO PII columns exist on `jobs`.
 */
@Injectable()
export class AgencyJobsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Create an owned job (status forced to 'open' by the service via the input). */
  async create(input: CreateAgencyJobInput, status: JobStatus): Promise<Job> {
    const [row] = await this.db
      .insert(jobs)
      .values({
        payerId: input.payerId,
        tradeKey: input.tradeKey,
        title: input.title,
        city: input.city,
        area: input.area,
        payMin: input.payMin,
        payMax: input.payMax,
        minExperienceYears: input.minExperienceYears,
        maxExperienceYears: input.maxExperienceYears,
        neededBy: input.neededBy,
        status,
      })
      .returning();
    if (!row) throw new Error("failed to create job");
    return row;
  }

  /**
   * Fetch a job by id, OWNER-SCOPED (payer in the WHERE). Returns undefined for both an
   * unknown id and another payer's job — so the service surfaces the IDENTICAL neutral 404
   * (no-oracle). The service additionally re-asserts ownership via `readOwnedById`.
   */
  async findOwnedById(jobId: string, payerId: string): Promise<Job | undefined> {
    const [row] = await this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, jobId), eq(jobs.payerId, payerId)))
      .limit(1);
    return row;
  }

  /** List the payer's OWN jobs, newest first. Full rows; the service projects facelessly. */
  async listOwned(payerId: string): Promise<Job[]> {
    return this.db
      .select()
      .from(jobs)
      .where(eq(jobs.payerId, payerId))
      .orderBy(desc(jobs.createdAt));
  }

  /**
   * Apply a patch to an OWNED job (payer in the WHERE — a cross-tenant id updates nothing
   * and returns undefined). Returns the updated row or undefined if no owned row matched.
   */
  async updateOwned(jobId: string, payerId: string, patch: AgencyJobUpdate): Promise<Job | undefined> {
    const [row] = await this.db
      .update(jobs)
      .set(patch)
      .where(and(eq(jobs.id, jobId), eq(jobs.payerId, payerId)))
      .returning();
    return row;
  }

  /**
   * Close an OWNED job that is currently `open` (guarded transition). Payer + the expected
   * `open` status are both in the WHERE, so a concurrent close (or a cross-tenant id)
   * updates nothing and returns undefined — the service maps that to the right response.
   */
  async closeOwnedIfOpen(jobId: string, payerId: string, now: Date): Promise<Job | undefined> {
    const [row] = await this.db
      .update(jobs)
      .set({ status: "closed", updatedAt: now })
      .where(and(eq(jobs.id, jobId), eq(jobs.payerId, payerId), eq(jobs.status, "open")))
      .returning();
    return row;
  }
}
