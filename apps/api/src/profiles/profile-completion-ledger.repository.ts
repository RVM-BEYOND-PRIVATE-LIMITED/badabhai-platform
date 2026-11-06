import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  type Database,
  events,
  profileCompletionLedger,
  workers,
  type NewProfileCompletionLedgerRow,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/**
 * The completed-profile ledger's writer (B2 #2555) — one row per finished profile,
 * written in the SAME transaction as the `profile.extraction_completed` event it
 * mirrors.
 *
 * THE SAME-TX RULE IS THE WHOLE POINT. A ledger row without its event is an
 * unattributable row (no spine proof the completion happened); an event without its
 * ledger row is a completion the denominator cannot see. Committing them together
 * makes "the ledger and the spine disagree" unrepresentable — and `ON CONFLICT
 * (profile_id) DO NOTHING` makes a BullMQ redelivery converge instead of doubling.
 *
 * NO POLICY HERE (CLAUDE.md §4). This decides nothing about WHEN a completion counts;
 * the caller (`ProfileExtractionProcessor`) owns the extracted/confirmed predicate.
 * What this owns is the mechanics: the flag resolution, the insert, and the
 * transaction seam.
 */
@Injectable()
export class ProfileCompletionLedgerRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Open a transaction for a caller that has none. Mirrors
   * `AiCostTotalsRepository.withTransaction` — the cast is drizzle's
   * transaction-callback parameter type, structurally a `Database`.
   */
  async withTransaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(work as (tx: unknown) => Promise<T>);
  }

  /**
   * The test flag AS OF COMPLETION — stamped into the ledger row, so a later erasure
   * cannot move it.
   *
   * The live `workers` row first (it exists — the profile was JUST saved with an FK
   * to it). When it does not — a worker deleted in the millisecond between the save
   * and this read — the `worker.test_login` spine decides: that event is emitted only
   * by the synthetic-range test mint, so a deleted worker WITH one is test and one
   * WITHOUT is real. No decryption, no phone pattern, no PII read of any kind.
   *
   * THROWS ONLY when the database itself fails, in which case the enclosing
   * transaction is already aborted and the caller retries — the insert is idempotent,
   * so convergence is safe.
   */
  async resolveTestFlag(workerId: string, tx: Database): Promise<boolean> {
    const rows = await tx
      .select({ isTestAccount: workers.isTestAccount })
      .from(workers)
      .where(eq(workers.id, workerId))
      .limit(1);
    const live = rows[0]?.isTestAccount;
    if (live !== undefined) return live;
    const seen = await tx
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.subjectType, "worker"),
          eq(events.subjectId, workerId),
          eq(events.eventName, "worker.test_login"),
        ),
      )
      .limit(1);
    return seen.length > 0;
  }

  /**
   * Insert one ledger row. `ON CONFLICT (profile_id) DO NOTHING` — the live path and
   * the backfill write the same key, and a redelivered job replays the same values,
   * so every duplicate converges to the first write rather than doubling it.
   */
  async insert(row: NewProfileCompletionLedgerRow, tx: Database): Promise<void> {
    await tx.insert(profileCompletionLedger).values(row).onConflictDoNothing({
      target: profileCompletionLedger.profileId,
    });
  }
}
