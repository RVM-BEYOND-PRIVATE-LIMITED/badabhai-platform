import "server-only";
import { z } from "zod";
import { adminFetch } from "./admin-http";
import {
  CONTACTS_PER_HIRE_REASONS,
  CREDIT_CALL_RESULTS,
  LAUNCH_TEST_RESULTS,
  UNLOCK_OUTCOMES,
} from "./numbers-vocabulary";

/**
 * The NUMBERS data layer (#2884; API #2755): the weekly figures, their definitions, the
 * out-of-credits call list and the two launch-test records.
 *
 * Every response is parsed with a Zod schema, exactly like the rest of the portal: a shape change
 * becomes an honest error state instead of `undefined` rendering as a blank screen. Names stay
 * OPTIONAL on purpose — the API omits them without `read_identity`, and an omitted name is not
 * "no name recorded".
 */

const paymentsPostureSchema = z.object({
  mode: z.enum(["real", "mock"]),
  blocked_reason: z.string().nullable(),
});
export type NumbersPaymentsPosture = z.infer<typeof paymentsPostureSchema>;

// ---------------------------------------------------------------------------
// Definitions — GET /admin/numbers/definitions
// ---------------------------------------------------------------------------

const availabilitySchema = z.union([
  z.object({ status: z.literal("live") }),
  z.object({
    status: z.literal("not_available"),
    reason: z.string(),
    waits_on: z.string(),
  }),
]);

const metricDefinitionSchema = z.object({
  id: z.string(),
  title: z.string(),
  unit: z.string(),
  source: z.string(),
  rule: z.string(),
  availability: availabilitySchema,
  kind: z.string(),
});
export type NumbersMetricDefinition = z.infer<typeof metricDefinitionSchema>;

const metricGroupSchema = z.object({
  number: z.number(),
  id: z.string(),
  title: z.string(),
  metrics: z.array(metricDefinitionSchema),
});
export type NumbersMetricGroup = z.infer<typeof metricGroupSchema>;

export const numbersDefinitionsSchema = z.object({
  definition_version: z.number(),
  week: z.object({
    rule: z.string(),
    time_zone: z.string(),
    utc_offset: z.string(),
    starts_on: z.string(),
  }),
  cities: z.object({
    normalisation: z.string(),
    buckets: z.string(),
    groups: z.array(
      z.object({ id: z.string(), title: z.string(), members: z.array(z.string()) }),
    ),
  }),
  trades: z.object({
    buckets: z.string(),
    groups: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        role_kinds: z.array(z.string()),
        taxonomy_roles: z.array(z.string()),
      }),
    ),
  }),
  exclusions: z.object({ companies: z.string(), workers: z.string() }),
  metric_groups: z.array(metricGroupSchema),
  small_cell_floor: z.number(),
  payments: paymentsPostureSchema,
});
export type NumbersDefinitions = z.infer<typeof numbersDefinitionsSchema>;
export type NumbersCityDefinition = NumbersDefinitions["cities"]["groups"][number];
export type NumbersTradeDefinition = NumbersDefinitions["trades"]["groups"][number];

// ---------------------------------------------------------------------------
// Weekly — GET /admin/numbers/weekly
// ---------------------------------------------------------------------------

const weeklyPointSchema = z.object({
  week_start: z.string(),
  value: z.number().nullable(),
  numerator: z.number().nullable(),
  denominator: z.number().nullable(),
  suppressed: z.boolean(),
  pending: z.boolean().default(false),
  before_real_payments: z.boolean(),
  frozen: z.boolean(),
  definition_version: z.number().nullable(),
});
export type NumbersWeeklyPoint = z.infer<typeof weeklyPointSchema>;

const weeklyChangeSchema = z.object({
  absolute: z.number(),
  percent: z.number().nullable(),
});

const weeklyMetricSchema = z.object({
  id: z.string(),
  group: z.string(),
  title: z.string(),
  unit: z.string(),
  kind: z.string(),
  availability: z.enum(["live", "not_available"]),
  reason: z.string().optional(),
  waits_on: z.string().optional(),
  pack: z.string().optional(),
  list_route: z.string().optional(),
  latest_complete: weeklyPointSchema.nullish(),
  this_week: z.number().nullable(),
  last_week: z.number().nullable(),
  change: weeklyChangeSchema.nullable(),
  series: z.array(weeklyPointSchema),
});
export type NumbersWeeklyMetric = z.infer<typeof weeklyMetricSchema>;

export const weeklyNumbersSchema = z.object({
  definition_version: z.number(),
  payments_posture: paymentsPostureSchema,
  city: z.string(),
  trade: z.string(),
  weeks: z.array(z.string()),
  computed_at: z.string().nullable(),
  metrics: z.array(weeklyMetricSchema),
});
export type WeeklyNumbers = z.infer<typeof weeklyNumbersSchema>;

export interface WeeklyNumbersFilters {
  city?: string;
  trade?: string;
  weeks?: string | number;
}

export async function getWeeklyNumbers(filters: WeeklyNumbersFilters = {}): Promise<WeeklyNumbers> {
  const q = new URLSearchParams();
  if (filters.city) q.set("city", filters.city);
  if (filters.trade) q.set("trade", filters.trade);
  if (filters.weeks !== undefined) q.set("weeks", String(filters.weeks));
  const query = q.toString();
  return adminFetch(`/admin/numbers/weekly${query ? `?${query}` : ""}`, {
    schema: weeklyNumbersSchema,
  });
}

