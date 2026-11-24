import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { tradeRelease, type Database, type TradeReleaseRow } from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/**
 * #3002 — data access for the per-trade release switch (`trade_release`, migration 0198).
 *
 * One row per RELEASED trade; a kind with no row reads as off. Rows are never deleted:
 * switching off is an UPDATE. `updated_by` is the `admin_users.id` that made the change
 * (null for the migration seed).
 */
@Injectable()
export class TradeReleaseRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  withTransaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(work as (tx: unknown) => Promise<T>);
  }

  /** Every release row, keyed by role kind. */
  async all(executor: Database = this.db): Promise<TradeReleaseRow[]> {
    return executor.select().from(tradeRelease);
  }

  /** One trade's row, or null when the trade was never released. */
  async find(executor: Database, roleKind: string): Promise<TradeReleaseRow | null> {
    const rows = await executor
      .select()
      .from(tradeRelease)
      .where(eq(tradeRelease.roleKind, roleKind));
    return rows[0] ?? null;
  }

  /** Insert or replace one trade's flags. Returns the row after the write. */
  async upsert(
    tx: Database,
    input: { roleKind: string; postingEnabled: boolean; formEnabled: boolean; updatedBy: string },
  ): Promise<TradeReleaseRow> {
    const rows = await tx
      .insert(tradeRelease)
      .values({
        roleKind: input.roleKind,
        postingEnabled: input.postingEnabled,
        formEnabled: input.formEnabled,
        updatedBy: input.updatedBy,
      })
      .onConflictDoUpdate({
        target: tradeRelease.roleKind,
        set: {
          postingEnabled: input.postingEnabled,
          formEnabled: input.formEnabled,
          updatedBy: input.updatedBy,
          updatedAt: new Date(),
        },
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("trade_release: the upsert wrote no row");
    return row;
  }
}
