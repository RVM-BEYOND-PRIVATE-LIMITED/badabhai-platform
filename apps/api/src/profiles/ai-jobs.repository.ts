import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { type Database, aiJobs, workerProfiles, type AiJob, type NewAiJob } from "@badabhai/db";
import type { AiJobStatus } from "@badabhai/types";
import { DATABASE } from "../database/database.module";
import type { ProfileContentFields } from "./profile-content";

/**
 * A prior `profile_extraction` job for a session that MIGHT make a fresh
 * extraction redundant. Whether it actually does is decided by the caller —
 * for a `completed` job that depends on whether it produced a usable profile
 * (`hasExtractedContent`), which is domain logic, not data access.
 */
export interface ExtractionDedupeCandidate {
  id: string;
  status: AiJobStatus;
  /** The profile this job produced (`worker_profiles.ai_job_id`), if any. */
  profile: ProfileContentFields | null;
}

/** Non-terminal statuses: work that is supposedly still in flight. */
const IN_FLIGHT_STATUSES = ["queued", "running"] as const;

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
   * Newest `profile_extraction` job for a session that could make a fresh
   * extraction redundant (issue #420), together with the profile it produced.
   *
   * Matches when the job is EITHER:
   *   - `queued`/`running` AND newer than `inFlightSince` — genuinely in flight; or
   *   - `completed` — succeeded, but the CALLER must still check the joined
   *     profile has content before deduping against it.
   *
   * Deliberate exclusions:
   *   - `failed` never matches → a failed extraction stays retryable.
   *   - stale `queued`/`running` never matches. There is no reaper for stuck
   *     ai_jobs, and `ProfilesService.extract` INSERTs `queued` BEFORE enqueueing:
   *     a crash in that window leaves a row that is never enqueued, so no BullMQ
   *     retry and no processor to fail it. Without the age bound such a zombie
   *     would be returned forever and the client would poll it to timeout on
   *     every attempt.
   *
   * SCOPING: `worker_id` is part of the predicate, not just `session_id`. The
   * controller takes `session_id` from the request body with no ownership check,
   * so without this another worker's job could permanently deduplicate — and thus
   * deny — the owner's own extraction. (The pre-existing transcript-read half of
   * that gap is untouched here; this only stops the denial from persisting.)
   *
   * Both predicates read opaque UUIDs out of `input_ref` — no PII crosses this
   * boundary (CLAUDE.md §2 invariant 2).
   */
  async findExtractionDedupeCandidate(args: {
    sessionId: string;
    workerId: string;
    inFlightSince: Date;
  }): Promise<ExtractionDedupeCandidate | undefined> {
    const rows = await this.db
      .select({
        id: aiJobs.id,
        status: aiJobs.status,
        canonicalTradeId: workerProfiles.canonicalTradeId,
        canonicalRoleId: workerProfiles.canonicalRoleId,
        skills: workerProfiles.skills,
        machines: workerProfiles.machines,
        experience: workerProfiles.experience,
        salaryExpectation: workerProfiles.salaryExpectation,
        locationPreference: workerProfiles.locationPreference,
        availability: workerProfiles.availability,
        richProfileDraft: workerProfiles.richProfileDraft,
        profileId: workerProfiles.id,
      })
      .from(aiJobs)
      .leftJoin(workerProfiles, eq(workerProfiles.aiJobId, aiJobs.id))
      .where(
        and(
          eq(aiJobs.jobType, "profile_extraction"),
          sql`${aiJobs.inputRef}->>'session_id' = ${args.sessionId}`,
          sql`${aiJobs.inputRef}->>'worker_id' = ${args.workerId}`,
          or(
            and(
              inArray(aiJobs.status, [...IN_FLIGHT_STATUSES]),
              gt(aiJobs.createdAt, args.inFlightSince),
            ),
            eq(aiJobs.status, "completed"),
          ),
        ),
      )
      .orderBy(desc(aiJobs.createdAt))
      .limit(1);

    const row = rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      status: row.status,
      profile:
        row.profileId == null
          ? null
          : {
              canonicalTradeId: row.canonicalTradeId,
              canonicalRoleId: row.canonicalRoleId,
              skills: row.skills,
              machines: row.machines,
              experience: row.experience,
              salaryExpectation: row.salaryExpectation,
              locationPreference: row.locationPreference,
              availability: row.availability,
              richProfileDraft: row.richProfileDraft,
            },
    };
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
