import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, lt, or, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { WorkerFeedbackCategory } from "@badabhai/types";
import { workerFeedback, type Database } from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import type { EntityCursor } from "./admin-entities.cursor";
import type { AdminFeedbackRow } from "./admin-feedback.dto";

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
 * Filtering is by `category` and `worker_id`, and the omission is `message`: a substring search
 * over free text is a PII discovery tool — "find every worker who typed a phone number" — and
 * the fact that it would be one `ilike` away is why it is refused here in writing rather than
 * left to be noticed later. THE `worker_id` FILTER IS NOT A CRACK IN THAT: a search takes
 * CONTENT and returns a set of people, while an id filter takes an id the admin already holds
 * and returns a subset of a page they could already read. See the DTO header for the full
 * argument; the line that must not move is the one around `message`.
 *
 * ── WHY NO NEW INDEX FOR THE WORKER FILTER ───────────────────────────────────────────────
 * The worker-filtered page runs the same `ORDER BY created_at DESC, id DESC` keyset as every
 * other, so the composite that would serve it perfectly is `(worker_id, created_at DESC NULLS
 * FIRST, id DESC NULLS FIRST)` — the shape `worker_feedback_category_keyset_idx` takes for the
 * category filter. It is deliberately NOT added, and the two filters differ in the one property
 * that decides it: SELECTIVITY.
 *
 *   * `category` has three values plus NULL, so a filtered page matches roughly a third of the
 *     table. Postgres reads a third of the rows and top-N sorts them, every page — which is why
 *     that composite had to exist from day one.
 *   * `worker_id` matches a HANDFUL of rows, permanently. The submit route is capped per worker
 *     per minute AND per hour, and a worker who files even ten complaints in the product's
 *     lifetime is a heavy outlier. `worker_feedback_worker_id_idx` (which exists for the DSAR
 *     cascade and, until now, had no query reader at all) fetches that handful, and sorting ten
 *     rows is free at any table size.
 *
 * So the existing single-column index is the right one and the composite would be a second index
 * to maintain on every insert in exchange for removing a sort of ~10 rows. Revisit only if the
 * per-worker row count stops being small — which would mean the rate caps had been removed.
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
    filter: { category?: WorkerFeedbackCategory; workerId?: string },
    cursor: EntityCursor | null,
    limit: number,
  ): Promise<AdminFeedbackRow[]> {
    const clauses: SQL[] = [];
    if (filter.category) clauses.push(eq(workerFeedback.category, filter.category));
    // The narrow lookup, served by `worker_feedback_worker_id_idx` — see the header for why that
    // index is enough and no composite is added.
    if (filter.workerId) clauses.push(eq(workerFeedback.workerId, filter.workerId));
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
        // The route PATTERN, never a path — normalized at the edge, so no id can be here to
        // project. This is what turns "button kaam nahi kar raha" into an actionable report.
        screenContext: workerFeedback.screenContext,
        // THE STORED KEYS, WHICH STOP HERE. `AdminFeedbackService` turns them into short-lived
        // signed urls and the wire contract has no key-shaped field at all — see
        // {@link AdminFeedbackRow}. A key is a durable handle to a private image; a url expires.
        attachmentPaths: workerFeedback.attachmentPaths,
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
      screen_context: r.screenContext,
      // NULL AND `[]` ARE THE SAME FACT HERE — "no images" — and they are collapsed at this
      // boundary rather than downstream. The column is nullable because that is what makes
      // migration 0092 catalog-only, and no writer produces `[]`; every reader above this line
      // gets an array and never has to re-decide which spelling it is looking at.
      attachment_paths: r.attachmentPaths ?? [],
      created_at: r.createdAt,
    }));
  }
}
