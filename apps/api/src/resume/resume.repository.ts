import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import {
  type Database,
  generatedResumes,
  type GeneratedResume,
  type NewGeneratedResume,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";

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