export async function getNumbersDefinitions(): Promise<NumbersDefinitions> {
  return adminFetch("/admin/numbers/definitions", { schema: numbersDefinitionsSchema });
}

// ---------------------------------------------------------------------------
// Out of credits — GET /admin/numbers/out-of-credits
// ---------------------------------------------------------------------------

const creditCallSchema = z.object({
  called_at: z.string(),
  result: z.enum(CREDIT_CALL_RESULTS),
  admin_id: z.string(),
});
export type NumbersCreditCall = z.infer<typeof creditCallSchema>;

const outOfCreditsRowSchema = z.object({
  payer_id: z.string(),
  ran_out_at: z.string(),
  last_purchase: z
    .object({ at: z.string(), pack_code: z.string().nullable() })
    .nullable(),
  last_open_at: z.string().nullable(),
  last_call: creditCallSchema.nullable(),
  org_name: z.string().nullable().optional(),
});
export type OutOfCreditsRow = z.infer<typeof outOfCreditsRowSchema>;

export const outOfCreditsPageSchema = z.object({
  rows: z.array(outOfCreditsRowSchema),
  next_cursor: z.string().nullable(),
  accounts_link_hint: z.literal(true),
});
export type OutOfCreditsPage = z.infer<typeof outOfCreditsPageSchema>;

export async function listOutOfCredits({
  cursor,
  limit = 50,
}: {
  cursor?: string;
  limit?: number;
} = {}): Promise<OutOfCreditsPage> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (cursor) q.set("cursor", cursor);
  return adminFetch(`/admin/numbers/out-of-credits?${q.toString()}`, {
    schema: outOfCreditsPageSchema,
  });
}

// ---------------------------------------------------------------------------
// Launch test A — /admin/launch-tests/cohort
// ---------------------------------------------------------------------------

const launchFactorySchema = z.object({
  id: z.string(),
  factory_name: z.string().nullable().optional(),
  has_phone: z.boolean(),
  city_group: z.string(),
  trade_group: z.string(),
  payer_id: z.string().nullable(),
  sent_by_admin_id: z.string(),
  sent_at: z.string(),
  payment_link_ref: z.string().nullable(),
  link_created_at: z.string().nullable(),
  result: z.enum(LAUNCH_TEST_RESULTS),
  paid_at: z.string().nullable(),
  payment_order_id: z.string().nullable(),
  share_count: z.number(),
  worker_ids: z.array(z.string()),
  created_at: z.string(),
  updated_at: z.string(),
  updated_by_admin_id: z.string(),
});
export type LaunchFactory = z.infer<typeof launchFactorySchema>;

export const launchCohortPageSchema = z.object({
  rows: z.array(launchFactorySchema),
  next_cursor: z.string().nullable(),
});
export type LaunchCohortPage = z.infer<typeof launchCohortPageSchema>;

export async function listLaunchCohort({
  cursor,
  limit = 50,
}: {
  cursor?: string;
  limit?: number;
} = {}): Promise<LaunchCohortPage> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (cursor) q.set("cursor", cursor);
  return adminFetch(`/admin/launch-tests/cohort?${q.toString()}`, {
    schema: launchCohortPageSchema,
  });
}

// ---------------------------------------------------------------------------
// Launch test B — GET /admin/launch-tests/contacts-per-hire
// ---------------------------------------------------------------------------

const contactsPerHireContactSchema = z.object({
  unlock_id: z.string(),
  worker_id: z.string().nullable(),
  granted_at: z.string(),
  outcome: z
    .object({
      outcome: z.enum(UNLOCK_OUTCOMES),
      answered_by: z.enum(["company", "desk"]),
      answered_at: z.string(),
    })
    .nullable(),
});
export type ContactsPerHireContact = z.infer<typeof contactsPerHireContactSchema>;

const contactsPerHireHireSchema = z.object({
  hire_id: z.string(),
  payer_id: z.string(),
  posting_kind: z.enum(["company_posting", "agency_job"]),
  job_posting_id: z.string().nullable(),
  worker_id: z.string(),
  confirmed_at: z.string(),
  contacts: z.array(contactsPerHireContactSchema).nullable(),
  contacts_reason: z.enum(CONTACTS_PER_HIRE_REASONS).nullable(),
});
export type ContactsPerHireHire = z.infer<typeof contactsPerHireHireSchema>;

export const contactsPerHireReportSchema = z.object({
  limit: z.number(),
  hires: z.array(contactsPerHireHireSchema),
  totals: z.object({
    hires_listed: z.number(),
    hires_counted: z.number(),
    contacts_opened: z.number(),
    contacts_per_hire: z.object({ numerator: z.number(), denominator: z.number() }),
  }),
});
export type ContactsPerHireReport = z.infer<typeof contactsPerHireReportSchema>;

export async function getContactsPerHire(): Promise<ContactsPerHireReport> {
  return adminFetch("/admin/launch-tests/contacts-per-hire", {
    schema: contactsPerHireReportSchema,
  });
}
