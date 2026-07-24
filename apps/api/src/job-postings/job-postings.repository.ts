import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { type Database, jobPostings, type JobPosting, type NewJobPosting } from "@badabhai/db";
import type { JobPostingStatus } from "@badabhai/types";
import { DATABASE } from "../database/database.module";

/**
 * API response shape for a job posting — snake_case keys, matching the
 * workers API convention (workers.repository.ts WorkerListItem).
 * Free-text fields (org_label, role_title, location_label, description)
 * are included as-is; they are sanitized at write time (ADR-0024 guard).
 */
export interface JobPostingApi {
  id: string;
  created_by: string;
  payer_id: string | null;
  org_label: string;
  role_title: string;
  location_label: string | null;
  description: string | null;
  vacancy_band: JobPosting["vacancyBand"];
  status: JobPostingStatus;
  skill_phrases: string[];
  skill_ids: string[];
  applicants_received: number;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
}

/** Map a Drizzle camelCase row to the snake_case API shape. */
function toJobPostingApi(row: JobPosting): JobPostingApi {
  return {
    id: row.id,
    created_by: row.createdBy,
    payer_id: row.payerId,
    org_label: row.orgLabel,
    role_title: row.roleTitle,
    location_label: row.locationLabel,
    description: row.description,
    vacancy_band: row.vacancyBand,
    status: row.status,
    skill_phrases: row.skillPhrases,
    skill_ids: row.skillIds,
    applicants_received: row.applicantsReceived,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    closed_at: row.closedAt,
  };
}

/** Fields a PATCH may set on a job_postings row (column-shaped, snake-internal). */
export type JobPostingUpdate = Partial<
  Pick<
    NewJobPosting,
    | "orgLabel"
    | "roleTitle"
    | "locationLabel"
    | "description"
    | "vacancyBand"
    | "status"
    // ADR-0030 / TAX-6: the posting's skill phrases + their canonicalized closed-set ids.
    | "skillPhrases"
    | "skillIds"
  >
> & { updatedAt: Date };

export { toJobPostingApi, type JobPostingApi };

