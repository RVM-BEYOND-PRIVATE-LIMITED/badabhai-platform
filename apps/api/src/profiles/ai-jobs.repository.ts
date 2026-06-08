import { Inject, Injectable } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import { type Database, aiJobs, type AiJob, type NewAiJob } from "@badabhai/db";
import { DATABASE } from "../database/database.module";

@Injectable()
export class AiJobsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Most-recent AI jobs first, for the read-only ops console. */
  async list(limit = 100): Promise<AiJob[]> {
    return this.db.select().from(aiJobs).orderBy(desc(aiJobs.createdAt)).limit(limit);
  }

  async create(input: NewAiJob): Promise<AiJob> {
    const inserted = await this.db.insert(aiJobs).values(input).returning();
    const row = inserted[0];
    if (!row) throw new Error("Failed to create AI job");
    return row;
  }

  async markCompleted(id: string, outputRef: Record<string, unknown>): Promise<void> {
    await this.db
      .update(aiJobs)
      .set({ status: "completed", outputRef, updatedAt: new Date() })
      .where(eq(aiJobs.id, id));
  }

  async markFailed(id: string, errorMessage: string): Promise<void> {
    await this.db
      .update(aiJobs)
      .set({ status: "failed", errorMessage, updatedAt: new Date() })
      .where(eq(aiJobs.id, id));
  }
}
