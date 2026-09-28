import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { type Database, workerResumeSkins } from "@badabhai/db";
import type { ResumeSkin } from "@badabhai/types";

import { DATABASE } from "../database/database.module";

/**
 * `worker_resume_skin` (migration 0128, #1801) — DATABASE ACCESS ONLY. Whether a choice is a
 * real change, and what it emits, is `ResumeSkinService`'s.
 *
 * NOTHING HERE MAY RUN WHILE `RESUME_SKINS_ENABLED` IS OFF. The table is 0128's, and 0128 is
 * apply-before-flag-on: every caller checks the flag first, which is what lets a build reach a
 * database that has not applied the migration without a single failed query.
 *
 * SPINE READ-ONLY: this repository never touches `events`. `resume.skin_changed` is emitted through
 * `EventsService.emit` on the transaction {@link withTransaction} opens, so the preference and its
 * event commit together or not at all.
 *
 * Returns the stored skin as a raw STRING, deliberately not narrowed: `wrs_skin_chk` keeps the
 * column inside `RESUME_SKINS`, but narrowing belongs to the service that decides what an
 * unrecognised value means, not to a cast here.
 *
 * Depends only on the @Global DATABASE, so it is PROVIDED in ResumeModule (the
 * `ProfilingTierRepository` precedent) rather than exported through a module edge.
 */
@Injectable()
export class ResumeSkinRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Run `cb` inside one Drizzle transaction (the must-fix H3 seam, `FeedbackRepository`'s shape).
   * The `tx` handed to `cb` is a `Database`-shaped executor that the methods below and
   * `EventsService.emit` all accept.
   */
  withTransaction<T>(cb: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(cb as (tx: unknown) => Promise<T>);
  }

  /** The worker's stored skin, or null when they have never chosen. A primary-key read. */
  async findSkin(workerId: string, tx: Database = this.db): Promise<string | null> {
    const [row] = await tx
      .select({ skin: workerResumeSkins.skin })
      .from(workerResumeSkins)
      .where(eq(workerResumeSkins.workerId, workerId))
      .limit(1);
    return row?.skin ?? null;
  }

  /**
   * {@link findSkin}, holding the row lock (`FOR UPDATE`) until `tx` ends — so two concurrent
   * changes serialise, and each reports the `previous_skin` it actually replaced. Must be called
   * on a transaction; a lock taken on the pool would be released at once.
   */
  async lockSkin(workerId: string, tx: Database): Promise<string | null> {
    const [row] = await tx
      .select({ skin: workerResumeSkins.skin })
      .from(workerResumeSkins)
      .where(eq(workerResumeSkins.workerId, workerId))
      .limit(1)
      .for("update");
    return row?.skin ?? null;
  }

  /**
   * The worker's FIRST choice. Inserts only; false when a row already exists — a first choice
   * committed by a concurrent request after this transaction's {@link lockSkin} saw none.
   */
  async insertSkin(workerId: string, skin: ResumeSkin, at: Date, tx: Database): Promise<boolean> {
    const inserted = await tx
      .insert(workerResumeSkins)
      .values({ workerId, skin, updatedAt: at })
      .onConflictDoNothing({ target: workerResumeSkins.workerId })
      .returning({ workerId: workerResumeSkins.workerId });
    return inserted.length > 0;
  }

  /** Replace the stored skin. The caller holds the row lock from {@link lockSkin}. */
  async updateSkin(workerId: string, skin: ResumeSkin, at: Date, tx: Database): Promise<void> {
    await tx
      .update(workerResumeSkins)
      .set({ skin, updatedAt: at })
      .where(eq(workerResumeSkins.workerId, workerId));
  }
}
