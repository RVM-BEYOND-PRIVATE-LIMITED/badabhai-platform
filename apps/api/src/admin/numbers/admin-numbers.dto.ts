import { BadRequestException, createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { PAYER_TEST_ACCOUNT_REASONS } from "@badabhai/event-schema";
import type { PaymentsPosture } from "../admin-finance.dto";
import type { NumbersMetricGroupDefinition } from "./definitions";
import type { NumbersCityGroupLabel, NumbersTradeGroupLabel } from "./groups";

/**
 * #2755 — the wire contract of `/admin/numbers/*` (part A: the definitions catalogue and the
 * test-company marks). Later parts add the weekly figures, the call list and the launch-test
 * records beside these.
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
