import { Inject, Injectable } from "@nestjs/common";
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
}
