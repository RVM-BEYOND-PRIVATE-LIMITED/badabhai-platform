import { z } from "zod";
import { LAUNCH_TEST_PAYMENT_LINK_REF_MAX, LAUNCH_TEST_SHARES_MAX } from "@badabhai/db";
import { LAUNCH_TEST_RESULTS, type LaunchTestResult } from "@badabhai/types";
import { e164PhoneSchema } from "@badabhai/validators";
import { containsHardIdentifier } from "../../common/hard-identifier";
import {
  NUMBERS_LAUNCH_CITY_GROUPS,
  NUMBERS_LAUNCH_TRADE_GROUPS,
  NUMBERS_OTHER_GROUP,
} from "../numbers/groups";
import type {
  ContactsPerHireHire,
  ContactsPerHireTotals,
  LaunchTestOrderRefusal,
  LaunchTestPortalRefusal,
  LaunchTestStateRefusal,
  RefusedWorker,
} from "./launch-test-rules";

/**
 * #2755 part D — the wire contract of `/admin/launch-tests/*`, the two pre-launch tests' records.
 *
 *   GET   /admin/launch-tests/cohort              launch test A: the factories, a keyset page
 *   POST  /admin/launch-tests/cohort              record a factory with the profiles sent to it
 *   PATCH /admin/launch-tests/cohort/:id          its link, result, account and paid order
 *   GET   /admin/launch-tests/contacts-per-hire   launch test B: contacts opened per early hire
 *
 * Every body is `.strict()`. Ids are uuids, times ISO-8601 with an offset, codes closed sets.
 * Both writes take the numbers screen's REQUIRED `Idempotency-Key` header (part A's
 * `NumbersIdempotencyKey`).
 */

// -----------------------------------------------------------------------------------------------
// Shared fields
// -----------------------------------------------------------------------------------------------

const id = z.string().uuid();
const instant = z
  .string()
  .datetime({ offset: true })
  .transform((s) => new Date(s));

/** Part A's groups a factory can be recorded under: a launch group, or `other`. */
export const LAUNCH_TEST_CITY_GROUPS = [
  ...NUMBERS_LAUNCH_CITY_GROUPS,
  NUMBERS_OTHER_GROUP,
] as const;
export const LAUNCH_TEST_TRADE_GROUPS = [
  ...NUMBERS_LAUNCH_TRADE_GROUPS,
  NUMBERS_OTHER_GROUP,
] as const;

/** The longest factory name, in characters. */
export const LAUNCH_TEST_FACTORY_NAME_MAX = 200;

/**
 * The factory's name, as the desk types it: trimmed, 1 to 200 characters, no control or format
 * characters, and never a phone number, an email or another hard identifier (the name must not
 * become a contact sink; the phone has its own field).
 */
export const FactoryNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(LAUNCH_TEST_FACTORY_NAME_MAX)
  .refine((v) => !/[\p{Cc}\p{Cf}]/u.test(v), { message: "Name must be plain text" })
  .refine((v) => containsHardIdentifier(v) === null, {
    message: "Name must not contain a phone number, an email or another hard identifier",
  });

/**
 * The payment link's id or URL, as the desk created it with the provider: 1 to 300 printable
 * ASCII characters with no space (`launch_test_cohort_link_ref_chk` holds the length too).
 */
export const PaymentLinkRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(LAUNCH_TEST_PAYMENT_LINK_REF_MAX)
  .regex(/^[!-~]+$/, "A link reference is printable ASCII with no spaces");

// -----------------------------------------------------------------------------------------------
// GET /admin/launch-tests/cohort
// -----------------------------------------------------------------------------------------------

/**
 * The page bound equals the identity layer's response bound (`ADMIN_IDENTITY_MAX_SUBJECTS`, 50), so
 * a permitted admin always gets a whole named page rather than none.
 */
export const LAUNCH_TEST_COHORT_PAGE_MAX = 50;

export const AdminLaunchTestCohortQuerySchema = z
  .object({
    cursor: z.string().min(1).max(256).optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(LAUNCH_TEST_COHORT_PAGE_MAX)
      .optional()
      .default(LAUNCH_TEST_COHORT_PAGE_MAX),
  })
  .strict();
export type AdminLaunchTestCohortQueryDto = z.infer<typeof AdminLaunchTestCohortQuerySchema>;

/** One factory of launch test A. */
export interface AdminLaunchTestFactoryView {
  id: string;
  /**
   * The factory's name. PRESENT only when the caller holds `read_identity` and the name budget
   * allows (through `AdminIdentityService`, audited before the decrypt); ABSENT otherwise.
   */
  factory_name?: string | null;
  /** Whether a phone was recorded. The phone itself is never returned. */
  has_phone: boolean;
  city_group: string;
  trade_group: string;
  /** The factory's BadaBhai account, when it has one. */
  payer_id: string | null;
  sent_by_admin_id: string;
  sent_at: Date;
  payment_link_ref: string | null;
  link_created_at: Date | null;
  result: LaunchTestResult;
  paid_at: Date | null;
  payment_order_id: string | null;
  /** How many worker profiles were sent (at most 5). */
  share_count: number;
  /** The workers sent, oldest share first. */
  worker_ids: string[];
  created_at: Date;
  updated_at: Date;
  updated_by_admin_id: string;
}

