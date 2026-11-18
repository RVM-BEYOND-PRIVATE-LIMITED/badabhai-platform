import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { PostingChoice, PostingSurface } from "@badabhai/types";
import { jobPostings } from "./job";

// ---------------------------------------------------------------------------
// job_posting_choices — which of the two posting buttons a company tapped (#2751 items 1 to 3,
// brief 4B.7): "Post free" (`free`) or "Post free + Starter" (`free_plus_pack`), and on which
// client (`web` or `app`). ONE ROW PER POSTING, EVER: the job posting id is the primary key, so
// the first publish that carries a choice records it and every later one changes nothing.
//
// A NEW TABLE, NOT A COLUMN ON `job_postings` (#2751's "posting_choice on the posting" moved here):
// the posting reads select every column, so a new column there would make the migration
// apply-before-deploy. Nothing reads or writes this table unless the `posting_choice` switch is on
// for the company, and the publish never fails because of it (the write runs after the publish
// committed, and its error is logged and swallowed).
//
// The job goes live whatever the choice, and whatever happens to the payment: this row records the
// tap, nothing else. The purchase a paid tap starts is joined through
// `payment_orders.origin_job_posting_id` (#2749 item 9), not stored here.
//
// `payer_id` is the company's tenant key (the wallet), the same value the posting's ownership
// read uses; no FK, as on `credit_lots`. The week, city and trade the numbers screen counts by come
// from the posting (BB-D-09).
//
// PII-FREE: ids, two closed codes and a time. RLS forced, every role revoked (the migration's
// hand-written tail).
// ---------------------------------------------------------------------------
export const jobPostingChoices = pgTable(
  "job_posting_choices",
  {
    // ON DELETE CASCADE: the row describes the posting and nothing else, so an erasure that
    // deletes a posting (a test company's rows) is never blocked by it.
    jobPostingId: uuid("job_posting_id")
      .primaryKey()
      .references(() => jobPostings.id, { onDelete: "cascade" }),
    payerId: uuid("payer_id").notNull(),
    choice: text("choice").$type<PostingChoice>().notNull(),
    surface: text("surface").$type<PostingSurface>().notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("job_posting_choices_recorded_idx").on(t.recordedAt),
    index("job_posting_choices_payer_idx").on(t.payerId),
    check("job_posting_choices_choice_chk", sql`${t.choice} IN ('free', 'free_plus_pack')`),
    check("job_posting_choices_surface_chk", sql`${t.surface} IN ('web', 'app')`),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + four REVOKEs carried by the migration's tail

export type JobPostingChoiceRow = typeof jobPostingChoices.$inferSelect;
