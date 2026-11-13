import { z } from "zod";
import { VACANCY_BANDS } from "@badabhai/types";
import type { JobPayType, JobShift } from "@badabhai/db";
import { isCanonicalUuid } from "../common/uuid";

/**
 * THE CAMPUS LINK CONTRACT, v1 (#2752 item 1): every route BadaBhai Campus calls under
 * `/internal/campus/v1`, as zod schemas. BadaBhai publishes these; Campus's
 * `lib/integrations/contracts/badabhai.ts` follows them. The prose version, with examples and
 * the decisions behind each shape, is `docs/api/campus-link-v1-api-reference.md`.
 *
 * REQUESTS ARE STRICT, RESPONSES ARE OPEN. A request body with an unknown key is a 400: a caller
 * that sends a field we do not read is a caller whose intent we would silently ignore. A
 * response may gain fields in a later release without a version bump, so a client must ignore
 * keys it does not know; removing or retyping a field is a v2.
 *
 * ONE DIRECTION. Campus calls BadaBhai for everything here, including the status of its
 * applications (the `GET applications` feed): BadaBhai holds no Campus credential for these
 * routes and pushes nothing. The one call the other way, the short-lived résumé link, is #2747's.
 */

export const CAMPUS_LINK_BASE_PATH = "internal/campus/v1";

/** Campus's service token. The same header RVM's Student API takes (Scheduler_Backend#162). */
export const CAMPUS_SERVICE_TOKEN_HEADER = "x-service-token";

/** Required on every POST, PUT and DELETE. */
export const CAMPUS_IDEMPOTENCY_KEY_HEADER = "idempotency-key";

/** Set on every authenticated answer: the id of this call's `audit_logs` row, for correlation. */
export const CAMPUS_CALL_ID_HEADER = "x-campus-call-id";

/** The `error.code` values a Campus route answers with. A 404 carries none: it is neutral. */
export const CAMPUS_ERROR_CODES = [
  "ADDRESS_NOT_ALLOWED",
  "UNAUTHENTICATED",
  "RATE_LIMITED",
  "VALIDATION_FAILED",
  "IDEMPOTENCY_KEY_REQUIRED",
  "EXTERNAL_REF_CONFLICT",
  "POSTING_NOT_OPEN",
  "POSTING_NOT_APPROVED",
  "AUDIENCE_EXCLUDES_RVM",
  "STUDENT_NOT_AVAILABLE",
  "RVM_UNAVAILABLE",
] as const;
export type CampusErrorCode = (typeof CAMPUS_ERROR_CODES)[number];

// ─── Primitives ──────────────────────────────────────────────────────────────

/** Same charset and band Campus writes (its outbox row id), so one value can serve as both. */
export const CampusIdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{8,200}$/);

/** A Campus-side id BadaBhai stores verbatim: an application id, a grant id, a consent id. */
export const CampusExternalRefSchema = CampusIdempotencyKeySchema;

/**
 * The hand-off token's `sub`: the Student API account uuid. Text up to 128 characters on both
 * sides; the uuid shape check is one refine, so relaxing it is a one-line change.
 */
export const StudentRefSchema = z.string().max(128).refine(isCanonicalUuid, "must be a uuid");

/** A Campus staff member (reviewer or poster). Stored as a reference, never resolved here. */
export const StaffRefSchema = z.string().max(128).refine(isCanonicalUuid, "must be a uuid");

/** Ten digits starting 6 to 9. BadaBhai hashes it as +91 E.164, the form every row is keyed on. */
export const Phone10Schema = z.string().regex(/^[6-9]\d{9}$/);

/** An RVM location id: the same number as Campus's `allowed_location_ids`. */
export const BranchIdSchema = z.number().int().positive();

/** A Scheduler course id. Matching happens on the id once the Student API returns one. */
export const CourseIdSchema = z.string().min(1).max(64);

const IsoDateTime = z.string().datetime({ offset: true });
const Id = z.string().uuid();

export const POSTING_AUDIENCES = ["rvm_students", "both"] as const;
export const REVIEW_STATES = ["pending", "approved", "rejected"] as const;
const PAY_TYPES = ["in_hand", "gross", "ctc"] as const satisfies readonly JobPayType[];
const SHIFTS = ["day", "night", "rotational"] as const satisfies readonly JobShift[];

