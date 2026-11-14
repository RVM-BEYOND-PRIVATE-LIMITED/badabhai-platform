import { z } from "zod";
import { VACANCY_BANDS } from "@badabhai/types";
import type { JobPayType, JobShift } from "@badabhai/db";
import { isCanonicalUuid } from "../common/uuid";
import {
  hasForbiddenIdCharacter,
  hasForbiddenLabelCharacter,
  hasVisibleCharacter,
} from "./campus-characters";

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
  /**
   * #2746: the posting changed after the reviewer saw it: its `content_hash` moved, or its review
   * went back to pending (a company edit) after the decision was made. Nothing was stored;
   * re-fetch the posting and re-review it.
   */
  "POSTING_CHANGED",
  /**
   * #2746: a newer decision (`decided_at`) or list (`as_of`) is already held, or one at the same
   * instant that differs. Nothing was stored; do not retry this body, and do not re-review: the
   * newer decision stands.
   */
  "DECISION_SUPERSEDED",
] as const;
export type CampusErrorCode = (typeof CAMPUS_ERROR_CODES)[number];

/**
 * #2746 — how far AHEAD of BadaBhai's clock a Campus `decided_at` / `as_of` may be. Further ahead
 * is 400 `VALIDATION_FAILED`: a time from the future would outrank every later decision, and a
 * Campus clock that far ahead would lock out corrections for that long.
 */
export const CAMPUS_MAX_CLOCK_SKEW_MS = 60 * 1000;

/**
 * #2746 — the tolerance of the review's RESET FLOOR: a review row that went back to pending (a
 * company edit's reset) refuses a decision dated more than this before it went back, with 409
 * `POSTING_CHANGED` (re-fetch and re-review). It covers Campus's clock running BEHIND BadaBhai's
 * plus the decision's delivery delay, so a Campus clock a few minutes slow cannot lock a posting
 * out of review. Separate from {@link CAMPUS_MAX_CLOCK_SKEW_MS}, which bounds running ahead.
 */
export const CAMPUS_RESET_FLOOR_TOLERANCE_MS = 10 * 60 * 1000;

/**
 * #2746 — the earliest `decided_at` / `as_of` BadaBhai accepts: before the link existed, so no
 * real decision is older. Earlier is 400 `VALIDATION_FAILED` (a year-0000 time parses in
 * JavaScript but not as a Postgres `timestamptz`).
 */
export const CAMPUS_EARLIEST_DECISION_TIME = "2026-01-01T00:00:00.000Z";

// ─── Primitives ──────────────────────────────────────────────────────────────

/** Same charset and band Campus writes (its outbox row id), so one value can serve as both. */
export const CampusIdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{8,200}$/);

/** A Campus-side id BadaBhai stores verbatim: an application id, a grant id, a consent id. */
export const CampusExternalRefSchema = CampusIdempotencyKeySchema;

/**
 * The hand-off token's `sub`: the Student API account uuid. Text up to 128 characters on both
 * sides; the uuid shape check is one refine, so relaxing it is a one-line change. Lower-cased,
 * because the uuid check ignores case and the stored reference is unique as written.
 */
export const StudentRefSchema = z
  .string()
  .max(128)
  .refine(isCanonicalUuid, "must be a uuid")
  .transform((ref) => ref.toLowerCase());

/** A Campus staff member (reviewer or poster). Stored as a reference, never resolved here. */
export const StaffRefSchema = z.string().max(128).refine(isCanonicalUuid, "must be a uuid");

/** Ten digits starting 6 to 9. BadaBhai hashes it as +91 E.164, the form every row is keyed on. */
export const Phone10Schema = z.string().regex(/^[6-9]\d{9}$/);

/** An RVM location id: the same number as Campus's `allowed_location_ids`. */
export const BranchIdSchema = z.number().int().positive();

/**
 * A Scheduler course id. Matching happens on the id once the Student API returns one. Trimmed;
 * no control, format, surrogate, private-use, unassigned or separator character, except a plain
 * ASCII space inside the id (`hasForbiddenIdCharacter`, `./campus-characters`). A NUL would reach
 * Postgres and fail the row (22021); a lone surrogate is rewritten to U+FFFD by the driver, so two
 * distinct ids would collapse into one key. Deliberately no charset beyond that: the Scheduler's
 * id format is not confirmed.
 */
