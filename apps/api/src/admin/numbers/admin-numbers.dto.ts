import { BadRequestException, createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { PAYER_TEST_ACCOUNT_REASONS } from "@badabhai/event-schema";
import { CREDIT_CALL_RESULTS, type CreditCallResult } from "@badabhai/types";
import type { PaymentsPosture } from "../admin-finance.dto";
import type {
  NumbersMetricGroupDefinition,
  NumbersMetricKind,
  NumbersMetricUnit,
} from "./definitions";
import {
  NUMBERS_ALL_GROUP,
  NUMBERS_CITY_GROUP_LABELS,
  NUMBERS_TRADE_GROUP_LABELS,
  type NumbersCityGroupLabel,
  type NumbersTradeGroupLabel,
} from "./groups";

/**
 * #2755 — the wire contract of `/admin/numbers/*`: the definitions catalogue and the test-company
 * marks (part A), the weekly figures (part B), and the out-of-credits call list and its call log
 * (part C).
 */

// -----------------------------------------------------------------------------------------------
// GET /admin/numbers/definitions
// -----------------------------------------------------------------------------------------------

export interface AdminNumbersCityGroup {
  id: NumbersCityGroupLabel;
  title: string;
  /** The normalised spellings that map here; empty for `all`, `other` and `unknown`. */
  members: string[];
}

export interface AdminNumbersTradeGroup {
  id: NumbersTradeGroupLabel;
  title: string;
  /** Trade-form kinds (`job_postings.role_kind`, a form worker's `form_kind`) that map here. */
  role_kinds: string[];
  /** Taxonomy `role_*` ids (`worker_occupation.role_id`, `canonical_role_id`) that map here. */
  taxonomy_roles: string[];
}

export interface AdminNumbersDefinitions {
  /** The version every rule below is written under; part B stamps it on every stored row. */
  definition_version: number;
  week: {
    rule: string;
    time_zone: "Asia/Kolkata";
    utc_offset: "+05:30";
    starts_on: "monday";
  };
  cities: {
    /** How a stored city is read before it is matched (case, commas, hyphens, spaces). */
    normalisation: string;
    /** What `other` and `unknown` mean. */
    buckets: string;
    groups: AdminNumbersCityGroup[];
  };
  trades: {
    buckets: string;
    groups: AdminNumbersTradeGroup[];
  };
  /** Who never counts, in words (the SQL is `exclusions.ts`). */
  exclusions: { companies: string; workers: string };
  /** The ten metric groups, each figure with its unit, source, rule and availability. */
  metric_groups: NumbersMetricGroupDefinition[];
  /** Worker split cells under this many workers are suppressed (the onboarding funnel's floor). */
  small_cell_floor: number;
  /** Whether money on this screen is real. Every money figure carries it. */
  payments: PaymentsPosture;
}

// -----------------------------------------------------------------------------------------------
// PUT | DELETE /admin/numbers/test-accounts/:payerId
// -----------------------------------------------------------------------------------------------

/** `:payerId` — the company's payer id (the id the admin Companies page shows). */
export const AdminNumbersPayerParamsSchema = z.object({ payerId: z.string().uuid() }).strict();
export type AdminNumbersPayerParamsDto = z.infer<typeof AdminNumbersPayerParamsSchema>;

/** The PUT body: why this is a test company — one of four closed codes, never free text. */
export const AdminNumbersMarkTestAccountSchema = z
  .object({ reason: z.enum(PAYER_TEST_ACCOUNT_REASONS) })
  .strict();
export type AdminNumbersMarkTestAccountDto = z.infer<typeof AdminNumbersMarkTestAccountSchema>;

/** What a mark or an unmark left behind. */
export interface AdminPayerTestAccountResult {
  payer_id: string;
  /** The column as it stands after the request. */
  is_test_account: boolean;
  /** False when the company was already in that state: nothing was written or emitted. */
  changed: boolean;
}

/**
 * The PUT's `Idempotency-Key` header: REQUIRED, 8 to 200 characters of `A-Z a-z 0-9 . _ : -` (the
 * house charset). It keys the spine write, so a retried request can never emit a second
 * `admin.payer_test_account_marked`; the row itself is guarded on its current value, so a retry
 * also changes nothing. Missing or malformed → 400 `idempotency_key_required` before anything runs.
 */
export const NUMBERS_IDEMPOTENCY_KEY_REQUIRED = "idempotency_key_required" as const;
export const NumbersIdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{8,200}$/);

