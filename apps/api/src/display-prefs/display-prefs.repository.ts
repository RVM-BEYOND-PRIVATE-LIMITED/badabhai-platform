import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { adminUsers, displayPrefs, payers, workers, type Database } from "@badabhai/db";
import type { DisplayPrefsSubjectKind, DisplayTheme } from "@badabhai/types";

import { DATABASE } from "../database/database.module";

/**
 * `display_prefs` (migration 0165, #2819) — DATABASE ACCESS ONLY. Whether the theme switch is open,
 * whether a choice is a real change and what it emits are `DisplayPrefsService`'s.
 *
 * NOTHING HERE MAY RUN WHILE `THEME_ROLLOUT` IS CLOSED FOR THE LOGIN. 0165 is apply-before-pilot:
 * the service asks the switch first, which is what lets a build reach a database without the table
 * and fail no request. With the table missing, every method here throws 42P01 (on `err.cause`,
 * drizzle 0.45), and the service answers closed.
 *
 * Every method is keyed on the full primary key `(subject_kind, subject_id)`, and the id is always
 * the one the realm's auth guard attached: there is no method that reads or writes by anything
 * else, so no caller can reach another login's row.
 *
 * Returns the stored theme as a raw STRING, deliberately not narrowed: `display_prefs_theme_chk`
 * keeps the column inside `DISPLAY_THEMES`, but what an unrecognised value means is the service's.
 *
 * SPINE READ-ONLY: this repository never touches `events`. `display_prefs.changed` is emitted
 * through `EventsService.emit` on the transaction {@link withTransaction} opens, so the row and its
 * event commit together or not at all.
 */
@Injectable()
export class DisplayPrefsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Run `cb` inside one Drizzle transaction; the `tx` it gets is a `Database`-shaped executor. */
  withTransaction<T>(cb: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(cb as (tx: unknown) => Promise<T>);
  }

  /**
   * #2837 — holds the LOGIN'S OWN ROW (`workers`, `payers` or `admin_users`) with `FOR KEY SHARE`
   * until `tx` ends, and says whether it still exists. Call it on the write's transaction, first.
   *
   * WHY. The guard read the row before the request reached here, but an erasure can delete it
   * between that read and this write, and `display_prefs` has no FK to stop a row landing after.
   * This lock is the FK check the table cannot have: an erasure that already deleted the row makes
   * this wait for its commit and then find nothing (false); an erasure that comes later waits for
   * this transaction, then deletes the row this write committed (`eraseLoginKeyedRows`).
   *
   * `FOR KEY SHARE` is the lock a real FK check takes: it blocks only a delete (or a key change) of
   * the login's row, never an ordinary update of it.
   */
  async lockSubject(
    kind: DisplayPrefsSubjectKind,
    subjectId: string,
    tx: Database,
  ): Promise<boolean> {
    let rows: unknown[];
    switch (kind) {
      case "worker":
        rows = await tx
          .select({ id: workers.id })
          .from(workers)
          .where(eq(workers.id, subjectId))
          .for("key share");
        break;
      case "payer_user":
        rows = await tx
          .select({ id: payers.id })
          .from(payers)
          .where(eq(payers.id, subjectId))
          .for("key share");
        break;
      case "admin":
        rows = await tx
          .select({ id: adminUsers.id })
          .from(adminUsers)
          .where(eq(adminUsers.id, subjectId))
          .for("key share");
        break;
    }
    return rows.length > 0;
  }

  /** The login's stored theme, or null when it has never chosen. One primary-key read. */
  async findTheme(kind: DisplayPrefsSubjectKind, subjectId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ theme: displayPrefs.theme })
      .from(displayPrefs)
      .where(and(eq(displayPrefs.subjectKind, kind), eq(displayPrefs.subjectId, subjectId)))
      .limit(1);
    return row?.theme ?? null;
  }

  /**
   * {@link findTheme}, holding the row lock (`FOR UPDATE`) until `tx` ends, so two concurrent
   * changes serialise and each reports the theme it actually replaced. Call it on a transaction.
   */
  async lockTheme(
    kind: DisplayPrefsSubjectKind,
    subjectId: string,
    tx: Database,
  ): Promise<string | null> {
    const [row] = await tx
      .select({ theme: displayPrefs.theme })
      .from(displayPrefs)
      .where(and(eq(displayPrefs.subjectKind, kind), eq(displayPrefs.subjectId, subjectId)))
      .limit(1)
      .for("update");
    return row?.theme ?? null;
  }

  /**
   * The login's FIRST stored choice. Inserts only; false when a row already exists: a first choice
   * committed by a concurrent request after this transaction's {@link lockTheme} saw none.
   */
  async insertTheme(
    kind: DisplayPrefsSubjectKind,
    subjectId: string,
    theme: DisplayTheme,
    tx: Database,
  ): Promise<boolean> {
    const inserted = await tx
      .insert(displayPrefs)
      .values({ subjectKind: kind, subjectId, theme })
      .onConflictDoNothing({ target: [displayPrefs.subjectKind, displayPrefs.subjectId] })
      .returning({ subjectId: displayPrefs.subjectId });
    return inserted.length > 0;
  }

  /** Replace the stored theme. The caller holds the row lock from {@link lockTheme}. */
  async updateTheme(
    kind: DisplayPrefsSubjectKind,
    subjectId: string,
    theme: DisplayTheme,
    tx: Database,
  ): Promise<void> {
    await tx
      .update(displayPrefs)
      .set({ theme, updatedAt: sql`now()` })
      .where(and(eq(displayPrefs.subjectKind, kind), eq(displayPrefs.subjectId, subjectId)));
  }
}
