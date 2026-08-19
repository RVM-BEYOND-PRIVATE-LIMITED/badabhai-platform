import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, lt, or, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { WorkerFeedbackCategory } from "@badabhai/types";
import { workerFeedback, type Database } from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import type { EntityCursor } from "./admin-entities.cursor";
import type { AdminFeedbackListItem } from "./admin-feedback.dto";

/**
 * SELECT-ONLY data access for the admin worker-feedback read (#997).
 *
 * ── WHY THIS IS NOT A METHOD ON `AdminEntitiesRepository` ────────────────────────────────
 * That module's contract is stated in its own header — "ids + enums + timestamps + counts" —
 * and `admin-static-guards.test.ts` enforces it with a source scan on that exact file. This
 * read projects `message`, worker-authored free text that may contain the worker's own PII.
 * Putting it there would break the faceless promise inside the file that declares it, and the
 * scan would either fail or have to be weakened. A sibling module keeps that contract intact
 * and makes this surface's deliberate exception a thing a reviewer can see in one place.
 *
 * ── NO WRITES, EVER ─────────────────────────────────────────────────────────────────────
 * There is no insert/update/delete here and there must never be one. Feedback is written by
 * `FeedbackService` on the worker's own submission, transactionally paired with its
 * `feedback.submitted` event; a write added here would change system-of-record state with no
 * audit trail. `worker_feedback` is append-only by design — there is no triage workflow, no
 * status column and no admin reply, so there is nothing for an admin to mutate.
 *
 * ── NO SEARCH OVER `message` ────────────────────────────────────────────────────────────
 * Filtering is by `category` only, and that is a product decision, not an omission: a
 * substring search over free text is a PII discovery tool — "find every worker who typed a
 * phone number" — and the fact that it would be one `ilike` away is why it is refused here in
 * writing rather than left to be noticed later.
 */
@Injectable()
export class AdminFeedbackRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * "Strictly older than the cursor" under DESC `(created_at, id)`: `created_at < c` OR
   * (`created_at = c` AND `id < cid`). The `id` tie-breaker is what makes the ordering TOTAL,
   * so no row is skipped or repeated at a page boundary — and it is load-bearing here, because
   * a burst of feedback after an app release lands many rows inside one `defaultNow()` tick.
   *
   * `lt`/`eq` on the COLUMN, never an interpolated `sql` template. The two render identical
   * SQL and differ only in the bound parameter: the template hands the `Date` to postgres-js
   * RAW, which is what made every cursor-bearing admin request 500 before BP-1 while page one
   * looked healthy. See `admin-keyset-params.test.ts` for the full post-mortem.
   */
  private static before(createdAtCol: PgColumn, idCol: PgColumn, cursor: EntityCursor): SQL {
    const at = new Date(cursor.createdAt);
    return or(lt(createdAtCol, at), and(eq(createdAtCol, at), lt(idCol, cursor.id)))!;
  }

  /**
   * One keyset page of feedback, newest first. `limit` is the caller's page size PLUS ONE —
   * the service over-fetches by one to tell "there is more" from "that was the last page".
   */
  async list(
    filter: { category?: WorkerFeedbackCategory },
    cursor: EntityCursor | null,
    limit: number,
  ): Promise<AdminFeedbackListItem[]> {
    const clauses: SQL[] = [];
    if (filter.category) clauses.push(eq(workerFeedback.category, filter.category));
    if (cursor)
      clauses.push(
        AdminFeedbackRepository.before(workerFeedback.createdAt, workerFeedback.id, cursor),
      );

    const rows = await this.db
      .select({
        id: workerFeedback.id,
        // The worker is an OPAQUE ID here and nowhere near a join to `workers`. Naming the
        // columns explicitly is the boundary: a bare `select()` over a join would put
        // `phone_e164`, `phone_hash` and `full_name` one `return row` away from a response.
        workerId: workerFeedback.workerId,
        category: workerFeedback.category,
        // The sanctioned exception, and the only one on this surface — see the dto header.
        message: workerFeedback.message,
        appBuild: workerFeedback.appBuild,
        createdAt: workerFeedback.createdAt,
      })
      .from(workerFeedback)
      .where(clauses.length > 0 ? and(...clauses) : undefined)
      // Newest first, with `id` as the tie-breaker the keyset predicate above depends on. The
      // ORDER BY and the cursor must agree on the sort key or paging silently loses rows.
      .orderBy(desc(workerFeedback.createdAt), desc(workerFeedback.id))
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      worker_id: r.workerId,
      category: r.category,
      message: r.message,
      app_build: r.appBuild,
      created_at: r.createdAt,
    }));
  }
}
