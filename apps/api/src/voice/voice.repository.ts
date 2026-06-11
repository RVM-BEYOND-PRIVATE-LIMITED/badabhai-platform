import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { type Database, voiceNotes, type VoiceNote, type NewVoiceNote } from "@badabhai/db";
import { DATABASE } from "../database/database.module";

@Injectable()
export class VoiceRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async create(input: NewVoiceNote): Promise<VoiceNote> {
    const inserted = await this.db.insert(voiceNotes).values(input).returning();
    const row = inserted[0];
    if (!row) throw new Error("Failed to create voice note");
    return row;
  }

  async findById(id: string): Promise<VoiceNote | undefined> {
    const rows = await this.db.select().from(voiceNotes).where(eq(voiceNotes.id, id)).limit(1);
    return rows[0];
  }

  /** Persist a transcription result. `transcriptText` is raw worker free-text;
   * it lives only on this row, never in events/ai_jobs/logs. */
  async setTranscript(
    id: string,
    transcriptText: string,
    confidence: number | null,
  ): Promise<void> {
    await this.db
      .update(voiceNotes)
      .set({ transcriptText, transcriptConfidence: confidence })
      .where(eq(voiceNotes.id, id));
  }
}
