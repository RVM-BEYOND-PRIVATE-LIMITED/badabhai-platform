import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
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
   * Refresh an existing resume's content IN PLACE (same id + version). Used by the
   * idempotent initial-resume path: the auto-generate (on profile.confirmed) and a
   * manual POST /resume/generate converge on one row even though the name may be
   * recorded after confirm. Content changed → reset render to 'pending' and clear
   * the stale PDF so the render worker re-runs.
   */
  async updateContent(
    id: string,
    input: Pick<
      NewGeneratedResume,
      "resumeJson" | "resumeText" | "sourceProfileSnapshot" | "templateId"
    >,
  ): Promise<GeneratedResume> {
    const rows = await this.db
      .update(generatedResumes)
      .set({
        resumeJson: input.resumeJson,
        resumeText: input.resumeText,
        sourceProfileSnapshot: input.sourceProfileSnapshot,
        templateId: input.templateId,
        renderStatus: "pending",
        pdfStorageKey: null,
        renderedAt: null,
      })
      .where(eq(generatedResumes.id, id))
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to update generated resume");
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
  async markRendered(id: string, pdfStorageKey: string): Promise<void> {
    await this.db
      .update(generatedResumes)
      .set({ renderStatus: "rendered", pdfStorageKey, renderedAt: new Date() })
      .where(eq(generatedResumes.id, id));
  }

  /** Flip a row to 'failed' (terminal render failure). */
  async markRenderFailed(id: string): Promise<void> {
    await this.db
      .update(generatedResumes)
      .set({ renderStatus: "failed" })
      .where(eq(generatedResumes.id, id));
  }
}
