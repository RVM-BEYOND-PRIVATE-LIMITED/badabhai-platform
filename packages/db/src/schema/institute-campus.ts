import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { applications, jobPostings } from "./job";
import { payers } from "./payer";
import { workers } from "./worker";
import type { InstituteCode } from "./institute-link";

// ---------------------------------------------------------------------------
// institute_search_grants — a named-company search grant (#2752 item 10).
//
// A company asked to see an institute student in its own search, the institute asked him, and he
// said yes. BadaBhai stores the grant only after reading that yes from the institute by
// `consent_ref`, for this company and this student; a "no", or a yes for another company, stores
// nothing. While the grant is live he appears in THAT company's search alone, and that company may
// open him (`InstituteOpenGate`).
//
// THE SEARCH ROW IS HERE, NOT IN `worker_skill`. The search builds a card from a skill; a student
// has none of his own, so the grant carries the one skill his course maps to
// (`@badabhai/taxonomy` instituteCourseMatchSkill) with its industry, both null when the course
// maps to none. Nothing is written to `worker_skill`, so no reach row, no feed card and nothing to
// remove when the grant ends.
//
// `grant_ref` is Campus's own id for the grant: the same ref again answers the row it made, for
// good. One live grant per company, worker and institute. A revoke stamps `revoked_at` and keeps
// the row. Cascades on worker and company deletion (DPDP). RLS forced, every role revoked (0163).
// ---------------------------------------------------------------------------

export const instituteSearchGrants = pgTable(
  "institute_search_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instituteCode: text("institute_code").$type<InstituteCode>().notNull(),
    grantRef: text("grant_ref").notNull(),
    payerId: uuid("payer_id")
      .notNull()
      .references(() => payers.id, { onDelete: "cascade" }),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    /** The institute's consent-request id the student's yes was read from. A code, never text. */
    consentRef: text("consent_ref").notNull(),
    /** The match skill his course maps to, and its industry: the card's lead role. */
    skillId: text("skill_id"),
    industryId: text("industry_id"),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("institute_search_grants_ref_uq").on(t.instituteCode, t.grantRef),
    uniqueIndex("institute_search_grants_live_uq")
      .on(t.payerId, t.workerId, t.instituteCode)
      .where(sql`${t.revokedAt} IS NULL`),
    index("institute_search_grants_worker_idx").on(t.workerId),
    check("institute_search_grants_institute_chk", sql`${t.instituteCode} IN ('rvm')`),
    check("institute_search_grants_ref_chk", sql`${t.grantRef} ~ '^[A-Za-z0-9._:-]{8,200}$'`),
    check(
      "institute_search_grants_consent_ref_chk",
      sql`${t.consentRef} ~ '^[A-Za-z0-9._:-]{8,200}$'`,
    ),
    check(
      "institute_search_grants_skill_pair_chk",
      sql`(${t.skillId} IS NULL) = (${t.industryId} IS NULL)`,
    ),
  ],
).enableRLS();

// ---------------------------------------------------------------------------
// institute_applications — an application that came from an institute's Campus (#2752 item 8).
//
// A SIDE TABLE, not an `external_ref` column on `applications`: every bare `select()` on
// `applications` names every model column, so a new column there would be APPLY-BEFORE-DEPLOY on
// the worker feed and the applicant lists.
//
// `external_ref` is the Campus application id, unique per institute for good: the same ref again
// answers the row it made. `application_id` points at the `applications` row the company sees;
// a withdrawal deletes that row (the company no longer sees him) and this row keeps the fact, so
// Campus's status feed can say `withdrawn` (`application_id` then goes null). `campus_applied_at`
// is information only: BadaBhai dates the application by its own clock. `updated_at` moves on
// every change Campus must learn about, and feeds `GET applications?changed_since=`.
// ---------------------------------------------------------------------------

export const instituteApplications = pgTable(
  "institute_applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instituteCode: text("institute_code").$type<InstituteCode>().notNull(),
    externalRef: text("external_ref").notNull(),
    applicationId: uuid("application_id").references(() => applications.id, {
      onDelete: "set null",
    }),
    jobPostingId: uuid("job_posting_id")
      .notNull()
      .references(() => jobPostings.id, { onDelete: "cascade" }),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    /**
     * True when THIS record created the `applications` row. A student who had already applied
     * from the worker app keeps that row on a Campus withdrawal: only a row Campus made is removed.
     */
    ownsApplication: boolean("owns_application").notNull().default(false),
    campusAppliedAt: timestamp("campus_applied_at", { withTimezone: true }),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("institute_applications_ref_uq").on(t.instituteCode, t.externalRef),
    // One LIVE Campus record per student and posting; after a withdrawal he may apply again.
    uniqueIndex("institute_applications_live_uq")
      .on(t.instituteCode, t.workerId, t.jobPostingId)
      .where(sql`${t.withdrawnAt} IS NULL`),
    index("institute_applications_feed_idx").on(t.instituteCode, t.updatedAt, t.id),
    index("institute_applications_worker_idx").on(t.workerId),
    check("institute_applications_institute_chk", sql`${t.instituteCode} IN ('rvm')`),
    check("institute_applications_ref_chk", sql`${t.externalRef} ~ '^[A-Za-z0-9._:-]{8,200}$'`),
    check(
      "institute_applications_withdrawn_chk",
      sql`${t.withdrawnAt} IS NULL OR ${t.applicationId} IS NULL`,
    ),
  ],
).enableRLS();

export type InstituteSearchGrantRow = typeof instituteSearchGrants.$inferSelect;
export type InstituteApplicationRow = typeof instituteApplications.$inferSelect;

// ---------------------------------------------------------------------------
// institute_companies — a company an institute's placement team created on BadaBhai (#2752 item 5).
//
// `POST job-postings` from Campus may publish ONLY for a company it created itself (owner decision
// taken 2026-11-14 on the security review): an existing BadaBhai company posts for RVM students
// itself, from its own account, so a Campus credential can never publish in another employer's
// name. This row is the proof of "created by Campus", and `GET companies?phone=` answers only
// these. The company is created `pending`; its owner activates it by signing in with a code.
// The Campus staff member who created it is in `audit_logs` (`campus_link.company_created`).
// ---------------------------------------------------------------------------

export const instituteCompanies = pgTable(
  "institute_companies",
  {
    payerId: uuid("payer_id")
      .primaryKey()
      .references(() => payers.id, { onDelete: "cascade" }),
    instituteCode: text("institute_code").$type<InstituteCode>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("institute_companies_institute_chk", sql`${t.instituteCode} IN ('rvm')`)],
).enableRLS();
