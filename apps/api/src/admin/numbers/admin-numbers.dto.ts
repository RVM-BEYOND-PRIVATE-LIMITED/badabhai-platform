import { BadRequestException, createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { PAYER_TEST_ACCOUNT_REASONS } from "@badabhai/event-schema";
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
 * marks (part A) and the weekly figures (part B). Later parts add the call list and the
 * launch-test records beside these.
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
   * The figure: a count, paise, or (unit `ratio`) the quotient with two decimals. Null when the
   * cell is suppressed, the ratio not computable (no hire), or the week not computed yet.
   */
  value: number | null;
  /** A ratio's or a share's two terms; null for counts and money, and when suppressed. */
  numerator: number | null;
  denominator: number | null;
  /** A worker cell under the small-cell floor: no number is shown. */
  suppressed: boolean;
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
