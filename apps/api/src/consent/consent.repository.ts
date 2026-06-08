import { Inject, Injectable } from "@nestjs/common";
import { type Database, workerConsents, type WorkerConsent, type NewWorkerConsent } from "@badabhai/db";
import { DATABASE } from "../database/database.module";

@Injectable()
export class ConsentRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async create(input: NewWorkerConsent): Promise<WorkerConsent> {
    const inserted = await this.db.insert(workerConsents).values(input).returning();
    const row = inserted[0];
    if (!row) throw new Error("Failed to create consent record");
    return row;
  }
}
