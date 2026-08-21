import { Inject, Injectable } from "@nestjs/common";
import {
  type Database,
  type NewWorkerFeedback,
  type WorkerFeedback,
  workerFeedback,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import { redactQueryParams } from "../common/db-error";

/**
 * Data access for `worker_feedback` (#997) — the worker's own words, on their way to the admin
 * console. APPEND-ONLY BY DESIGN: there is no update and no delete here, because the product ask
 * was a way for a worker to reach us and a way for ops to read it, not a triage lifecycle
 * (CLAUDE.md §13 — do not invent business logic nobody has ruled on). Erasure is the `ON DELETE
 * cascade` from `workers`, which is why `WorkersRepository.hardDelete` needs no line for this
 * table.
 *
 * SPINE READ-ONLY: this repository never touches the `events` table. The `feedback.submitted`
 * event is emitted exclusively through `EventsService.emit`, on the transaction {@link
 * withTransaction} opens, so the row and its audit record commit together.
 *
 * THE ONE PII-CARRYING COLUMN ON THE WORKER SPINE lives here (`message`). This layer stores and
 * returns it and does nothing else with it — no logging, no shaping, no derived fields. Every
 * rule about where those words may travel is enforced by the service above.
 */
@Injectable()
export class FeedbackRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Run `cb` inside one Drizzle transaction (the must-fix H3 seam). `FeedbackService` uses it to
   * commit the feedback row and its `feedback.submitted` event atomically; the `tx` handed to
   * `cb` is a `Database`-shaped executor that both {@link insert} and `EventsService.emit`
   * accept. The cast is drizzle's transaction-callback parameter type, which is structurally the
   * same executor with a narrower nominal type.
   */
  withTransaction<T>(cb: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(cb as (tx: unknown) => Promise<T>);
  }

  /**
   * Insert one submission and return the stored row.
   *
   * `.returning()` rather than a follow-up select: the caller needs the generated `id` to build
   * the event's idempotency key and its `feedback_id`, and a second round-trip inside the
   * transaction would buy nothing. An empty result cannot happen for a plain insert, so it is a
   * programming error rather than a caller-facing failure — thrown, never returned as
   * `undefined` for the service to re-check.
   *
   * `tx` defaults to the pooled connection so the method is usable standalone, but the only
   * caller today passes the transaction from {@link withTransaction}.
   *
   * THE CATCH IS THE PRIVACY BOUNDARY, NOT ERROR HANDLING. `message` travels to the driver as a
   * bound parameter, and drizzle's `DrizzleQueryError` puts the whole parameter array into its
   * own `.message` — so a failed insert carries the worker's words in `.stack`, which
   * `AllExceptionsFilter` logs verbatim on any 5xx. That is the single path by which the one
   * column allowed to hold a worker's own PII reaches a log, and it opens on the ORDINARY
   * failures (a timeout, a deadlock, or the apply-before-deploy window this migration's header
   * documents), not on anything exotic. Redacting here rather than in the filter keeps the
   * guarantee next to the write that needs it. The call still fails, identically, one line later.
   */
  async insert(input: NewWorkerFeedback, tx: Database = this.db): Promise<WorkerFeedback> {
    let row: WorkerFeedback | undefined;
    try {
      [row] = await tx.insert(workerFeedback).values(input).returning();
    } catch (err) {
      throw redactQueryParams(err, "worker feedback insert");
    }
    if (!row) throw new Error("Failed to insert worker feedback");
    return row;
  }
}