export const NumbersIdempotencyKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const raw = ctx.switchToHttp().getRequest<Request>().headers["idempotency-key"];
    const parsed = NumbersIdempotencyKeySchema.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message:
          "An Idempotency-Key header is required: 8 to 200 characters of A-Z a-z 0-9 . _ : -",
        reason: NUMBERS_IDEMPOTENCY_KEY_REQUIRED,
      });
    }
    return parsed.data;
  },
);

// -----------------------------------------------------------------------------------------------
// GET /admin/numbers/weekly (part B)
// -----------------------------------------------------------------------------------------------

/** How many weeks the series holds by default, and at most. */
export const NUMBERS_WEEKLY_DEFAULT_WEEKS = 12;
export const NUMBERS_WEEKLY_MAX_WEEKS = 26;

/**
 * The query: one city group and one trade group (each `all` by default; a label `groups.ts` does
 * not know is a 400), and how many weeks of series (1..26, default 12). STRICT: an unknown key is
 * a 400, never ignored.
 */
export const AdminNumbersWeeklyQuerySchema = z
  .object({
    city: z.enum(NUMBERS_CITY_GROUP_LABELS).optional().default(NUMBERS_ALL_GROUP),
    trade: z.enum(NUMBERS_TRADE_GROUP_LABELS).optional().default(NUMBERS_ALL_GROUP),
    weeks: z.coerce
      .number()
      .int()
      .min(1)
      .max(NUMBERS_WEEKLY_MAX_WEEKS)
      .optional()
      .default(NUMBERS_WEEKLY_DEFAULT_WEEKS),
  })
  .strict();
export type AdminNumbersWeeklyQueryDto = z.infer<typeof AdminNumbersWeeklyQuerySchema>;

/** One week of one metric, as the snapshot stored it for the filter's cell. */
export interface AdminNumbersWeeklyPoint {
  week_start: string;
  /**
   * The figure: a count, paise, (unit `ratio`) the quotient with two decimals, or (unit `share`)
   * the share as a fraction 0..1 with two decimals. Null when the cell is suppressed, the ratio
   * not computable (no hire), a share's cohort empty or its window `pending`, or the week not
   * computed yet.
   */
  value: number | null;
  /**
   * A ratio's or a share's two terms; null for counts and money, and when suppressed. A pending
   * share keeps its denominator (the cohort's size) and no numerator.
   */
  numerator: number | null;
  denominator: number | null;
  /** A worker cell under the small-cell floor: no number is shown. */
  suppressed: boolean;
  /**
   * A COHORT figure (repeat buying) whose window has not yet elapsed for every company of the
   * cohort: no share is shown, never a partial one. Always false for every other metric.
   */
  pending: boolean;
  /** The week ends before the first real paid order: a zero here is not "nobody paid". */
  before_real_payments: boolean;
  /** The week is final: the sweep will not recompute it (only a logged recompute can). */
  frozen: boolean;
  /** The definition version the week was computed under; null when it has not been computed. */
  definition_version: number | null;
}

/** This week against last week. */
export interface AdminNumbersWeeklyChange {
  /** This week minus last week, in the metric's unit. */
  absolute: number;
  /** The change as a percentage of last week, one decimal; null when last week is 0. */
  percent: number | null;
}

export interface AdminNumbersWeeklyMetric {
  /** The catalogue id; one pack's revenue is `revenue_by_pack:<pack_code>`. */
  id: string;
  /** The catalogue group (1..10's id). */
  group: string;
  title: string;
  unit: NumbersMetricUnit;
  kind: NumbersMetricKind;
  availability: "live" | "not_available";
  /** Why it is not available, and the issue it waits on (not_available only). */
  reason?: string;
  waits_on?: string;
  /** The pack of a `revenue_by_pack:<code>` figure. */
  pack?: string;
  /**
   * A live figure served as a LIST by its own route (group 10, the call list,
   * `GET /admin/numbers/out-of-credits`): no values and an empty series, never a zero.
   */
  list_route?: string;
  /**
   * A COHORT figure only (repeat buying): its newest CLOSED cohort for this filter, from any week up
   * to the current one, or null when no cohort has closed yet. The series' newest weeks are always
   * `pending`, so this is the figure to headline.
   */
  latest_complete?: AdminNumbersWeeklyPoint | null;
  /** The current week's value (the week in progress), and the week before. */
  this_week: number | null;
  last_week: number | null;
  /**
   * Null when either week has no value (suppressed, not computable, not computed) or the two were
   * computed under different definition versions (they would not be comparable).
   */
  change: AdminNumbersWeeklyChange | null;
  /** Oldest first, one point per `weeks` entry; empty when not available. */
  series: AdminNumbersWeeklyPoint[];
}

