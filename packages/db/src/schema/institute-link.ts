import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { workers } from "./worker";

// ---------------------------------------------------------------------------
// worker_institute_links — a BadaBhai worker who is an institute's student (#2752 item 6).
//
// One row per linked worker. The institute's own reference for the student (`student_ref`, the
// hand-off token's `sub`) is the key the institute calls us with; the worker row behind it is the
// one `WorkersRepository.createOrGetByPhoneHash` finds or creates, so one phone stays one person.
//
// WHAT IS COPIED, AND WHAT NEVER IS. Name and phone live where every worker's do: encrypted on
// `workers`. The only institute facts held here are the agreed plain ones (brief 4D.6): course,
// branch, current-student-or-alumnus as the institute sends it, and the test score. Fee status,
// attendance, documents, date of birth, batch and every other institute record are never stored.
// An unlink erases the copied facts (nulls them) and keeps only the reference and the dates.
//
// CONSENT. The institute's consent ("share my profile with companies I apply to") is recorded
// HERE, never in `worker_consents`: a row there would satisfy `ConsentGuard` and
// `hasActiveConsent()` and let the worker app skip BadaBhai's own notice.
//
// `worker_id` cascades on worker deletion (DPDP). RLS forced, every role revoked (migration 0161).
// ---------------------------------------------------------------------------

/** Institutes BadaBhai links with. One today; the code column is what lets another join later. */
export const INSTITUTE_CODES = ["rvm"] as const;
export type InstituteCode = (typeof INSTITUTE_CODES)[number];

export const INSTITUTE_LINK_STATUSES = ["active", "withdrawn"] as const;
export type InstituteLinkStatus = (typeof INSTITUTE_LINK_STATUSES)[number];

/** Stored exactly as the institute's Student API sends it; BadaBhai computes no alumni status. */
export const INSTITUTE_STUDENT_STATUSES = ["current_student", "alumnus"] as const;
export type InstituteStudentStatus = (typeof INSTITUTE_STUDENT_STATUSES)[number];

/** The longest `student_ref` stored (the hand-off keeps it as text up to 128 characters). */
export const INSTITUTE_STUDENT_REF_MAX_LENGTH = 128;

export const workerInstituteLinks = pgTable(
  "worker_institute_links",
  {
    workerId: uuid("worker_id")
      .primaryKey()
      .references(() => workers.id, { onDelete: "cascade" }),
    instituteCode: text("institute_code").$type<InstituteCode>().notNull(),
    /** The institute's id for the student. A uuid today; the shape is checked in code, not here. */
    studentRef: text("student_ref").notNull(),
    status: text("status").$type<InstituteLinkStatus>().notNull().default("active"),
    studentStatus: text("student_status").$type<InstituteStudentStatus>(),
    course: text("course"),
    branch: text("branch"),
    /** The course average the institute reports; null until it reports one. */
    testScore: numeric("test_score", { precision: 5, scale: 2 }),
    /**
     * Text version and time of the institute's consent line as the student accepted it, once the
     * Student API reports them (its six-field read does not yet; open point on #162).
     */
    consentVersion: text("consent_version"),
    consentAt: timestamp("consent_at", { withTimezone: true }),
    /** False until he signs in to the worker app: the in-app relay cannot reach him before. */
    appReachable: boolean("app_reachable").notNull().default(false),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * The last successful read from the institute's Student API. The API answers only while his
     * consent is in force, so this is also when that consent was last confirmed.
     */
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("worker_institute_links_ref_uq").on(t.instituteCode, t.studentRef),
    check("worker_institute_links_institute_chk", sql`${t.instituteCode} IN ('rvm')`),
    check("worker_institute_links_status_chk", sql`${t.status} IN ('active', 'withdrawn')`),
    // A withdrawn link is dated; an active one is not.
    check(
      "worker_institute_links_withdrawn_pair_chk",
      sql`(${t.status} = 'withdrawn') = (${t.withdrawnAt} IS NOT NULL)`,
    ),
    // No active link without a consent confirmed by the Student API (a successful read).
    check(
      "worker_institute_links_active_confirmed_chk",
      sql`${t.status} <> 'active' OR ${t.syncedAt} IS NOT NULL`,
    ),
    check(
      "worker_institute_links_student_status_chk",
      sql`${t.studentStatus} IS NULL OR ${t.studentStatus} IN ('current_student', 'alumnus')`,
    ),
    check(
      "worker_institute_links_student_ref_chk",
      sql`char_length(${t.studentRef}) BETWEEN 1 AND 128`,
    ),
    check(
      "worker_institute_links_test_score_chk",
      sql`${t.testScore} IS NULL OR (${t.testScore} >= 0 AND ${t.testScore} <= 100)`,
    ),
  ],
).enableRLS();

// ---------------------------------------------------------------------------
// worker_origins — where a worker came from (#2752 item 11), written once, first touch wins.
//
// A side table rather than columns on `workers`: every bare `select()` on `workers` names every
// model column, so a new column there is APPLY-BEFORE-DEPLOY on the sign-in path. A new table is
// safe to deploy before it exists as long as nothing reads it until it is applied.
//
// No row means organic. #2752 writes `institute` / `rvm`; #2753 writes `partner` and `referrer`.
// `worker_id` cascades on worker deletion (DPDP). RLS forced, every role revoked (migration 0161).
// ---------------------------------------------------------------------------

export const WORKER_ORIGIN_KINDS = [
  "organic",
  "institute",
  "partner",
  "referrer",
  "agency",
  "import",
] as const;
export type WorkerOriginKind = (typeof WORKER_ORIGIN_KINDS)[number];

export const workerOrigins = pgTable(
  "worker_origins",
  {
    workerId: uuid("worker_id")
      .primaryKey()
      .references(() => workers.id, { onDelete: "cascade" }),
    kind: text("kind").$type<WorkerOriginKind>().notNull(),
    /**
     * The code that brought him (the institute code, a partner or referrer code). A code, never
     * free text: the CHECK keeps a name or a phone number from landing here in plain text.
     */
    ref: text("ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "worker_origins_kind_chk",
      sql`${t.kind} IN ('organic', 'institute', 'partner', 'referrer', 'agency', 'import')`,
    ),
    check("worker_origins_ref_chk", sql`${t.ref} IS NULL OR ${t.ref} ~ '^[A-Za-z0-9._:-]{1,200}$'`),
  ],
).enableRLS();
