import { Inject, Injectable } from "@nestjs/common";
import { desc, eq, inArray } from "drizzle-orm";
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

/** Ops-console list row. PII (phone/full name) is intentionally excluded. */
export interface WorkerListItem {
  id: string;
  status: Worker["status"];
  preferred_language: Worker["preferredLanguage"];
  created_at: Date;
  profile_status: WorkerProfile["profileStatus"] | null;
  canonical_role_id: string | null;
  canonical_trade_id: string | null;
}

@Injectable()
export class WorkersRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * List workers (newest first) with their latest profile summary, for the ops
   * console. Two queries (workers, then their profiles) — no PII is returned.
   */
  async list(limit = 100): Promise<WorkerListItem[]> {
    const workerRows = await this.db
      .select()
      .from(workers)
      .orderBy(desc(workers.createdAt))
      .limit(limit);
    if (workerRows.length === 0) return [];

    const ids = workerRows.map((w) => w.id);
    const profileRows = await this.db
      .select()
      .from(workerProfiles)
      .where(inArray(workerProfiles.workerId, ids))
      .orderBy(desc(workerProfiles.createdAt));

    // First row per worker is the latest (rows are ordered created_at desc).
    const latestByWorker = new Map<string, WorkerProfile>();
    for (const p of profileRows) {
      if (!latestByWorker.has(p.workerId)) latestByWorker.set(p.workerId, p);
    }

    return workerRows.map((w) => {
      const p = latestByWorker.get(w.id);
      return {
        id: w.id,
        status: w.status,
        preferred_language: w.preferredLanguage,
        created_at: w.createdAt,
        profile_status: p?.profileStatus ?? null,
        canonical_role_id: p?.canonicalRoleId ?? null,
        canonical_trade_id: p?.canonicalTradeId ?? null,
      };
    });
  }

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
