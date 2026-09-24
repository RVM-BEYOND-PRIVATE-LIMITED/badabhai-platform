import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, max, or, sql } from "drizzle-orm";
import {
  type Database,
  aiJobs,
  chatSessions,
  generatedResumes,
  type GeneratedResume,
  type NewGeneratedResume,
  workerProfiles,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import { NEWEST_RESUME_FIRST } from "./resume-order";

/**
 * The durable facts about the worker's most recent ACCEPTED chat update ("Resume update kar
 * doon?" -> Haan), as `GET /resume/history` needs them. Facts only: which of `in_progress` /
 * `failed` they add up to is the service's decision, not this read's.
 */
export interface PendingChatUpdateFacts {
  readonly sessionId: string;
  /** When the worker said Haan. */
  readonly requestedAt: Date;
  /** The session's latest extraction job status, or null while none has been created yet. */
  readonly extractionStatus: string | null;
  /** The status of the profile that job produced, or null while it has produced none. */
  readonly profileStatus: string | null;
  /** A résumé has been generated for this worker at or after `requestedAt` — the update landed. */
  readonly landed: boolean;
}

/** The content half of a résumé row — what a regenerate rewrites. */
export type ResumeContent = Pick<
  NewGeneratedResume,
  "resumeJson" | "resumeText" | "sourceProfileSnapshot" | "templateId" | "generationSource"
>;

@Injectable()
export class ResumeRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async create(input: NewGeneratedResume): Promise<GeneratedResume> {
    const inserted = await this.db
      .insert(generatedResumes)
      // templateId is set by the caller and also has a DB default — no override here.
      .values(input)
      .returning();
    const row = inserted[0];
    if (!row) throw new Error("Failed to create generated resume");
    return row;
  }

  /**
   * Create the INITIAL (version 1) resume for a profile, race-safe via the partial
   * unique index `generated_resumes_initial_uq` (one v1 per profile). The
   * auto-generate (on profile.confirmed) and a manual POST /resume/generate can run
   * concurrently; this guarantees they converge on ONE row.
   *
   * - `overwrite: true` (manual generate, authoritative): refresh the content (e.g.
   *   a name recorded AFTER the auto-generate) on the existing v1, or insert it.
   * - `overwrite: false` (system auto-generate): insert only if absent — NEVER
   *   clobber a manual resume; on conflict, return the existing row.
   *
   * `input.version` MUST be 1.
   */
  async createInitial(
    input: NewGeneratedResume,
    opts: { overwrite: boolean },
  ): Promise<GeneratedResume> {
    if (opts.overwrite) {
      const rows = await this.db
        .insert(generatedResumes)
        .values(input)
        .onConflictDoUpdate({
          target: generatedResumes.profileId,
          targetWhere: sql`${generatedResumes.version} = 1`,
          set: {
            resumeJson: input.resumeJson,
            resumeText: input.resumeText,
            sourceProfileSnapshot: input.sourceProfileSnapshot,
            templateId: input.templateId,
            // ADR-0043: the label is re-resolved with the content (same profile, so the same
            // value in practice), and the row MOVES TO THE FRONT of the history: it is a new
            // generation of this entry, and `generated_at` is what "newest" is ordered by.
            // `generation_trigger` is deliberately NOT rewritten: a manual generate converging on
            // the auto-generate's row is the same entry, started by the same event.
            generationSource: input.generationSource ?? null,
            generatedAt: sql`now()`,
            renderStatus: "pending",
            pdfStorageKey: null,
            renderedAt: null,
          },
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error("Failed to upsert initial resume");
      return row;
    }

    const inserted = await this.db
      .insert(generatedResumes)
      .values(input)
      .onConflictDoNothing({
        target: generatedResumes.profileId,
        where: sql`${generatedResumes.version} = 1`,
      })
      .returning();
    if (inserted[0]) return inserted[0];

    // Conflict: the initial resume already exists (created concurrently) — return it.
    const existing = await this.db
      .select()
      .from(generatedResumes)
      .where(and(eq(generatedResumes.profileId, input.profileId), eq(generatedResumes.version, 1)))
      .limit(1);
    const row = existing[0];
    if (!row) throw new Error("Initial resume conflict but no existing row found");
    return row;
  }

  /**
   * The highest `version` any of this worker's résumés carries, or 0: what a new history entry
   * is numbered from.
   *
   * ITS OWN READ, not `latestResume().version`. Since ADR-0043 "latest" means NEWEST, and the
   * newest row can be a later profile's v1 while an older profile holds v3; numbering off the
   * newest would mint a second v2. `version` is a per-worker counter, never a history ordinal.
   */
  async maxVersion(workerId: string): Promise<number> {
    const rows = await this.db
      .select({ value: max(generatedResumes.version) })
      .from(generatedResumes)
      .where(eq(generatedResumes.workerId, workerId));
    return rows[0]?.value ?? 0;
  }

  /**
   * The DATABASE's clock. `generated_at` is always stamped by it (the column default, and `now()` on
   * every rewrite), so a moment compared against it has to come from the same clock — an app
   * server a few seconds off would otherwise misjudge which row was written during a call.
   */
  async now(): Promise<Date> {
    const rows = await this.db.execute(sql`select now() as now`);
    const value = (rows as unknown as { now: Date | string }[])[0]?.now;
    return value instanceof Date ? value : new Date(value ?? Date.now());
  }

  /** This profile's newest résumé, by the shared order, or undefined when it has none. */
  async newestForProfile(profileId: string): Promise<GeneratedResume | undefined> {
    const rows = await this.db
      .select()
      .from(generatedResumes)
      .where(eq(generatedResumes.profileId, profileId))
      .orderBy(...NEWEST_RESUME_FIRST)
      .limit(1);
    return rows[0];
  }

  /**
   * The worker's résumé history, newest first ({@link NEWEST_RESUME_FIRST}), at most `limit` rows.
   *
   * A DISPLAY WINDOW, never a retention rule (ruling R4, "keep all, show 3"): older rows stay on
   * file and stay downloadable by id; this read simply does not list them.
   */
  async listHistory(workerId: string, limit: number): Promise<GeneratedResume[]> {
    return this.db
      .select()
      .from(generatedResumes)
      .where(eq(generatedResumes.workerId, workerId))
      .orderBy(...NEWEST_RESUME_FIRST)
      .limit(limit);
  }

  /**
   * Rewrite ONE row in place when it is the SAME generation as the caller's: how a manual generate
   * converges instead of minting a duplicate history entry (ADR-0043).
   *
   * THE SAME GENERATION means either of two things, and both are in the predicate:
   *   - it is still `pending` — the worker has not seen it finish, so this is the same request
   *     arriving twice (a double-tap, a timeout retry);
   *   - it was generated AT OR AFTER `since`, the moment the caller's own generation started — it
   *     was written during the caller's model call, which is how a first-time worker's auto-generate
   *     and the app's own POST race on one confirm. Without this leg a render that finished inside
   *     that window made the worker's very first résumé two entries.
   *
   * The row is reset to `pending` with no PDF, so the render enqueued next draws the converged
   * content. THE PREDICATE IS IN THE UPDATE, not in the caller: a row that finished before the
   * caller started is a finished history entry and must not be rewritten, and a read-then-write
   * would race the render. Returns the row when it converged, or undefined — the caller then
   * records a new entry.
   */
  async convergeOnto(
    id: string,
    content: ResumeContent,
    since: Date,
  ): Promise<GeneratedResume | undefined> {
    const rows = await this.db
      .update(generatedResumes)
      .set({
        resumeJson: content.resumeJson,
        resumeText: content.resumeText,
        sourceProfileSnapshot: content.sourceProfileSnapshot,
        templateId: content.templateId,
        generationSource: content.generationSource ?? null,
        generatedAt: sql`now()`,
        renderStatus: "pending",
        pdfStorageKey: null,
        renderedAt: null,
      })
      .where(
        and(
          eq(generatedResumes.id, id),
          or(
            eq(generatedResumes.renderStatus, "pending"),
            gte(generatedResumes.generatedAt, since),
          ),
        ),
      )
      .returning();
    return rows[0];
  }

  /**
   * The facts behind `pending_update` on `GET /resume/history`: the worker's most recent chat
   * session in which they ACCEPTED "Resume update kar doon?", and how far the work it started
   * has got. Null when no session carries an accepted update.
   *
   * DATABASE-ONLY, and across four tables on purpose. The acceptance is recorded in
   * `chat_sessions.conversation_state` (a loose engine key beside `form_kind`), the extraction in
   * `ai_jobs`, the profile in `worker_profiles`, the landing in `generated_resumes`. Reading them
   * here rather than through the chat and profiles services keeps ResumeModule free of a
   * ChatModule edge.
   *
   * THE EXTRACTION READ matches `ai_jobs_extraction_session_idx` exactly: both jsonb keys, the
   * `job_type` predicate, and `created_at desc nulls last` spelled out for the pathkey match.
   */
  async pendingChatUpdate(workerId: string): Promise<PendingChatUpdateFacts | null> {
    const accepted = await this.db
      .select({
        sessionId: chatSessions.id,
        answeredAt: sql<
          string | null
        >`${chatSessions.conversationState}->'resume_update'->>'answered_at'`,
      })
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.workerId, workerId),
          sql`${chatSessions.conversationState}->'resume_update'->>'accepted' = 'true'`,
        ),
      )
      .orderBy(sql`${chatSessions.endedAt} desc nulls last`, desc(chatSessions.startedAt))
      .limit(1);
    const session = accepted[0];
    if (!session?.answeredAt) return null;
    const requestedAt = new Date(session.answeredAt);
    // A value this build did not write reads as "no update", never as a date in 1970.
    if (Number.isNaN(requestedAt.getTime())) return null;

    const jobs = await this.db
      .select({ status: aiJobs.status, outputRef: aiJobs.outputRef })
      .from(aiJobs)
      .where(
        and(
          eq(aiJobs.jobType, "profile_extraction"),
          sql`${aiJobs.inputRef}->>'session_id' = ${session.sessionId}`,
          sql`${aiJobs.inputRef}->>'worker_id' = ${workerId}`,
        ),
      )
      .orderBy(sql`${aiJobs.createdAt} desc nulls last`)
      .limit(1);
    const job = jobs[0];

    const profileId = (job?.outputRef as { profile_id?: unknown } | null)?.profile_id;
    let profileStatus: string | null = null;
    if (typeof profileId === "string") {
      const profiles = await this.db
        .select({ status: workerProfiles.profileStatus })
        .from(workerProfiles)
        .where(and(eq(workerProfiles.id, profileId), eq(workerProfiles.workerId, workerId)))
        .limit(1);
      profileStatus = profiles[0]?.status ?? null;
    }

    const newer = await this.db
      .select({ id: generatedResumes.id })
      .from(generatedResumes)
      .where(
        and(
          eq(generatedResumes.workerId, workerId),
          gte(generatedResumes.generatedAt, requestedAt),
        ),
      )
      .limit(1);

    return {
      sessionId: session.sessionId,
      requestedAt,
      extractionStatus: job?.status ?? null,
      profileStatus,
      landed: newer.length > 0,
    };
  }

  /** Read a single generated resume by id (for the ops read view). */
  async findById(id: string): Promise<GeneratedResume | undefined> {
    const rows = await this.db
      .select()
      .from(generatedResumes)
      .where(eq(generatedResumes.id, id))
      .limit(1);
    return rows[0];
  }

  /** Flip a row to 'rendered' with its PDF object key + render timestamp. */
  /**
   * Flip a row to 'rendered', and store the document the PDF was drawn from.
   *
   * ONE WRITE, NOT TWO. The document and the PDF describe the same render; storing them
   * separately would let a row exist that says 'rendered' while carrying the previous
   * render's document, which is precisely the disagreement the column exists to prevent.
   *
   * `resumeDocument` is optional so the existing call sites and tests compile unchanged; a
   * caller that omits it leaves whatever was there, which is null on a first render.
   */
  async markRendered(id: string, pdfStorageKey: string, resumeDocument?: unknown): Promise<void> {
    await this.db
      .update(generatedResumes)
      .set({
        renderStatus: "rendered",
        pdfStorageKey,
        renderedAt: new Date(),
        ...(resumeDocument === undefined ? {} : { resumeDocument }),
      })
      .where(eq(generatedResumes.id, id));
  }

  /** Flip a row to 'failed' (terminal render failure). */
  async markRenderFailed(id: string): Promise<void> {
    await this.db
      .update(generatedResumes)
      .set({ renderStatus: "failed" })
      .where(eq(generatedResumes.id, id));
  }

  /**
   * Flip a row to 'failed' ONLY IF IT IS STILL 'pending' — for a caller that knows the render
   * was never scheduled, but does not know the row is still waiting for one.
   *
   * WHY THE PREDICATE IS IN THE UPDATE AND NOT IN THE CALLER (#1399). The sibling above is
   * unconditional, which is correct where it is used: the processor has already read the row and
   * decided, and its `wasRendered` guards are what stop a good PDF being downgraded.
   * `ResumeService.enqueueRender` has no such read — it holds an id whose row may be a
   * freshly-inserted 'pending' one OR, on the system auto-generate path, a PRE-EXISTING row that
   * `createInitial({overwrite:false})` returned from its conflict branch and that may already be
   * 'rendered' with a live PDF. Marking that failed would 409 a resume the worker could download
   * a second ago, with no job left to repair it — exactly the TD77 degrade-open rule the
   * processor protects, broken from the one path that skips the processor entirely.
   *
   * A read-then-write in the service would be a race (the render can land between the two) and
   * would put a business predicate in the wrong layer. One guarded statement is atomic and
   * idempotent: replaying it cannot move a row that has since rendered.
   */
  async markRenderFailedIfPending(id: string): Promise<void> {
    await this.db
      .update(generatedResumes)
      .set({ renderStatus: "failed" })
      .where(and(eq(generatedResumes.id, id), eq(generatedResumes.renderStatus, "pending")));
  }
}