export const CourseIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(
    (id) => !hasForbiddenIdCharacter(id),
    "no control, format, separator (but a plain space), surrogate, private-use or unassigned characters",
  );

/**
 * The largest UTC offset a Campus time may carry: ±14:00, the widest real one (UTC+14, Line
 * Islands). zod and V8 accept up to ±23:59, but Postgres refuses past ±15:59 (22009, a 500), so a
 * wider offset is a 400 here, on every Campus time field (`decided_at`, `as_of`, `changed_since`,
 * `applied_at` and every `changed_at`).
 */
const MAX_OFFSET_MINUTES = 14 * 60;

/** The offset of an ISO 8601 time, in minutes: `Z` is 0; `±HH`, `±HHMM` and `±HH:MM` are read. */
function offsetMinutes(value: string): number {
  const match = /([+-])(\d{2})(?::?(\d{2}))?$/.exec(value);
  if (match === null) return 0;
  return Number(match[2]) * 60 + Number(match[3] ?? "0");
}

const IsoDateTime = z
  .string()
  .datetime({ offset: true })
  .refine(
    (value) => offsetMinutes(value) <= MAX_OFFSET_MINUTES,
    "the UTC offset must be within +14:00 and -14:00",
  );
const Id = z.string().uuid();

/**
 * #2746 — what a review decision is FOR: the sha256 (lower-case hex) of every field an RVM student
 * sees, computed by BadaBhai (`postingReviewContentHash`). The feed exposes it, the review echoes
 * it; Campus never computes it. Opaque: it changes whenever the posting's student-visible content
 * does, and when BadaBhai changes what the hash covers.
 */
export const ContentHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

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
  /**
   * The hash of the content above, as of this read (#2746, owner decision 2026-11-14). Send it back
   * unchanged on `PUT job-postings/:id/review`: a decision counts only for the content its reviewer
   * saw, and a posting that changed since answers 409 `POSTING_CHANGED`.
   */
  content_hash: ContentHashSchema,
});

export const CampusPostingPageSchema = z.object({
  postings: z.array(CampusPostingSchema),
  next_cursor: Cursor.nullable(),
});

// ─── PUT job-postings/:id/review ─────────────────────────────────────────────

/**
 * A narrowed branch or course list replaces the posting's own, for RVM students only. Non-empty
 * when sent: an empty list means "every branch", so it would widen, not narrow (the database's
 * `jpir_narrowing_chk` holds the same line).
 */
export const CampusReviewBodySchema = z.strictObject({
  state: z.enum(["approved", "rejected"]),
  reviewer_ref: StaffRefSchema,
  branch_ids: z.array(BranchIdSchema).min(1).max(50).optional(),
  course_ids: z.array(CourseIdSchema).min(1).max(100).optional(),
  reason: z.string().trim().min(1).max(500).optional(),
  /**
   * REQUIRED (owner decision 2026-11-14): the posting's `content_hash` from the feed read the
   * reviewer decided on. BadaBhai compares it with the posting's hash under a row lock; a mismatch
   * is 409 `POSTING_CHANGED` and stores nothing, so an approval never lands on content nobody saw.
   */
  content_hash: ContentHashSchema,
  /**
   * REQUIRED (owner decision 2026-11-14): when the reviewer decided, by Campus's clock. The row
   * keeps the newest decision only: a decision older than the one held, or one at the same
   * instant that differs, is 409 `DECISION_SUPERSEDED`; the same decision again is a replay. On a
   * review that went back to pending (a company edit), one dated more than
   * `CAMPUS_RESET_FLOOR_TOLERANCE_MS` before it went back is 409 `POSTING_CHANGED`. Before
   * `CAMPUS_EARLIEST_DECISION_TIME`, or more than `CAMPUS_MAX_CLOCK_SKEW_MS` ahead of BadaBhai's
   * clock, is 400 `VALIDATION_FAILED`.
   */
  decided_at: IsoDateTime,
});

export const CampusReviewResponseSchema = z.object({
  posting_id: Id,
  review_state: z.enum(REVIEW_STATES),
  /** The decision's `decided_at`, echoed: BadaBhai stores Campus's decision time as the review time. */
  reviewed_at: IsoDateTime,
});

