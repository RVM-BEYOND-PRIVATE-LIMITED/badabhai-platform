import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import {
  type Database,
  workerProfiles,
  type WorkerProfile,
  type NewWorkerProfile,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";

@Injectable()
export class ProfilesRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Create a worker profile, idempotent per `ai_job_id` (TD14).
   *
   * The extraction processor creates the profile and THEN marks the ai_job
   * completed. If it dies in between (or a stalled job is redelivered), a naive
   * insert would orphan a second profile for the same job. With the unique
   * `ai_job_id`, the re-create hits `ON CONFLICT DO NOTHING` and we return the
   * already-stored profile instead — so a partial-success retry converges on one
   * row. Profiles with no `ai_job_id` (legacy/non-extraction) always insert,
   * since Postgres treats NULL keys as distinct.
   */
  async create(input: NewWorkerProfile): Promise<WorkerProfile> {
    const inserted = await this.db
      .insert(workerProfiles)
      .values(input)
      .onConflictDoNothing({ target: workerProfiles.aiJobId })
      .returning();
    const row = inserted[0];
    if (row) return row;

    // Conflict: a profile for this ai_job already exists (partial-success retry).
    // Return it so the caller proceeds idempotently with the canonical profile.
    if (input.aiJobId) {
      const existing = await this.findByAiJobId(input.aiJobId);
      if (existing) return existing;
    }
    throw new Error("Failed to create worker profile");
  }

  async findById(id: string): Promise<WorkerProfile | undefined> {
    const rows = await this.db
      .select()
      .from(workerProfiles)
      .where(eq(workerProfiles.id, id))
      .limit(1);
    return rows[0];
  }

  /** The profile produced by a given extraction job, if any (TD14 idempotency). */
  async findByAiJobId(aiJobId: string): Promise<WorkerProfile | undefined> {
    const rows = await this.db
      .select()
      .from(workerProfiles)
      .where(eq(workerProfiles.aiJobId, aiJobId))
      .limit(1);
    return rows[0];
  }

  async confirm(id: string, confirmedAt: Date): Promise<void> {
    await this.db
      .update(workerProfiles)
      .set({ profileStatus: "confirmed", confirmedAt, updatedAt: confirmedAt })
      .where(eq(workerProfiles.id, id));
  }
}
