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

  async create(input: NewWorkerProfile): Promise<WorkerProfile> {
    const inserted = await this.db.insert(workerProfiles).values(input).returning();
    const row = inserted[0];
    if (!row) throw new Error("Failed to create worker profile");
    return row;
  }

  async findById(id: string): Promise<WorkerProfile | undefined> {
    const rows = await this.db
      .select()
      .from(workerProfiles)
      .where(eq(workerProfiles.id, id))
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