// ─── PUT targeting-options (#2746) ───────────────────────────────────────────

/**
 * The bounds of one targeting list. Chosen so the LARGEST valid body, in plain UTF-8, fits the
 * api's 100 kB JSON limit (Express's default): 50 branches (the most a posting may target) and
 * 100 courses (likewise), each label up to 150 characters, each course id up to 64. Every Indian
 * script character is 3 bytes, so the worst case is about 90 kB. `rto_label_chk` allows 200; the
 * body stops at 150 for the size bound.
 */
export const CAMPUS_TARGETING_LIMITS = {
  branches: 50,
  courses: 100,
  labelLength: 150,
  /** `rvm_targeting_options.ref` holds a branch id as at most ten digits (`rto_branch_ref_chk`). */
  maxBranchId: 9_999_999_999,
} as const;

/**
 * A place or course name as companies see it: reference data, never personal data (`rto_label_chk`).
 * Shown verbatim, so no control, format, surrogate, private-use, unassigned, line or paragraph
 * separator character, except ZWNJ / ZWJ, which Indic spellings need (`hasForbiddenLabelCharacter`).
 * Spaces are allowed.
 */
const TargetingLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(CAMPUS_TARGETING_LIMITS.labelLength)
  .refine(
    (label) => !hasForbiddenLabelCharacter(label),
    "no control, format (but ZWNJ/ZWJ), surrogate, private-use, unassigned or line-separator characters",
  )
  .refine(hasVisibleCharacter, "at least one visible character");

const TargetingBranchSchema = z.strictObject({
  id: BranchIdSchema.max(CAMPUS_TARGETING_LIMITS.maxBranchId),
  name: TargetingLabelSchema,
});

/** The course id is the shared `CourseIdSchema`, so a review narrowing and an option agree. */
const TargetingCourseSchema = z.strictObject({
  id: CourseIdSchema,
  name: TargetingLabelSchema,
});

/** True when no two entries share an id. */
function idsUnique(entries: readonly { id: number | string }[]): boolean {
  return new Set(entries.map((e) => e.id)).size === entries.length;
}

/**
 * THE WHOLE CURRENT LIST of branches and courses a company may target. Campus sends every option
 * it offers, each time; the position in its list is the order companies see. An option BadaBhai
 * holds that is not in the list is marked inactive, never deleted, because postings hold the refs.
 * Both lists are required and NON-EMPTY (an applied list must stamp at least one row, the
 * high-water mark below; to retire an option, leave it out of a list that still names another);
 * an id appears at most once in its list.
 *
 * `as_of` (REQUIRED): when Campus read this list, by its clock. A list is applied only when it is
 * newer than the last one applied; an older or same-instant list that differs from what is held is
 * 409 `DECISION_SUPERSEDED`, so a late retry never puts back an option Campus has since removed.
 * Before `CAMPUS_EARLIEST_DECISION_TIME`, or more than `CAMPUS_MAX_CLOCK_SKEW_MS` ahead of
 * BadaBhai's clock, is 400 `VALIDATION_FAILED`.
 */
export const CampusTargetingOptionsBodySchema = z.strictObject({
  branches: z
    .array(TargetingBranchSchema)
    .min(1)
    .max(CAMPUS_TARGETING_LIMITS.branches)
    .refine(idsUnique, "each branch id at most once"),
  courses: z
    .array(TargetingCourseSchema)
    .min(1)
    .max(CAMPUS_TARGETING_LIMITS.courses)
    .refine(idsUnique, "each course id at most once"),
  as_of: IsoDateTime,
});

/** What one kind's replacement did. `listed` is the number now active. */
export const CampusTargetingOptionCountsSchema = z.object({
  listed: z.number().int().min(0),
  added: z.number().int().min(0),
  /** Label or order changed, or the option came back after being inactive. */
  updated: z.number().int().min(0),
  /** Left the list: inactive now, kept for the postings that target it. */
  deactivated: z.number().int().min(0),
});

export const CampusTargetingOptionsResponseSchema = z.object({
  branches: CampusTargetingOptionCountsSchema,
  courses: CampusTargetingOptionCountsSchema,
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