/**
 * An application's stage as Campus sees it. `new`, `shortlist` and `passed` exist today; `selected`
 * and `hired` arrive with #2747 and `withdrawn` with the DELETE below. Campus maps `passed` to its
 * own `rejected`.
 */
export const CAMPUS_APPLICATION_STAGES = [
  "new",
  "shortlist",
  "selected",
  "hired",
  "passed",
  "withdrawn",
] as const;

const PageLimit = z.coerce.number().int().min(1).max(200).default(100);
const Cursor = z.string().min(1).max(512);

// ─── GET ping ────────────────────────────────────────────────────────────────

/** Proves the token, the address and the flag. Read-only; audited like every call. */
export const CampusPingResponseSchema = z.object({ ok: z.literal(true), call_id: Id });

// ─── GET job-postings ────────────────────────────────────────────────────────

export const CampusPostingsQuerySchema = z.strictObject({
  review_state: z.enum(REVIEW_STATES).optional(),
  branch_id: z.coerce.number().int().positive().optional(),
  course_id: CourseIdSchema.optional(),
  /** Postings changed at or after this instant, closed ones included, so Campus sees a close. */
  changed_since: IsoDateTime.optional(),
  cursor: Cursor.optional(),
  limit: PageLimit,
});

export const CampusPostingSchema = z.object({
  id: Id,
  /** `name` is the company's display label, the one students see on Campus today. */
  company: z.object({ id: Id, name: z.string() }),
  title: z.string(),
  description: z.string().nullable(),
  location: z.object({
    label: z.string().nullable(),
    city: z.string().nullable(),
    state: z.string().nullable(),
    area: z.string().nullable(),
  }),
  pay: z.object({
    min: z.number().int().nullable(),
    max: z.number().int().nullable(),
    type: z.enum(PAY_TYPES).nullable(),
  }),
  vacancy_band: z.enum(VACANCY_BANDS),
  shift: z.enum(SHIFTS).nullable(),
  experience_years: z.object({
    min: z.number().int().nullable(),
    max: z.number().int().nullable(),
  }),
  requirements: z.array(z.string()),
  benefits: z.array(z.string()),
  /** `open` takes applications (once approved); everything else is `closed` to Campus. */
  status: z.enum(["open", "closed"]),
  audience: z.enum(POSTING_AUDIENCES),
  /** Empty means every branch. */
  branch_ids: z.array(BranchIdSchema),
  /** Empty means every course. The name is for display and for matching until ids are shared. */
  courses: z.array(z.object({ id: CourseIdSchema, name: z.string() })),
  review_state: z.enum(REVIEW_STATES),
  changed_at: IsoDateTime,
});

export const CampusPostingPageSchema = z.object({
  postings: z.array(CampusPostingSchema),
  next_cursor: Cursor.nullable(),
});

// ─── PUT job-postings/:id/review ─────────────────────────────────────────────

/** A narrowed branch or course list replaces the posting's own, for RVM students only. */
export const CampusReviewBodySchema = z.strictObject({
  state: z.enum(["approved", "rejected"]),
  reviewer_ref: StaffRefSchema,
  branch_ids: z.array(BranchIdSchema).max(50).optional(),
  course_ids: z.array(CourseIdSchema).max(100).optional(),
  reason: z.string().trim().min(1).max(500).optional(),
});

export const CampusReviewResponseSchema = z.object({
  posting_id: Id,
  review_state: z.enum(REVIEW_STATES),
  reviewed_at: IsoDateTime,
});

// ─── POST job-postings (the placement team posts for a company) ──────────────

