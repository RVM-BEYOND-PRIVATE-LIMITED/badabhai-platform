import { relations, sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { workers } from "./worker";

/**
 * WORKER PORTFOLIO (ADR-0042 D9 / Layer A (e), migration 0113).
 *
 * A small, worker-owned list of work samples: a photo of something they made, a short video, or a
 * link (a YouTube clip, a drive folder, a portfolio page). One row per item, in the worker's own
 * order.
 *
 * ═══ WHY A TABLE AND NOT AN ATTRIBUTE ═══
 *
 * Repeatable, ordered, mixed-kind rows — the qualifications shape, not the single-key shape
 * `worker_attributes` can hold. `(worker_id, sort_order)` unique + delete-then-insert replace is
 * the same seam `worker_certificate` uses, and the same reasons apply.
 *
 * ═══ THE CONTENT INVARIANT IS IN THE DATABASE ═══
 *
 * A `photo`/`video` is a STORAGE KEY (the opaque object key under the private portfolio bucket,
 * never a URL and never bytes); a `link` is an external URL. `wp_content_chk` refuses a row that
 * carries both or neither, so no reader has to guess which column a kind means.
 *
 * ═══ NOT EMPLOYER-VISIBLE BY DEFAULT ═══
 *
 * Nothing on the employer copy reads this table. Rendering (and any audience decision about it)
 * belongs to the universal renderer, and the safe default until that is ruled is "not printed".
 */
export const workerPortfolio = pgTable(
  "worker_portfolio",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    /** `photo` | `video` | `link` — closed; the CHECK enforces membership. */
    kind: text("kind").notNull(),
    /**
     * The opaque Storage object key for a photo/video (`portfolio/{workerId}/{uuid}.{ext}`,
     * server-chosen at mint time). NEVER a URL, never photo bytes.
     */
    storageKey: text("storage_key"),
    /** The external URL for a link. http(s) only, enforced by the CHECK below. */
    url: text("url"),
    /** What the item is, in the worker's own words. Bounded, optional. */
    caption: text("caption"),
    /** Display order — the worker's own ordering, never derived. */
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check("wp_kind_chk", sql`${t.kind} IN ('photo', 'video', 'link')`),
    check(
      "wp_content_chk",
      sql`(
        (${t.kind} IN ('photo', 'video') AND ${t.storageKey} IS NOT NULL AND ${t.url} IS NULL) OR
        (${t.kind} = 'link' AND ${t.url} IS NOT NULL AND ${t.storageKey} IS NULL)
      )`,
    ),
    check("wp_url_scheme_chk", sql`${t.url} IS NULL OR ${t.url} ~ '^https?://'`),
    check("wp_caption_len_chk", sql`${t.caption} IS NULL OR length(${t.caption}) <= 160`),
    check("wp_sort_order_chk", sql`${t.sortOrder} >= 0`),
    uniqueIndex("wp_worker_sort_uq").on(t.workerId, t.sortOrder),
  ],
).enableRLS();

export const workerPortfolioRelations = relations(workerPortfolio, ({ one }) => ({
  worker: one(workers, {
    fields: [workerPortfolio.workerId],
    references: [workers.id],
  }),
}));

export type WorkerPortfolioItem = typeof workerPortfolio.$inferSelect;
export type NewWorkerPortfolioItem = typeof workerPortfolio.$inferInsert;