export interface AdminLaunchTestCohortPage {
  rows: AdminLaunchTestFactoryView[];
  /** Pass back as `cursor` for the next page; null on the last. */
  next_cursor: string | null;
}

// -----------------------------------------------------------------------------------------------
// POST /admin/launch-tests/cohort
// -----------------------------------------------------------------------------------------------

/**
 * Record one factory with the profiles sent to it. `payer_id` names its BadaBhai account when the
 * desk knows it; with none named and a phone given, the ONE ordinary account holding that phone is
 * linked. The sender is the admin making the request.
 */
export const AdminLaunchTestRecordSchema = z
  .object({
    factory_name: FactoryNameSchema,
    factory_phone: e164PhoneSchema.optional(),
    city_group: z.enum(LAUNCH_TEST_CITY_GROUPS),
    trade_group: z.enum(LAUNCH_TEST_TRADE_GROUPS),
    sent_at: instant,
    worker_ids: z
      .array(id)
      .min(1)
      .max(LAUNCH_TEST_SHARES_MAX)
      .refine((ids) => new Set(ids).size === ids.length, { message: "Each worker is sent once" }),
    payer_id: id.optional(),
    payment_link_ref: PaymentLinkRefSchema.optional(),
    link_created_at: instant.optional(),
  })
  .strict();
export type AdminLaunchTestRecordDto = z.infer<typeof AdminLaunchTestRecordSchema>;

export interface AdminLaunchTestRecordResult {
  factory: AdminLaunchTestFactoryView;
  /** False when this Idempotency-Key had already recorded the factory: nothing new was written. */
  created: boolean;
}

// -----------------------------------------------------------------------------------------------
// PATCH /admin/launch-tests/cohort/:id
// -----------------------------------------------------------------------------------------------

export const AdminLaunchTestParamsSchema = z.object({ id }).strict();
export type AdminLaunchTestParamsDto = z.infer<typeof AdminLaunchTestParamsSchema>;

/**
 * Any of the six, at least one; `null` clears. The rules that join them (paid_at iff paid, a link
 * time needs the link, a paid order needs an account and a paid result) are checked on the merged
 * row, so a PATCH may set a pair together or one side at a time.
 */
export const AdminLaunchTestUpdateSchema = z
  .object({
    payment_link_ref: PaymentLinkRefSchema.nullable(),
    link_created_at: instant.nullable(),
    result: z.enum(LAUNCH_TEST_RESULTS),
    paid_at: instant.nullable(),
    payer_id: id.nullable(),
    payment_order_id: id.nullable(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to change" });
export type AdminLaunchTestUpdateDto = z.infer<typeof AdminLaunchTestUpdateSchema>;

export interface AdminLaunchTestUpdateResult {
  factory: AdminLaunchTestFactoryView;
  /** False when the row already held every value asked for: nothing was written or emitted. */
  changed: boolean;
}

// -----------------------------------------------------------------------------------------------
// GET /admin/launch-tests/contacts-per-hire
// -----------------------------------------------------------------------------------------------

export interface AdminContactsPerHireReport {
  /** At most this many hires: the first confirmed hires in BadaBhai. */
  limit: number;
  hires: ContactsPerHireHire[];
  totals: ContactsPerHireTotals;
}

// -----------------------------------------------------------------------------------------------
// Refusals (400 / 409 bodies): closed codes, ids only
// -----------------------------------------------------------------------------------------------

/** The codes a refused launch-test write carries in `reason`. */
export const LAUNCH_TEST_WRITE_REASONS = {
  /** 400 — one or more workers may not be sent; `workers` names each with its code. */
  workersNotEligible: "workers_not_eligible",
  /** 409 — the factory would pass five shares. */
  shareLimit: "share_limit_exceeded",
  /** 409 — a factory with this phone is already recorded. */
  factoryAlreadyRecorded: "factory_already_recorded",
  /** 409 — the Idempotency-Key was used for a different factory. */
  keyReused: "idempotency_key_reused",
  /** 400 — the named account does not exist. */
  payerNotFound: "payer_not_found",
  /** 409 — the order is already linked to another factory. */
  paymentOrderLinked: "payment_order_already_linked",
} as const;

export type LaunchTestWriteReason =
  | (typeof LAUNCH_TEST_WRITE_REASONS)[keyof typeof LAUNCH_TEST_WRITE_REASONS]
  | LaunchTestPortalRefusal
  | LaunchTestStateRefusal
  | LaunchTestOrderRefusal;

/** The 400 body of a refused share set. */
export interface WorkersNotEligibleBody {
  statusCode: 400;
  error: "Bad Request";
  message: string;
  reason: "workers_not_eligible";
  workers: RefusedWorker[];
}
