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

/**
 * Input for creating an owned job. `payerId` is the SESSION payer (stamped server-side);
 * `orgId` is the acting payer's OWNING org (ADR-0027 B5.x Inc 5), resolved by the service
 * BEFORE the create. BOTH are stamped: the partial CHECK `jobs_org_id_when_payer_chk`
 * (`payer_id IS NULL OR org_id IS NOT NULL`, migration 0035) requires a payer-owned job to
 * carry an org_id, so the create fails closed at the DB if org_id were ever omitted.
 */
export interface CreateAgencyJobInput {
  orgId: string;
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
 * with the OWNING `org_id` in the WHERE so a cross-tenant row is never even returned (the
 * app-layer tenant chokepoint, defense-in-depth with the row's `org_id` re-check via
 * `readOwnedByIdOrg`/`assertOwnedRowsByOrg` in the service). NO PII columns exist on `jobs`.
 *
 * TENANCY (ADR-0027 B5.x Inc 5 — the LAST resource-table flip): ownership keys on `org_id`
 * (resolved by the service from the acting payer). The acting `payer_id` is STILL stamped on
 * create (kept for ops/audit + rollback + the partial CHECK that ties payer→org). Two agency
 * members in the SAME org share the org's jobs; a foreign-org job is never returned.
 * BEHAVIOR-PRESERVING under today's solo orgs (org == the one payer).
 */
@Injectable()
export class AgencyJobsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Create an owned job (status forced to 'open' by the service via the input). Stamps BOTH
   * `org_id` (the ownership key) AND `payer_id` (the acting payer) — the partial CHECK
   * `jobs_org_id_when_payer_chk` (migration 0035) requires a payer-owned job to carry an
   * org_id, so both are always present together.
   */
  async create(input: CreateAgencyJobInput, status: JobStatus): Promise<Job> {
    const [row] = await this.db
      .insert(jobs)
      .values({
        orgId: input.orgId,
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
   * Fetch a job by id, OWNER-SCOPED (org in the WHERE). Returns undefined for both an
   * unknown id and another org's job — so the service surfaces the IDENTICAL neutral 404
   * (no-oracle). The service additionally re-asserts org ownership via `readOwnedByIdOrg`.
   */
  async findOwnedById(jobId: string, orgId: string): Promise<Job | undefined> {
    const [row] = await this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, jobId), eq(jobs.orgId, orgId)))
      .limit(1);
    return row;
  }

  /** List the org's OWN jobs, newest first. Full rows; the service projects facelessly. */
  async listOwned(orgId: string): Promise<Job[]> {
    return this.db
      .select()
      .from(jobs)
      .where(eq(jobs.orgId, orgId))
      .orderBy(desc(jobs.createdAt));
  }

  /**
   * Apply a patch to an OWNED job (org in the WHERE — a cross-tenant id updates nothing
   * and returns undefined). Returns the updated row or undefined if no owned row matched.
   */
  async updateOwned(jobId: string, orgId: string, patch: AgencyJobUpdate): Promise<Job | undefined> {
    const [row] = await this.db
      .update(jobs)
      .set(patch)
      .where(and(eq(jobs.id, jobId), eq(jobs.orgId, orgId)))
      .returning();
    return row;
  }

  /**
   * Close an OWNED job that is currently `open` (guarded transition). Org + the expected
   * `open` status are both in the WHERE, so a concurrent close (or a cross-tenant id)
   * updates nothing and returns undefined — the service maps that to the right response.
   */
  async closeOwnedIfOpen(jobId: string, orgId: string, now: Date): Promise<Job | undefined> {
    const [row] = await this.db
      .update(jobs)
      .set({ status: "closed", updatedAt: now })
      .where(and(eq(jobs.id, jobId), eq(jobs.orgId, orgId), eq(jobs.status, "open")))
      .returning();
    return row;
  }
}
