import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { jobPostings } from "./job";

/** A Campus-origin posting's BadaBhai worker visibility (#2891). */
export const JOB_WORKER_VISIBILITY_STATES = ["off", "on"] as const;
export type JobWorkerVisibilityState = (typeof JOB_WORKER_VISIBILITY_STATES)[number];

/**
 * How the posting reached BadaBhai from Campus: posted by the placement team for a company
 * (`campus_posted`, #2752 part E) or brought over by the import of live Campus jobs
 * (`campus_imported`, #2754 item 7).
 */
export const JOB_WORKER_VISIBILITY_ORIGINS = ["campus_posted", "campus_imported"] as const;
export type JobWorkerVisibilityOrigin = (typeof JOB_WORKER_VISIBILITY_ORIGINS)[number];

// ---------------------------------------------------------------------------
// job_posting_worker_visibility — BadaBhai worker visibility of a Campus-origin posting (#2891).
//
// Ruling of 17 Nov 2026 (Akshit and Prakash): every job created on BadaBhai Campus also comes to
// BadaBhai, and shows to BadaBhai workers only AFTER AN ADMIN TURNS ITS WORKER VISIBILITY ON.
//
// ONE ROW PER CAMPUS-ORIGIN POSTING, written `off` before the posting can be seen by anyone (the
// Campus post-for-company route writes it while the posting is still a draft; the import writes it
// in the posting's own transaction), through `holdPostingFromWorkers` (`../job-worker-visibility`).
// A posting with NO row is not Campus-origin and this table never touches it.
//
// THE READ. `reachesBadaBhaiWorkers()` (`../job-visibility`) is false for a posting whose row says
// `off`, on every worker path (reach, feed, search, detail, apply) and in the reach core, so `off`
// behaves exactly as an RVM-students-only audience. `on` adds nothing: the posting's own audience
// still decides, so a company that later narrows it to RVM students is still obeyed.
//
// SEPARATE FROM THE RVM REVIEW. `job_posting_institute_reviews` governs RVM students; this row
// governs BadaBhai workers. Nothing here is in the review content hash, so turning visibility on
// or off never sends an approved posting back to `pending`.
//
// `decided_*` is the LATEST admin decision; null means no admin has decided yet (the admin list's
// "waiting" set). Every decision also writes an `audit_logs` row with the admin's reason. An `on`
// is only ever an admin decision (`jpwv_decision_chk`).
// ---------------------------------------------------------------------------
export const jobPostingWorkerVisibility = pgTable(
  "job_posting_worker_visibility",
  {
    jobPostingId: uuid("job_posting_id")
      .primaryKey()
      .references(() => jobPostings.id, { onDelete: "cascade" }),
    state: text("state").$type<JobWorkerVisibilityState>().notNull().default("off"),
    origin: text("origin").$type<JobWorkerVisibilityOrigin>().notNull(),
    decidedByAdminId: uuid("decided_by_admin_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The admin list: by state, oldest first.
    index("jpwv_state_created_idx").on(t.state, t.createdAt),
    check("jpwv_state_chk", sql`${t.state} IN ('off', 'on')`),
    check("jpwv_origin_chk", sql`${t.origin} IN ('campus_posted', 'campus_imported')`),
    // A decision names who and when, together; `on` exists only as a decision.
    check(
      "jpwv_decision_chk",
      sql`(${t.decidedAt} IS NULL) = (${t.decidedByAdminId} IS NULL)
        AND (${t.state} = 'off' OR ${t.decidedAt} IS NOT NULL)`,
    ),
  ],
).enableRLS();
