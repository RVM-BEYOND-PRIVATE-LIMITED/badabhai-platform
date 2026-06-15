import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, type SQL } from "drizzle-orm";
import { type Database, jobs, type Job, type NewJob } from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/** Filters for the ops list view. */
export interface JobListFilter {
  status?: Job["status"];
  payerId?: string;
  limit: number;
  offset: number;
}

/** Drizzle data access for the `jobs` table. No business logic lives here. */
@Injectable()
export class JobsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async create(input: NewJob): Promise<Job> {
    const inserted = await this.db.insert(jobs).values(input).returning();
    const row = inserted[0];
    if (!row) throw new Error("Failed to create job");
    return row;
  }

  async findById(id: string): Promise<Job | undefined> {
    const rows = await this.db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
    return rows[0];
  }

  /** List jobs (newest first) with optional status/payer filters + pagination. */
  async list(filter: JobListFilter): Promise<Job[]> {
    const conditions: SQL[] = [];
    if (filter.status) conditions.push(eq(jobs.status, filter.status));
    if (filter.payerId) conditions.push(eq(jobs.payerId, filter.payerId));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    return this.db
      .select()
      .from(jobs)
      .where(where)
      .orderBy(desc(jobs.createdAt))
      .limit(filter.limit)
      .offset(filter.offset);
  }

  /**
   * Apply a partial update to a job and return the new row. `updatedAt` is always
   * stamped. Returns undefined if no row matched (caller treats as 404).
   */
  async update(id: string, patch: Partial<NewJob>): Promise<Job | undefined> {
    const rows = await this.db
      .update(jobs)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(jobs.id, id))
      .returning();
    return rows[0];
  }
}