@Injectable()
export class JobPostingsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async create(input: NewJobPosting): Promise<JobPostingApi> {
    const inserted = await this.db.insert(jobPostings).values(input).returning();
    const row = inserted[0];
    if (!row) throw new Error("Failed to create job posting");
    return toJobPostingApi(row);
  }

  async findById(id: string): Promise<JobPostingApi | undefined> {
    const rows = await this.db.select().from(jobPostings).where(eq(jobPostings.id, id)).limit(1);
    return rows[0] ? toJobPostingApi(rows[0]) : undefined;
  }

  /** List postings newest first, optionally filtered by status. */
  async list(status?: JobPostingStatus, limit = 100): Promise<JobPostingApi[]> {
    const where = status ? eq(jobPostings.status, status) : undefined;
    const rows = await this.db
      .select()
      .from(jobPostings)
      .where(where)
      .orderBy(desc(jobPostings.createdAt))
      .limit(limit);
    return rows.map(toJobPostingApi);
  }

  /**
   * Apply a field/status update; returns the updated row, or undefined if gone.
   *
   * Intentionally guarded on `id` only (last-writer-wins): for a single-operator
   * internal register, concurrent edits are acceptable. Only the terminal
   * `closed` transition is status-guarded (see `close`) — that is the one
   * invariant we must not lose to a race. The service's pre-read `closed` check
   * is best-effort, not a lock.
   */
  async update(id: string, patch: JobPostingUpdate): Promise<JobPostingApi | undefined> {
    const rows = await this.db
      .update(jobPostings)
      .set(patch)
      .where(eq(jobPostings.id, id))
      .returning();
    return rows[0] ? toJobPostingApi(rows[0]) : undefined;
  }

  /**
   * Transition a posting to `closed`, setting closed_at/updated_at. Guarded on the
   * current status so an already-closed row (a redelivered/concurrent close) is a
   * no-op at the DB and returns undefined — the service maps that to a 409.
   */
  async close(
    id: string,
    previousStatus: "draft" | "open",
    closedAt: Date,
  ): Promise<JobPostingApi | undefined> {
    const rows = await this.db
      .update(jobPostings)
      .set({ status: "closed", closedAt, updatedAt: closedAt })
      .where(and(eq(jobPostings.id, id), eq(jobPostings.status, previousStatus)))
      .returning();
    return rows[0] ? toJobPostingApi(rows[0]) : undefined;
  }

  // ---------------------------------------------------------------------------
  // PAYER self-serve scope (ADR-0019 / ADR-0022 module 9). Every read/write is
  // guarded on `payer_id` IN THE QUERY, so tenancy is enforced at the data layer
  // (XB-A horizontal authz), not just the service. `payer_id` is the SESSION payer
  // the controller passes — never a body/route value.
  // ---------------------------------------------------------------------------

  /**
   * Owner-scoped read (NO-ORACLE, F-3): the row ONLY if it exists AND belongs to
   * `payerId`. A not-found id and another payer's id BOTH resolve to `undefined`, so
   * the service maps both to the SAME neutral 404 (a payer cannot probe foreign ids).
   */
  async findByIdAndPayer(id: string, payerId: string): Promise<JobPostingApi | undefined> {
    const rows = await this.db
      .select()
      .from(jobPostings)
      .where(and(eq(jobPostings.id, id), eq(jobPostings.payerId, payerId)))
      .limit(1);
    return rows[0] ? toJobPostingApi(rows[0]) : undefined;
  }

  /** A payer's OWN postings newest first, optionally filtered by status. */
  async listByPayer(
    payerId: string,
    status?: JobPostingStatus,
    limit = 100,
  ): Promise<JobPostingApi[]> {
    const where = status
      ? and(eq(jobPostings.payerId, payerId), eq(jobPostings.status, status))
      : eq(jobPostings.payerId, payerId);
    const rows = await this.db
      .select()
      .from(jobPostings)
      .where(where)
      .orderBy(desc(jobPostings.createdAt))
      .limit(limit);
    return rows.map(toJobPostingApi);
  }

  /**
   * Owner-scoped field/status update: guarded on `id` AND `payer_id`, so a payer can
   * only mutate its OWN row (the ownership lives in the WHERE — no TOCTOU window
   * between an ownership read and the write). Returns undefined if gone or not-owned.
   */
  async updateOwned(
    id: string,
    payerId: string,
    patch: JobPostingUpdate,
  ): Promise<JobPostingApi | undefined> {
    const rows = await this.db
      .update(jobPostings)
      .set(patch)
      .where(and(eq(jobPostings.id, id), eq(jobPostings.payerId, payerId)))
      .returning();
    return rows[0] ? toJobPostingApi(rows[0]) : undefined;
  }

  /**
   * Owner-scoped close: guarded on `id` AND `payer_id` AND the current status, so an
   * already-closed, gone, or not-owned row is a DB no-op → undefined (service maps to
   * 409/404 — without leaking which).
   */
  async closeOwned(
    id: string,
    payerId: string,
    previousStatus: "draft" | "open",
    closedAt: Date,
  ): Promise<JobPostingApi | undefined> {
    const rows = await this.db
      .update(jobPostings)
      .set({ status: "closed", closedAt, updatedAt: closedAt })
      .where(
        and(
          eq(jobPostings.id, id),
          eq(jobPostings.payerId, payerId),
          eq(jobPostings.status, previousStatus),
        ),
      )
      .returning();
    return rows[0] ? toJobPostingApi(rows[0]) : undefined;
  }

  /**
   * Owner-scoped status transition (B1): guarded on `id` AND `payer_id` AND the current
   * status, so a wrong-state / gone / not-owned row is a DB no-op → undefined (the service
   * maps that to a 409, without leaking which). Mirrors {@link closeOwned} for the reversible
   * open<->paused transitions (pause: open→paused, resume: paused→open).
   */
  async transitionOwned(
    id: string,
    payerId: string,
    fromStatus: JobPostingStatus,
    toStatus: JobPostingStatus,
  ): Promise<JobPostingApi | undefined> {
    const rows = await this.db
      .update(jobPostings)
      .set({ status: toStatus, updatedAt: new Date() })
      .where(
        and(
          eq(jobPostings.id, id),
          eq(jobPostings.payerId, payerId),
          eq(jobPostings.status, fromStatus),
        ),
      )
      .returning();
    return rows[0] ? toJobPostingApi(rows[0]) : undefined;
  }
}
