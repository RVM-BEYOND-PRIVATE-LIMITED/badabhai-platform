import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { type Database, aiJobs, type AiJob, type NewAiJob } from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/**
 * Operational AI usage/cost metadata persisted on an `ai_jobs` row when a job
 * completes. PII-free by construction — only these typed scalars (never prompts,
 * completions, transcripts, names, or phone numbers).
 */
export interface AiJobUsageMetadata {
  modelName: string | null;
  realCall: boolean | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costInr: number | null;
}

@Injectable()
export class AiJobsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Most-recent AI jobs first, for the read-only ops console. */
  async list(limit = 100): Promise<AiJob[]> {
    return this.db.select().from(aiJobs).orderBy(desc(aiJobs.createdAt)).limit(limit);
  }

  async findById(id: string): Promise<AiJob | undefined> {
    const rows = await this.db.select().from(aiJobs).where(eq(aiJobs.id, id)).limit(1);
    return rows[0];
  }

  /**
   * Newest `profile_extraction` job for a chat session that is still in flight
   * (`queued`/`running`) or already succeeded (`completed`) — i.e. a job whose
   * existence makes a second extraction for the same session pure duplicate AI
   * spend (issue #420).
   *
   * `failed` is deliberately EXCLUDED so a session whose extraction failed can
   * still be retried; the guard must never permanently wedge a session.
   *
   * The predicate reads `input_ref->>'session_id'`, matching the shape written
   * by `ProfilesService.extract` (`{ worker_id, session_id }`). `session_id` is
   * an opaque UUID — no PII crosses this boundary (CLAUDE.md §2 invariant 2).
   */
  async findActiveExtractionForSession(sessionId: string): Promise<AiJob | undefined> {
    const rows = await this.db
      .select()
      .from(aiJobs)
      .where(
        and(
          eq(aiJobs.jobType, "profile_extraction"),
          inArray(aiJobs.status, ["queued", "running", "completed"]),
          sql`${aiJobs.inputRef}->>'session_id' = ${sessionId}`,
        ),
      )
      .orderBy(desc(aiJobs.createdAt))
      .limit(1);
    return rows[0];
  }

  async create(input: NewAiJob): Promise<AiJob> {
    const inserted = await this.db.insert(aiJobs).values(input).returning();
    const row = inserted[0];
    if (!row) throw new Error("Failed to create AI job");
    return row;
  }

  async markRunning(id: string): Promise<void> {
    await this.db
      .update(aiJobs)
      .set({ status: "running", updatedAt: new Date() })
      .where(eq(aiJobs.id, id));
  }

  async markCompleted(
    id: string,
    outputRef: Record<string, unknown>,
    usage?: AiJobUsageMetadata,
  ): Promise<void> {
    await this.db
      .update(aiJobs)
      .set({ status: "completed", outputRef, ...(usage ?? {}), updatedAt: new Date() })
      .where(eq(aiJobs.id, id));
  }

  async markFailed(id: string, errorMessage: string): Promise<void> {
    await this.db
      .update(aiJobs)
      .set({ status: "failed", errorMessage, updatedAt: new Date() })
      .where(eq(aiJobs.id, id));
  }
}
