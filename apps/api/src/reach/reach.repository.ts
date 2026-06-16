import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { type Database, workerProfiles } from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import type { WorkerProfileSignalRow } from "./reach.mappers";

/**
 * Read-only Drizzle access to `worker_profiles` for the reach serving layer
 * (ADR-0011 §1, D8).
 *
 * PROJECTION DISCIPLINE (D8): this repository selects ONLY the signal columns the
 * mapper needs — the opaque `worker_id`, canonical role/trade, the
 * experience/salary/location/availability JSONB, and `updated_at`. It NEVER selects
 * `embedding` or `raw_profile` (or any PII/raw-profile column). The Phase-2
 * read-model must keep the identical projection.
 *
 * SORT-NEVER-BLOCK (D8): there is NO relevance `WHERE`. `listSignalRows()` reads the
 * full pool, full stop — so `count in == count out` is structural, not policed.
 */
@Injectable()
export class ReachRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Exactly the signal columns the mapper reads — never embedding/rawProfile. */
  private static readonly SIGNAL_COLUMNS = {
    workerId: workerProfiles.workerId,
    canonicalRoleId: workerProfiles.canonicalRoleId,
    canonicalTradeId: workerProfiles.canonicalTradeId,
    experience: workerProfiles.experience,
    salaryExpectation: workerProfiles.salaryExpectation,
    locationPreference: workerProfiles.locationPreference,
    availability: workerProfiles.availability,
    updatedAt: workerProfiles.updatedAt,
  } as const;

  /**
   * The FULL worker pool, signal columns only, NO relevance filter (View A).
   * Ordering is a stable display order only; it never changes membership.
   */
  async listSignalRows(): Promise<WorkerProfileSignalRow[]> {
    const rows = await this.db
      .select(ReachRepository.SIGNAL_COLUMNS)
      .from(workerProfiles);
    return rows;
  }

  /** One worker's signal row (View B), or `undefined` if it has no profile. */
  async findSignalRowByWorkerId(workerId: string): Promise<WorkerProfileSignalRow | undefined> {
    const rows = await this.db
      .select(ReachRepository.SIGNAL_COLUMNS)
      .from(workerProfiles)
      .where(eq(workerProfiles.workerId, workerId))
      .limit(1);
    return rows[0];
  }
}
