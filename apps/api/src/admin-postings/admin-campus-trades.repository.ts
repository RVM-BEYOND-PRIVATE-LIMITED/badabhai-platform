import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Database } from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/** One `campus_trades` row. */
export interface CampusTradeRow {
  tradeKey: string;
  addedByAdminId: string;
  addedAt: Date;
  removedAt: Date | null;
}

/**
 * #2957 — data access for the Campus trade list (`campus_trades`, migration 0190). A removal stamps
 * `removed_*` (a row is never deleted); re-adding a removed trade clears the stamp and records who
 * added it back.
 */
@Injectable()
export class AdminCampusTradesRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  withTransaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(work as (tx: unknown) => Promise<T>);
  }

  /** Every row, active and removed. `lock` takes them `FOR UPDATE` (a replace's first statement). */
  async all(executor: Database = this.db, lock = false): Promise<CampusTradeRow[]> {
    const rows = (await executor.execute(sql`
      SELECT trade_key, added_by_admin_id, added_at, removed_at FROM campus_trades
      ORDER BY trade_key ${lock ? sql`FOR UPDATE` : sql``}
    `)) as unknown as Record<string, unknown>[];
    const date = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));
    return rows.map((r) => ({
      tradeKey: String(r.trade_key),
      addedByAdminId: String(r.added_by_admin_id),
      addedAt: date(r.added_at),
      removedAt: r.removed_at === null || r.removed_at === undefined ? null : date(r.removed_at),
    }));
  }

  /** Add (or re-add) one trade. */
  async add(tx: Database, tradeKey: string, adminId: string): Promise<void> {
    await tx.execute(sql`
      INSERT INTO campus_trades (trade_key, added_by_admin_id, added_at, updated_at)
      VALUES (${tradeKey}, ${adminId}::uuid, now(), now())
      ON CONFLICT (trade_key) DO UPDATE
      SET added_by_admin_id = EXCLUDED.added_by_admin_id, added_at = now(),
          removed_by_admin_id = NULL, removed_at = NULL, updated_at = now()
    `);
  }

  /** Stamp one active trade removed. */
  async remove(tx: Database, tradeKey: string, adminId: string): Promise<void> {
    await tx.execute(sql`
      UPDATE campus_trades
      SET removed_by_admin_id = ${adminId}::uuid, removed_at = now(), updated_at = now()
      WHERE trade_key = ${tradeKey} AND removed_at IS NULL
    `);
  }
}
