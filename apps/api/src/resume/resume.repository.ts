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
    const inserted = await this.db.insert(generatedResumes).values(input).returning();
    const row = inserted[0];
    if (!row) throw new Error("Failed to create generated resume");
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
}
