import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { type Database, type WorkerSearchExitVia, workerSearchExits } from "@badabhai/db";

import { DATABASE } from "../database/database.module";

/** A stored exit: when he left and which surface took him out. */
export interface StoredSearchExit {
  readonly hiddenAt: Date;
  readonly via: WorkerSearchExitVia;
}

/**
 * `worker_search_exits` (migration 0169, #2753 item 6) — DATABASE ACCESS ONLY. Whether the switch is
 * on, whether a request is a real change and what it emits are `SearchExitService`'s.
 *
 * NOTHING HERE MAY RUN WHILE `SEARCH_EXIT_ENABLED` IS OFF. 0169 is apply-before-the-switch: the
 * service and the route guard ask the switch first, which is what lets a build reach a database
 * without the table and fail no request.
 *
 * Every method is keyed on `worker_id`, the primary key, and the id is always the one
 * `WorkerAuthGuard` attached: no method reads or writes by anything else, so no caller can reach
 * another worker's row.
 *
 * NEVER TOUCHES `worker_consents`. Leaving search is not a consent change; that table stays the
 * consent service's alone.
 *
 * SPINE READ-ONLY: `worker.search_visibility_changed` is emitted through `EventsService.emit` on the
 * transaction {@link withTransaction} opens, so the row and its event commit together or not at all.
 */
@Injectable()
export class SearchExitRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Run `cb` inside one Drizzle transaction; the `tx` it gets is a `Database`-shaped executor. */
  withTransaction<T>(cb: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(cb as (tx: unknown) => Promise<T>);
  }

  /** His exit, or null while he is in company search. One primary-key read. */
  async find(workerId: string, tx: Database = this.db): Promise<StoredSearchExit | null> {
    const [row] = await tx
      .select({ hiddenAt: workerSearchExits.hiddenAt, via: workerSearchExits.via })
      .from(workerSearchExits)
      .where(eq(workerSearchExits.workerId, workerId))
      .limit(1);
    return row ?? null;
  }

  /**
   * Take him out. Inserts only: null when a row already exists (he was already out, or a concurrent
   * request took him out first), so a repeat keeps the FIRST `hidden_at` and its `via`.
   */
  async insert(
    workerId: string,
    via: WorkerSearchExitVia,
    tx: Database,
  ): Promise<StoredSearchExit | null> {
    const [row] = await tx
      .insert(workerSearchExits)
      .values({ workerId, via })
      .onConflictDoNothing({ target: workerSearchExits.workerId })
      .returning({ hiddenAt: workerSearchExits.hiddenAt, via: workerSearchExits.via });
    return row ?? null;
  }

  /** Bring him back. True when a row was deleted, false when he was already in search. */
  async remove(workerId: string, tx: Database): Promise<boolean> {
    const deleted = await tx
      .delete(workerSearchExits)
      .where(eq(workerSearchExits.workerId, workerId))
      .returning({ workerId: workerSearchExits.workerId });
    return deleted.length > 0;
  }
}
