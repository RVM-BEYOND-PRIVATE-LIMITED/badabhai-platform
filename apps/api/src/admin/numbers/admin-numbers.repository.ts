import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gt, isNotNull } from "drizzle-orm";
import { payers, type Database } from "@badabhai/db";
import { DATABASE } from "../../database/database.module";

/** What a mark or an unmark did to the company row. */
export type TestAccountWrite = "changed" | "unchanged" | "not_found";

/** One company the synthetic-sign-in backfill reads: the id and the sign-in email's ciphertext. */
export interface UnmarkedPayerWithEmail {
  readonly id: string;
  readonly emailEnc: string;
}

/**
 * #2755 — data access for the numbers screen's WRITES. Today that is one column:
 * `payers.is_test_account` (migration 0162, #2746), the company test marker. Nothing else on
 * `payers` is read or written here — never a name, a contact, a credential or the status.
 *
 * The aggregate READS of the weekly figures arrive with part B in their own repository; this one
 * stays the mark's.
 */
@Injectable()
export class AdminNumbersRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** One transaction for the row and its events. */
  withTransaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(work as (tx: unknown) => Promise<T>);
  }

  /**
   * Set or clear the company test marker. GUARDED ON THE CURRENT VALUE in the WHERE, so a re-mark
   * (or a second unmark) changes no row and the caller emits nothing, and two racing requests
   * cannot both report a change. `updated_at` moves only on a real change.
   *
   * `unchanged` and `not_found` are told apart by one primary-key read, on the same transaction.
   */
  async setTestAccount(tx: Database, payerId: string, on: boolean): Promise<TestAccountWrite> {
    const moved = await tx
      .update(payers)
      .set({ isTestAccount: on, updatedAt: new Date() })
      .where(and(eq(payers.id, payerId), eq(payers.isTestAccount, !on)))
      .returning({ id: payers.id });
    if (moved.length > 0) return "changed";
    const exists = await tx
      .select({ id: payers.id })
      .from(payers)
      .where(eq(payers.id, payerId))
      .limit(1);
    return exists.length > 0 ? "unchanged" : "not_found";
  }

  /**
   * One keyset page of the companies the synthetic-sign-in backfill must inspect: NOT yet marked,
   * with a sign-in email on the row, in id order after `afterId`. Projects the id and the email
   * CIPHERTEXT only; the backfill decrypts in process and never prints it.
   */
  async listUnmarkedPayersWithEmail(
    afterId: string | null,
    limit: number,
  ): Promise<UnmarkedPayerWithEmail[]> {
    const rows = await this.db
      .select({ id: payers.id, emailEnc: payers.emailEnc })
      .from(payers)
      .where(
        and(
          eq(payers.isTestAccount, false),
          isNotNull(payers.emailEnc),
          afterId === null ? undefined : gt(payers.id, afterId),
        ),
      )
      .orderBy(asc(payers.id))
      .limit(limit);
    return rows.flatMap((r) => (r.emailEnc === null ? [] : [{ id: r.id, emailEnc: r.emailEnc }]));
  }
}
