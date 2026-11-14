import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { type InstituteCode } from "./institute-link";
import { jobPostings } from "./job";

/**
 * #2746 — the institute side of a posting's audience: the placement team's review, and the
 * branch and course labels a company can target. Both tables are read by the Campus service
 * routes (#2752) and the company's own posting reads; no worker path reads either, because a
 * BadaBhai worker's visibility depends on `job_postings.audience` alone. The institute code set
 * is #2752's `INSTITUTE_CODES` (`./institute-link`), one list for the link and the review.
 */

/** Campus contract `REVIEW_STATES` (`apps/api/src/campus-link/campus-link.contract.ts`). */
export const INSTITUTE_REVIEW_STATES = ["pending", "approved", "rejected"] as const;
export type InstituteReviewState = (typeof INSTITUTE_REVIEW_STATES)[number];

/**
 * One row per (posting, institute): the placement team's review of the RVM part of a posting
 * whose audience is `rvm_students` or `both`. Written `pending` in the same transaction that
 * gives a posting an RVM audience, and NEVER deleted when the audience goes back to BadaBhai
 * workers: the row is what Campus's posting feed is driven from, so a withdrawn posting still
 * reaches Campus (as closed). Every audience change bumps `updated_at`.
 *
 * APPROVED MEANS APPROVED FOR THIS CONTENT. `content_hash` is the sha256 of every field an RVM
 * student sees (title, description, requirements, benefits, pay, location, shift, experience,
 * vacancy, audience, targeting — owner ruling 2026-11-13 — and the company label Campus shows)
 * at review time, computed by `postingReviewContentHash` (`../job-review.ts`). A company edit that
 * changes it returns the row to `pending`, which clears every decision column
 * (`jpir_decision_chk`; the history lives in the review events). Reads trust nothing but the
 * hash: a posting counts as approved only while `state = 'approved'` AND the hash equals the
 * posting's hash now, so a writer that forgets the reset cannot leak an unreviewed edit. A
 * posting with an RVM audience and NO row is not approved (fail closed).
 *
 * `branch_ids` / `course_ids` NULL = not narrowed; set, they are non-empty (an empty list would
 * mean "every branch" and widen, not narrow) and REPLACE the posting's own `rvm_branch_ids` /
 * `rvm_course_ids` for RVM students (Campus contract, PUT review). That a narrowed list is a
 * subset of the posting's own is checked by the service. `reviewer_ref` is a Campus staff uuid
 * stored as text and never resolved here.
 */
export const jobPostingInstituteReviews = pgTable(
  "job_posting_institute_reviews",
  {
    jobPostingId: uuid("job_posting_id")
      .notNull()
      .references(() => jobPostings.id, { onDelete: "cascade" }),
    instituteCode: text("institute_code").$type<InstituteCode>().notNull(),
    state: text("state").$type<InstituteReviewState>().notNull().default("pending"),
    reviewerRef: text("reviewer_ref"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reason: text("reason"),
    branchIds: jsonb("branch_ids").$type<number[]>(),
    courseIds: jsonb("course_ids").$type<string[]>(),
    contentHash: text("content_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: "job_posting_institute_reviews_pk",
      columns: [t.jobPostingId, t.instituteCode],
    }),
    // Campus's posting feed (`changed_since` + cursor), driven from these rows. The feed's
    // `changed_at` is GREATEST(review.updated_at, job_postings.updated_at), for the filter AND the
    // cursor: hide, suspend, close and reinstate write only the posting, and must still reach
    // Campus (as `closed` / `open`).
    index("jpir_feed_idx").on(t.instituteCode, t.updatedAt, t.jobPostingId),
    // Mirrors `INSTITUTE_CODES`; a second institute widens this with that list.
    check("jpir_institute_code_chk", sql`${t.instituteCode} IN ('rvm')`),
    check("jpir_state_chk", sql`${t.state} IN ('pending', 'approved', 'rejected')`),
    // Pending carries no decision; a decision carries who, when and what it saw.
    check(
      "jpir_decision_chk",
      sql`(${t.state} = 'pending' AND ${t.reviewerRef} IS NULL AND ${t.reviewedAt} IS NULL
          AND ${t.reason} IS NULL AND ${t.branchIds} IS NULL AND ${t.courseIds} IS NULL
          AND ${t.contentHash} IS NULL)
        OR (${t.state} IN ('approved', 'rejected') AND ${t.reviewerRef} IS NOT NULL
          AND ${t.reviewedAt} IS NOT NULL AND ${t.contentHash} IS NOT NULL)`,
    ),
    // The contract's `StaffRefSchema`: a uuid, so a name or email can never be stored here.
    check(
      "jpir_reviewer_ref_chk",
      sql`${t.reviewerRef} IS NULL OR ${t.reviewerRef} ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'`,
    ),
    check(
      "jpir_reason_chk",
      sql`${t.reason} IS NULL OR char_length(${t.reason}) BETWEEN 1 AND 500`,
    ),
    // Narrowed lists: the targeting shapes of `job_postings_rvm_targeting_chk`, and NON-EMPTY.
    check(
      "jpir_narrowing_chk",
      sql`(${t.branchIds} IS NULL OR (jsonb_typeof(${t.branchIds}) = 'array'
          AND jsonb_array_length(${t.branchIds}) BETWEEN 1 AND 50
          AND NOT jsonb_path_exists(${t.branchIds}, '$[*] ? (@.type() != "number" || @ < 1 || @.floor() != @)')))
        AND (${t.courseIds} IS NULL OR (jsonb_typeof(${t.courseIds}) = 'array'
          AND jsonb_array_length(${t.courseIds}) BETWEEN 1 AND 100
          AND NOT jsonb_path_exists(${t.courseIds}, '$[*] ? (@.type() != "string" || !(@ like_regex "^.{1,64}$"))')))`,
    ),
    check(
      "jpir_content_hash_chk",
      sql`${t.contentHash} IS NULL OR ${t.contentHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
).enableRLS();

/** A targeting option's kind: an RVM branch (location id) or a Scheduler course. */
export const RVM_TARGETING_KINDS = ["branch", "course"] as const;
export type RvmTargetingKind = (typeof RVM_TARGETING_KINDS)[number];

/**
 * The branches and courses a company may target, with the labels shown to it (#2746 item 4).
 * Campus sets the list (`PUT targeting-options`). An option that leaves the list is marked
 * inactive, never deleted, so a posting that already targets it keeps its label; inactive
 * options are not offered for new targeting.
 *
 * `ref` is text for both kinds: a branch ref is an RVM location id (a positive integer, pinned
 * by `rto_branch_ref_chk`), a course ref is a Scheduler course id. Labels are reference data
 * (place and course names), never personal data.
 */
export const rvmTargetingOptions = pgTable(
  "rvm_targeting_options",
  {
    kind: text("kind").$type<RvmTargetingKind>().notNull(),
    ref: text("ref").notNull(),
    label: text("label").notNull(),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "rvm_targeting_options_pk", columns: [t.kind, t.ref] }),
    check("rto_kind_chk", sql`${t.kind} IN ('branch', 'course')`),
    check("rto_ref_chk", sql`char_length(${t.ref}) BETWEEN 1 AND 64`),
    check("rto_branch_ref_chk", sql`${t.kind} <> 'branch' OR ${t.ref} ~ '^[1-9][0-9]{0,9}$'`),
    check("rto_label_chk", sql`char_length(${t.label}) BETWEEN 1 AND 200`),
  ],
).enableRLS();