export const CampusPostForCompanyBodySchema = z.strictObject({
  /**
   * Found by exact phone, or created as a pending company that its owner activates by code.
   * OPEN OWNER DECISION before this route is built: whether Campus may publish in the name of an
   * EXISTING active company without that company confirming (a leaked Campus token could then post
   * as any employer whose phone it knows). See the API reference, "Open decisions".
   */
  company: z.strictObject({
    phone: Phone10Schema,
    name: z.string().trim().min(1).max(200),
  }),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(20_000),
  city: z.string().trim().min(1).max(100),
  state: z.string().trim().min(1).max(100).optional(),
  location_label: z.string().trim().min(1).max(300).optional(),
  /** Stored as the matching `vacancy_band`. */
  openings: z.number().int().min(1).max(1000),
  pay: z
    .strictObject({
      min: z.number().int().min(0).optional(),
      max: z.number().int().min(0).optional(),
      type: z.enum(PAY_TYPES),
    })
    .refine((p) => p.min === undefined || p.max === undefined || p.max >= p.min, {
      message: "max must be at least min",
      path: ["max"],
    })
    .optional(),
  branch_ids: z.array(BranchIdSchema).max(50),
  course_ids: z.array(CourseIdSchema).max(100),
  staff_ref: StaffRefSchema,
});

/** The posting goes live for RVM students at once, its review recorded as approved by `staff_ref`. */
export const CampusPostForCompanyResponseSchema = z.object({
  posting_id: Id,
  company_id: Id,
  company_created: z.boolean(),
  review_state: z.literal("approved"),
});

// ─── GET companies ───────────────────────────────────────────────────────────

export const CampusCompanyQuerySchema = z.strictObject({ phone: Phone10Schema });

export const CampusCompanyResponseSchema = z.object({
  company: z.object({ id: Id, name: z.string(), status: z.enum(["active", "pending"]) }).nullable(),
});

// ─── POST / GET / DELETE applications ────────────────────────────────────────

/**
 * Idempotent on `external_ref` (the Campus application id), for good: the same ref again answers
 * the row it made. The same ref with a different posting or student is EXTERNAL_REF_CONFLICT.
 * BadaBhai reads the student's fields from RVM itself, so nothing about him travels here.
 */
export const CampusApplyBodySchema = z.strictObject({
  external_ref: CampusExternalRefSchema,
  posting_id: Id,
  student_ref: StudentRefSchema,
  /** Kept as information only. BadaBhai orders and dates applications by its own clock. */
  applied_at: IsoDateTime.optional(),
});

export const CampusApplicationSchema = z.object({
  application_id: Id,
  external_ref: CampusExternalRefSchema,
  posting_id: Id,
  student_ref: StudentRefSchema,
  stage: z.enum(CAMPUS_APPLICATION_STAGES),
  changed_at: IsoDateTime,
});

/** The status feed Campus polls instead of receiving a push. */
export const CampusApplicationsQuerySchema = z.strictObject({
  changed_since: IsoDateTime.optional(),
  cursor: Cursor.optional(),
  limit: PageLimit,
});

export const CampusApplicationPageSchema = z.object({
  applications: z.array(CampusApplicationSchema),
  next_cursor: Cursor.nullable(),
});

// ─── PUT / DELETE search-grants/:grant_ref ───────────────────────────────────

/**
 * After the student's own yes, read from RVM by `consent_ref` before the grant is stored. The
 * consent RVM returns must name this same `student_ref` and this same company; any mismatch is
 * STUDENT_NOT_AVAILABLE and no row, so one consent can never be replayed for another company.
 */
export const CampusSearchGrantBodySchema = z.strictObject({
  company_id: Id,
  student_ref: StudentRefSchema,
  consent_ref: CampusExternalRefSchema,
});

export const CampusSearchGrantSchema = z.object({
  grant_ref: CampusExternalRefSchema,
  company_id: Id,
  student_ref: StudentRefSchema,
  state: z.enum(["active", "revoked"]),
  changed_at: IsoDateTime,
});

// ─── DELETE students/:student_ref ────────────────────────────────────────────

export const CampusUnlinkResponseSchema = z.object({
  student_ref: StudentRefSchema,
  state: z.literal("unlinked"),
});

// ─── Errors ──────────────────────────────────────────────────────────────────

/** The api's one error envelope (`AllExceptionsFilter`), with Campus's `code` inside `error`. */
export const CampusErrorBodySchema = z.object({
  statusCode: z.number().int(),
  error: z.object({ code: z.enum(CAMPUS_ERROR_CODES).optional(), message: z.unknown().optional() }),
  requestId: z.string().optional(),
  path: z.string(),
  timestamp: z.string(),
});
