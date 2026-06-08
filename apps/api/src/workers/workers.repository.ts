import { Inject, Injectable } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import {
  type Database,
  workers,
  workerProfiles,
  generatedResumes,
  type Worker,
  type NewWorker,
  type WorkerProfile,
  type GeneratedResume,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";

@Injectable()
export class WorkersRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async findById(id: string): Promise<Worker | undefined> {
    const rows = await this.db.select().from(workers).where(eq(workers.id, id)).limit(1);
    return rows[0];
  }

  async findByPhoneHash(phoneHash: string): Promise<Worker | undefined> {
    const rows = await this.db
      .select()
      .from(workers)
      .where(eq(workers.phoneHash, phoneHash))
      .limit(1);
    return rows[0];
  }

  async create(input: NewWorker): Promise<Worker> {
    const inserted = await this.db.insert(workers).values(input).returning();
    const row = inserted[0];
    if (!row) throw new Error("Failed to create worker");
    return row;
  }

  async latestProfile(workerId: string): Promise<WorkerProfile | undefined> {
    const rows = await this.db
      .select()
      .from(workerProfiles)
      .where(eq(workerProfiles.workerId, workerId))
      .orderBy(desc(workerProfiles.createdAt))
      .limit(1);
    return rows[0];
  }

  async latestResume(workerId: string): Promise<GeneratedResume | undefined> {
    const rows = await this.db
      .select()
      .from(generatedResumes)
      .where(eq(generatedResumes.workerId, workerId))
      .orderBy(desc(generatedResumes.generatedAt))
      .limit(1);
    return rows[0];
  }
}