export interface AdminNumbersWeekly {
  /** The version the code's rules are written under now. */
  definition_version: number;
  /** Whether money is real; every money figure is read with it. */
  payments_posture: PaymentsPosture;
  city: NumbersCityGroupLabel;
  trade: NumbersTradeGroupLabel;
  /** The series' weeks, oldest first; the last is the current week (in progress). */
  weeks: string[];
  /** When the newest row read was computed; null when none was. */
  computed_at: string | null;
  metrics: AdminNumbersWeeklyMetric[];
}

// -----------------------------------------------------------------------------------------------
// GET /admin/numbers/out-of-credits (part C, item 8)
// -----------------------------------------------------------------------------------------------

/** The call list's page size: default and most. A named page is clamped to 50 (see the service). */
export const NUMBERS_OUT_OF_CREDITS_DEFAULT_LIMIT = 50;
export const NUMBERS_OUT_OF_CREDITS_MAX_LIMIT = 100;

/**
 * The query: `limit` 1..100 (default 50) and the opaque `cursor` of the previous page. STRICT: an
 * unknown key is a 400. A cursor that does not decode is the first page (a cursor is client-held
 * state), never a 500.
 */
export const AdminNumbersOutOfCreditsQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(NUMBERS_OUT_OF_CREDITS_MAX_LIMIT)
      .optional()
      .default(NUMBERS_OUT_OF_CREDITS_DEFAULT_LIMIT),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();
export type AdminNumbersOutOfCreditsQueryDto = z.infer<typeof AdminNumbersOutOfCreditsQuerySchema>;

/** The latest call logged for a company. */
export interface AdminNumbersCreditCall {
  called_at: string;
  result: CreditCallResult;
  /** The admin who logged it. */
  admin_id: string;
}

/** One company on the call list. Ids, times, a pack code and a closed code; never a phone. */
export interface AdminNumbersOutOfCreditsRow {
  /** The company (its wallet key, the id the admin Companies page shows). */
  payer_id: string;
  /**
   * When it ran out: the later of its last `payer.credits_exhausted` (its last credit spent) and
   * the `expires_at` of the last lot that expired holding credits.
   */
  ran_out_at: string;
  /**
   * Its last real paid order: the settle time and the pack (null for an order that sells no credit
   * pack, #2749 part 3). Null when it never paid.
   */
  last_purchase: { at: string; pack_code: string | null } | null;
  /** When it last opened a contact (an unlock granted). Null when it never did. */
  last_open_at: string | null;
  /** The latest call logged for it, or null (none, or the call log not applied yet). */
  last_call: AdminNumbersCreditCall | null;
  /**
   * The company's name: PRESENT only when the admin holds `read_identity` and the identity read
   * disclosed names (`AdminIdentityService`, audited); null when none is on record. Absent
   * otherwise.
   */
  org_name?: string | null;
}

export interface AdminNumbersOutOfCreditsPage {
  rows: AdminNumbersOutOfCreditsRow[];
  /** The next page's cursor, or null on the last page. */
  next_cursor: string | null;
  /**
   * Always true: the company's phone is NOT on this route. It is on the User accounts surface
   * (`GET /admin/accounts`, capability `manage_payer_credentials`), which the screen links to.
   */
  accounts_link_hint: true;
}

// -----------------------------------------------------------------------------------------------
// POST /admin/numbers/out-of-credits/:payerId/calls (part C, item 8)
// -----------------------------------------------------------------------------------------------

/** The body: what the call came to — one of five closed codes, never free text. STRICT. */
export const AdminNumbersLogCreditCallSchema = z
  .object({ result: z.enum(CREDIT_CALL_RESULTS) })
  .strict();
export type AdminNumbersLogCreditCallDto = z.infer<typeof AdminNumbersLogCreditCallSchema>;

/** The logged call. */
export interface AdminNumbersLoggedCall extends AdminNumbersCreditCall {
  id: string;
  payer_id: string;
}

/** What a POST left behind; `created: false` is a replay of the same Idempotency-Key. */
export interface AdminNumbersLogCreditCallResult {
  call: AdminNumbersLoggedCall;
  created: boolean;
}
