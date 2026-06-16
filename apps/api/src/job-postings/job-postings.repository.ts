import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import {
  type Database,
  jobPostings,
  type JobPosting,
  type NewJobPosting,
} from "@badabhai/db";
import type { JobPostingStatus } from "@badabhai/types";
import { DATABASE } from "../database/database.module";

/** Fields a PATCH may set on a job_postings row (column-shaped, snake-internal). */
export type JobPostingUpdate = Partial<
  Pick<
    NewJobPosting,
    "orgLabel" | "roleTitle" | "locationLabel" | "description" | "vacancyBand" | "status"
  >
> & { updatedAt: Date };

@Injectable()
export class JobPostingsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async create(input: NewJobPosting): Promise<JobPosting> {
    const inserted = await this.db.insert(jobPostings).values(input).returning();
    const row = inserted[0];
    if (!row) throw new Error("Failed to create job posting");
    return row;
  }

  async findById(id: string): Promise<JobPosting | undefined> {
    const rows = await this.db
      .select()
      .from(jobPostings)
      .where(eq(jobPostings.id, id))
      .limit(1);
    return rows[0];
  }

  /** List postings newest first, optionally filtered by status. */
  async list(status?: JobPostingStatus, limit = 100): Promise<JobPosting[]> {
    const where = status ? eq(jobPostings.status, status) : undefined;
    return this.db
      .select()
      .from(jobPostings)
      .where(where)
      .orderBy(desc(jobPostings.createdAt))
      .limit(limit);
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
  async update(id: string, patch: JobPostingUpdate): Promise<JobPosting | undefined> {
    const rows = await this.db
      .update(jobPostings)
      .set(patch)
      .where(eq(jobPostings.id, id))
      .returning();
    return rows[0];
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
  ): Promise<JobPosting | undefined> {
    const rows = await this.db
      .update(jobPostings)
      .set({ status: "closed", closedAt, updatedAt: closedAt })
      .where(and(eq(jobPostings.id, id), eq(jobPostings.status, previousStatus)))
      .returning();
    return rows[0];
  }
}
