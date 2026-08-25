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
import { pgTable, uuid, text, timestamp, index, check, jsonb } from "drizzle-orm/pg-core";
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
    // WHICH SCREEN of the worker app the feedback was about — one of the app's own route
    // constants (`/jobs/detail/:id`), NEVER the concrete path. That distinction is the privacy
    // design and not a tidying step: a raw path carries an entity id, which links this row to one
    // specific job or session — a fact about the worker nobody asked them to disclose. Resolved
    // server-side by `resolveScreenTemplate`, which matches the untrusted client value against
    // the app's finite route table and binds ITS OWN CONSTANT, so no byte a caller chose can
    // reach this column. NULL when absent or matching no screen, because losing a worker's typed
    // feedback over a route string their client got wrong is the wrong failure direction.
    screenContext: text("screen_context"),
    // THE OBJECT KEYS of the images the worker attached, in the private attachments bucket
    // (#1191) — `feedback-attachments/<worker_id>/<uuid>.jpg`, at most three.
    //
    // KEYS, NEVER BYTES AND NEVER URLS. The images live in Storage; this column is a pointer
    // list, exactly as `workers.photo_storage_key` is for a profile photo (ADR-0032). A signed
    // URL is a BEARER CREDENTIAL with a lifetime, so storing one would put a live capability in
    // a row that outlives it and hand every future reader of this table a way to fetch the
    // bytes without passing the admin surface that audits the read.
    //
    // PRIVACY CLASS: the same as `message`, and treated the same. A worker photographs what is
    // in front of them — a payslip, a gate pass, a supervisor — so the BYTES may carry their own
    // PII and the bytes are why the bucket is private and read only through a short-TTL signed
    // URL. The PATHS themselves must never ride the spine either: `feedback.submitted` carries
    // `attachment_count` and nothing more, which is the same ruling this table's header makes
    // about `message` carrying only a length.
    //
    // NULLABLE, NO DEFAULT — the two properties that make the migration catalog-only against a
    // table that already holds feedback. NULL and `[]` are the same fact here ("no images") and
    // the readers treat them identically; no writer produces `[]`, because the shipped client
    // omits the key entirely when the worker attached nothing.
    //
    // ERASURE IS STILL THE CASCADE for the ROW. The OBJECTS are erased by the worker-prefix
    // sweep `AccountDeletionService` already runs per bucket — which is why the key is
    // worker-scoped rather than flat, and why a bucket that is set must also be swept.
    attachmentPaths: jsonb("attachment_paths").$type<string[]>(),
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
    // And for the screen name: WORKER_FEEDBACK_SCREEN_MAX. A LENGTH bound only — DELIBERATELY,
    // and re-examined when the request-edge normalizer became an allowlist.
    //
    // ⚠ SQL COULD NOW PIN MEMBERSHIP (`screen_context IN ('/', '/login', …)`) and that would be
    // strictly stronger than a length. It is still the wrong constraint, for two reasons that
    // outrank the strength:
    //   1. IT TURNS THE ORDINARY EVENT INTO LOST FEEDBACK. The app gaining a screen is routine.
    //      With an IN-list CHECK, the widening becomes a MIGRATION that must be applied before
    //      the code that emits the new constant deploys; get that order wrong and every INSERT
    //      carrying the new screen is a 23514 inside the same transaction as the event, which
    //      costs the worker the paragraph they typed. A telemetry label must never be able to do
    //      that (the same reasoning migration 0081 already records).
    //   2. IT WOULD BE THE THIRD COPY OF THE TABLE. `WORKER_APP_SCREEN_TEMPLATES` is already
    //      mirrored by the resolver's return TYPE and by the event payload's `z.enum`; a SQL
    //      literal list cannot import, so it could only be kept honest by yet another
    //      equality test — one more thing to drift, guarding a value only one writer produces.
    // Where membership IS enforced: `resolveScreenTemplate` (the sole writer — it returns a table
    // constant or null, and the compiler refuses anything else) and `FeedbackSubmittedPayload`
    // (the spine's own refusal, which is where a SECOND emitter added later must fail closed).
    // What is left for SQL is the case neither reaches — a backfill or an ops script writing the
    // column directly — and against that a length bound still keeps the column from being
    // repurposed as a second free-text channel around the `message` bound.
    check(
      "worker_feedback_screen_context_len_chk",
      sql`${t.screenContext} IS NULL OR char_length(${t.screenContext}) BETWEEN 1 AND 128`,
    ),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by migration 0080
