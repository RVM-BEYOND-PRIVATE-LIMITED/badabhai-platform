/**
 * WORKER APP FEEDBACK — the worker's own words, on their way to the admin console (#997).
 *
 * ONE TABLE, ONE JOB. A worker taps the app-wide Feedback button, types free text, optionally
 * tags it, and it lands here. There is no workflow, no status and no admin reply: the product
 * ask was a way for a worker to reach us and a way for ops to read it, and modelling a triage
 * lifecycle now would be inventing business logic nobody has ruled on (CLAUDE.md §13).
 *
 * PRIVACY CLASS — THE ONE EXCEPTION ON THIS SPINE, AND IT IS DELIBERATE. `message` is the
 * worker's OWN free text and MAY contain their own PII (a name, a phone number, an employer).
 * That is fine here and only here:
 *   - it is stored and shown to admins — the whole point of the feature;
 *   - it must NEVER reach an LLM or analytics unpseudonymized (CLAUDE.md §11);
 *   - it must NEVER be logged (`FeedbackService` logs an id prefix, a category and a LENGTH);
 *   - it must NEVER ride an event — `feedback.submitted` carries `message_length`, not the
 *     text, mirroring how `job.search_performed` treats the search term (CLAUDE.md §2).
 * The events spine is where raw PII must not land; this table IS the place it lives.
 *
 * `app_build` is the `x-app-build` request header (#966) — a commit SHA or `dev`, PII-free by
 * contract. It arrives from an untrusted client, so it is bounded (64) and charset-checked at
 * the edge; a value that fails is stored as NULL rather than rejecting the submission, because
 * a malformed build stamp is not a reason to lose a worker's feedback.
 *
 * DPDP / DSAR ERASURE IS THE CASCADE, WITH ZERO CODE. `WorkersRepository.hardDelete` enumerates
 * no table names, so `ON DELETE cascade` from `workers` IS the erasure coverage — the same
 * mechanism `pack-answer.ts` and `ai-cost.ts` document. It matters more here than anywhere,
 * because this is the one worker-owned table whose contents are unbounded free text.
 */
import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, index, check } from "drizzle-orm/pg-core";
import type { WorkerFeedbackCategory } from "@badabhai/types";

import { workers } from "./worker";

// ---------------------------------------------------------------------------
// worker_feedback — one worker-authored feedback submission, append-only
// ---------------------------------------------------------------------------
export const workerFeedback = pgTable(
  "worker_feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workerId: uuid("worker_id")
      .notNull()
      // DPDP actor-scoped erasure cascades from workers — see the header.
      .references(() => workers.id, { onDelete: "cascade" }),
    // NULLABLE ON PURPOSE. Tagging is optional in the shipped app and the client omits the key
    // entirely when untagged; a default of 'other' would turn "did not tag" into "said other"
    // and make the category histogram ops reads a lie.
    category: text("category").$type<WorkerFeedbackCategory>(),
    // The worker's own words. May contain their own PII. Never logged, never evented.
    message: text("message").notNull(),
    // `x-app-build` (#966): a commit SHA / build number, or NULL when absent or malformed.
    appBuild: text("app_build"),
    // WHICH SCREEN the worker was on when they tapped Feedback — a ROUTE PATTERN
    // (`/jobs/:id/apply`), NEVER the concrete path. That distinction is the privacy design and
    // not a tidying step: a raw path carries an entity id, which links this row to one specific
    // job or session — a fact about the worker nobody asked them to disclose. Normalized
    // server-side by `sanitizeScreenContext` even though the client normalizes too (the client
    // is untrusted; the one that skips it is precisely the one whose value carries an id), and
    // NULL when absent or unrecognisable, because losing a worker's typed feedback over a bad
    // route string is the wrong failure direction.
    screenContext: text("screen_context"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The FK-referencing column Postgres does not index for you.
    index("worker_feedback_worker_id_idx").on(t.workerId),
    // The admin list's keyset sort — newest first, id as the total-order tie-breaker.
    //
    // `.nullsFirst()` IS LOAD-BEARING on both indexes below — the `chat_messages_session_created_idx`
    // lesson (schema/chat.ts, migration 0067), repeated here because it is invisible in a diff and
    // silent in production. Postgres reads the repository's bare `ORDER BY created_at DESC, id DESC`
    // (drizzle's `desc()` emits no NULLS clause) as DESC NULLS FIRST, and an index built DESC NULLS
    // LAST — which is what drizzle's `.desc()` alone generates — does NOT satisfy that ordering. The
    // planner then uses the index for the FILTER and still inserts a Sort, which is the entire cost
    // this index exists to remove: the keyset predicate matches nearly every row when the cursor is
    // near the head, so page two reads the table and top-N sorts it instead of walking 51 entries.
    // Both columns are NOT NULL, so this changes no result — only the plan.
    index("worker_feedback_admin_keyset_idx").on(
      t.createdAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    // The same page, filtered by category. A composite LEADING on `category`, because the
    // unfiltered list already has its own index above and one index cannot serve both.
    index("worker_feedback_category_keyset_idx").on(
      t.category,
      t.createdAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    // The CHECK is the authority; the TS union on the column is the TypeScript view of it.
    check(
      "worker_feedback_category_chk",
      sql`${t.category} IS NULL OR ${t.category} IN ('suggestion', 'problem', 'other')`,
    ),
    // Non-empty and bounded AT THE DATABASE. The zod schema is the first line, not the last:
    // a future second writer (a backfill, an ops script) would bypass it entirely. The literal
    // tracks WORKER_FEEDBACK_MESSAGE_MAX — SQL cannot import, so `worker-feedback-schema.test.ts`
    // asserts the two are equal.
    check("worker_feedback_message_len_chk", sql`char_length(${t.message}) BETWEEN 1 AND 4000`),
    // Same deal for the untrusted build stamp: WORKER_FEEDBACK_APP_BUILD_MAX, pinned here too.
    check(
      "worker_feedback_app_build_len_chk",
      sql`${t.appBuild} IS NULL OR char_length(${t.appBuild}) BETWEEN 1 AND 64`,
    ),
    // And for the route pattern: WORKER_FEEDBACK_SCREEN_MAX. A LENGTH bound only — the charset
    // and the id-substitution live in `sanitizeScreenContext`, because a CHECK that refused a
    // malformed value would turn the sanitizer's "store NULL and carry on" into a 500 that
    // costs the worker their message, which is the exact failure this column must not cause.
    check(
      "worker_feedback_screen_context_len_chk",
      sql`${t.screenContext} IS NULL OR char_length(${t.screenContext}) BETWEEN 1 AND 128`,
    ),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by migration 0080
