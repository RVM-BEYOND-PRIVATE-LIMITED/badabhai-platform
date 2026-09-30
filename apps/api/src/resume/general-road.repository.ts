import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import {
  aiJobs,
  chatSessions,
  generatedResumes,
  workerProfiles,
  type Database,
} from "@badabhai/db";

import { DATABASE } from "../database/database.module";

/**
 * The two reads behind `GeneralRoadReader` (ADR-0045 Phase 5) — the résumé's own PROVENANCE, walked
 * link by link. Database access only: which question to ask, and what the answer means, is the
 * reader's.
 *
 * THE WALK, and every link is a column that exists (verified against `packages/db`, not assumed):
 *
 *   generated_resumes.profile_id   → worker_profiles.id         (FK, NOT NULL)
 *   worker_profiles.ai_job_id      → ai_jobs.id                 (logical ref; unique per job, TD14)
 *   ai_jobs.input_ref->>'session_id' → chat_sessions.id         (the RESOLVED session the extraction
 *                                                                 processor read — `ProfilesService`
 *                                                                 writes it, never the request body's)
 *
 * EVERY READ IS SCOPED TO THE RÉSUMÉ'S WORKER, on every table it touches — the résumé row, the
 * profile, the job's own `input_ref->>'worker_id'` and the session — which is defence in depth
 * rather than the access check: the caller already holds a résumé of this worker's. A foreign
 * profile, job or session can never answer for this résumé.
 *
 * TWO QUERIES, NOT ONE JOIN, and on purpose. `input_ref->>'session_id'` is TEXT inside a jsonb
 * column; joining it to `chat_sessions.id` needs either a `::uuid` cast (which throws on a
 * malformed value in any row the planner happens to touch) or `id::text` (which cannot use the
 * primary key). Reading the id first and validating it in code keeps both reads primary-key
 * lookups — `generated_resumes`, `worker_profiles`, `ai_jobs` and `chat_sessions` are each hit by
 * their own id — and never lets a hand-written job row fail a render.
 *
 * PII: ids in, ids and one jsonb stamp (a role label, a domain label, certified skill labels and
 * two flags — no name, no phone, no employer) out. Nothing here is logged.
 */
@Injectable()
export class GeneralRoadRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * The session id the résumé's profile was EXTRACTED from — `ai_jobs.input_ref->>'session_id'` of
   * the profile's own extraction job — or null: no such résumé for this worker, a profile with no
   * job (legacy rows), or a job with no session (the session-less voice-form path).
   */
  async findResumeExtractionSessionId(resumeId: string, workerId: string): Promise<string | null> {
    const rows = await this.db
      .select({ sessionId: sql<string | null>`${aiJobs.inputRef}->>'session_id'` })
      .from(generatedResumes)
      .innerJoin(workerProfiles, eq(workerProfiles.id, generatedResumes.profileId))
      .innerJoin(aiJobs, eq(aiJobs.id, workerProfiles.aiJobId))
      .where(
        and(
          eq(generatedResumes.id, resumeId),
          eq(generatedResumes.workerId, workerId),
          eq(workerProfiles.workerId, workerId),
          eq(aiJobs.jobType, "profile_extraction"),
          sql`${aiJobs.inputRef}->>'worker_id' = ${workerId}`,
        ),
      )
      .limit(1);
    return rows[0]?.sessionId ?? null;
  }

  /**
   * The session's `conversation_state->'general_road'` stamp, RAW (the caller narrows it with the
   * one strict reader), or `undefined` when the worker has no such session. Only the stamp is
   * selected: the rest of the state carries the answer map — worker text this read has no use for.
   */
  async findSessionGeneralRoad(
    sessionId: string,
    workerId: string,
  ): Promise<{ readonly generalRoad: unknown } | undefined> {
    const rows = await this.db
      .select({ generalRoad: sql<unknown>`${chatSessions.conversationState}->'general_road'` })
      .from(chatSessions)
      .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.workerId, workerId)))
      .limit(1);
    return rows[0];
  }
}
