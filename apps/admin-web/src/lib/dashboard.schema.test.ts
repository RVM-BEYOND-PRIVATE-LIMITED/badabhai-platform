import { describe, it, expect } from "vitest";
import { aiCostSummarySchema, dashboardSummarySchema, volumeSummarySchema } from "./dashboard";

/**
 * Response-shape parity with `GET /admin/dashboard/summary` (BP-5).
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────
 * The same reason `events.schema.test.ts` does. That schema typed `by_day` as the `{key,count}`
 * bucket its two neighbours use; the server emits `{day,count}`; the whole response failed to
 * parse and the dashboard silently rendered "metrics unavailable". A wrong Zod shape here does
 * not throw a visible error — `adminFetch` fails closed and the section is simply GONE, which
 * on a spend console reads as "the platform has spent nothing".
 *
 * ── WHERE THE FIXTURES COME FROM ────────────────────────────────────────────────────────
 * TRANSCRIBED FROM THE SERVER, not invented. The provider rows are the ones
 * `apps/api/src/admin/admin-dashboard.service.test.ts` pins as the labels
 * `provider_for_model` actually produces (including BOTH Sarvam buckets — see below); the
 * enum members are `WORKER_STATUSES` / `PROFILE_STATUSES` / `JOB_POSTING_STATUSES` and the two
 * payer unions the service densifies against, each with the trailing `other` bucket the
 * service always appends; the money is the `numeric(16,6)` string Postgres serialises verbatim.
 * `Date` fields appear as the ISO strings `JSON.stringify` produces on the wire — that
 * conversion is the one this file has to be right about, because the DTO declares `Date` and
 * nothing on this side ever sees one.
 *
 * A fixture I made up would have encoded the same assumption the schema does, and proved
 * nothing.
 */

// ── AI cost ────────────────────────────────────────────────────────────────
//
// Both Sarvam-relevant provider labels are present ON PURPOSE. `platform_ai_cost_totals` is a
// running sum with no backfill, so STT spend that accrued before `provider_for_model` learned
// the Sarvam model families stays filed under `unknown` for ever, while everything after it
// lands under `sarvam`. A schema that rejected either would blank the whole page.
const REAL_AI_COST = {
  accruing_since: "2026-08-17T01:00:00.000Z",
  is_lifetime_total: false,
  caveat: "totals_accrue_from_migration_0077_no_backfill",
  total_cost_inr: "23.750000",
  total_calls: 156,
  real_calls: 146,
  by_provider: [
    {
      provider: "google",
      total_cost_inr: "12.500000",
      call_count: 100,
      real_call_count: 90,
      first_recorded_at: "2026-08-18T09:00:00.000Z",
    },
    {
      provider: "anthropic",
      total_cost_inr: "7.250000",
      call_count: 40,
      real_call_count: 40,
      first_recorded_at: "2026-08-19T00:00:00.000Z",
    },
    {
      provider: "sarvam",
      total_cost_inr: "3.000000",
      call_count: 12,
      real_call_count: 12,
      first_recorded_at: "2026-08-19T01:00:00.000Z",
    },
    {
      provider: "unknown",
      total_cost_inr: "1.000000",
      call_count: 4,
      real_call_count: 4,
      first_recorded_at: "2026-08-17T01:00:00.000Z",
    },
  ],
  by_task_type: [
    {
      task_type: "profile_extraction",
      total_cost_inr: "19.750000",
      call_count: 140,
      real_call_count: 130,
    },
    { task_type: "stt_transcription", total_cost_inr: "4.000000", call_count: 16, real_call_count: 16 },
  ],
  cap_breaches: {
    window_days: 30,
    total: 3,
    scope: "cap_breaches_cover_profile_extraction_only",
    by_reason: [
      { reason: "user_daily_cap_exceeded", count: 2 },
      { reason: "cumulative_cap_exceeded", count: 1 },
    ],
  },
};

// ── volume ─────────────────────────────────────────────────────────────────
//
// Every closed enum is DENSIFIED by the service: every member, zeros included, plus one
// `other` bucket for stored values the enum does not name. The `other` rows are non-zero on a
// couple of these on purpose — four of the five columns have no DB CHECK behind them, so a
// drifted value is reachable, and the headline totals are summed from these very buckets.
const REAL_VOLUME = {
  workers: {
    total: 42,
    by_status: [
      { key: "pending", count: 5 },
      { key: "active", count: 36 },
      { key: "suspended", count: 0 },
      { key: "other", count: 1 },
    ],
    pending_deletion: 2,
  },
  worker_profiles: {
    workers_with_profile: 30,
    by_status: [
      { key: "draft", count: 4 },
      { key: "extracting", count: 1 },
      { key: "extracted", count: 9 },
      { key: "confirmed", count: 16 },
      { key: "other", count: 0 },
    ],
  },
  job_postings: {
    total: 18,
    by_status: [
      { key: "draft", count: 3 },
      { key: "open", count: 11 },
      { key: "paused", count: 1 },
      { key: "suspended", count: 0 },
      { key: "closed", count: 3 },
      { key: "other", count: 0 },
    ],
  },
  applications: { total: 240, applied: 132 },
  payers: {
    total: 9,
    by_role: [
      { key: "employer", count: 7 },
      { key: "agent", count: 2 },
      { key: "other", count: 0 },
    ],
    by_status: [
      { key: "pending", count: 1 },
      { key: "active", count: 8 },
      { key: "suspended", count: 0 },
      { key: "other", count: 0 },
    ],
  },
  unlocks: { issued: 57 },
  resumes: { total: 21 },
};

const REAL_SUMMARY = {
  generated_at: "2026-08-19T10:31:04.000Z",
  ai_cost: REAL_AI_COST,
  volume: REAL_VOLUME,
};

describe("dashboard summary — parses the real API response", () => {
  it("parses a captured GET /admin/dashboard/summary payload", () => {
    const parsed = dashboardSummarySchema.safeParse(REAL_SUMMARY);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("REJECTS a payload with no ai_cost block — the section would render as ₹0", () => {
    const { ai_cost: _omitted, ...without } = REAL_SUMMARY;
    expect(dashboardSummarySchema.safeParse(without).success).toBe(false);
  });

  it("REJECTS a payload with no volume block", () => {
    const { volume: _omitted, ...without } = REAL_SUMMARY;
    expect(dashboardSummarySchema.safeParse(without).success).toBe(false);
  });
});

describe("ai_cost — the honesty markers are REQUIRED, not decoration", () => {
  /*
   * `accruing_since`, `is_lifetime_total` and `caveat` are the three fields that stop a
   * PARTIAL spend figure being read as a lifetime one. A response missing any of them must
   * fail the parse — degrading to "render the number without its basis" is the exact defect
   * they were added to prevent.
   */
  it("parses the captured ai_cost block", () => {
    expect(aiCostSummarySchema.safeParse(REAL_AI_COST).success).toBe(true);
  });

  it("REJECTS a payload missing accruing_since — every ₹ below it is 'since' that date", () => {
    const { accruing_since: _omitted, ...without } = REAL_AI_COST;
    expect(aiCostSummarySchema.safeParse(without).success).toBe(false);
  });

  it("ACCEPTS accruing_since: null — 'nothing has ever accrued' is a real answer", () => {
    const parsed = aiCostSummarySchema.safeParse({
      ...REAL_AI_COST,
      accruing_since: null,
      total_cost_inr: "0",
      total_calls: 0,
      real_calls: 0,
      by_provider: [],
      by_task_type: [],
    });
    expect(parsed.success).toBe(true);
  });

  it("REJECTS a payload missing is_lifetime_total", () => {
    const { is_lifetime_total: _omitted, ...without } = REAL_AI_COST;
    expect(aiCostSummarySchema.safeParse(without).success).toBe(false);
  });

  it("ACCEPTS is_lifetime_total: true — the schema must survive a backfill landing", () => {
    // `z.literal(false)` would turn the day a backfill ships into a portal-wide parse
    // failure. `z.boolean()` parses both, and the renderer switches on the value.
    expect(
      aiCostSummarySchema.safeParse({ ...REAL_AI_COST, is_lifetime_total: true }).success,
    ).toBe(true);
  });

  it("REJECTS a payload missing the caveat code the caption is keyed off", () => {
    const { caveat: _omitted, ...without } = REAL_AI_COST;
    expect(aiCostSummarySchema.safeParse(without).success).toBe(false);
  });

  it("ACCEPTS an unrecognised caveat code — a new kind of absence is not an outage", () => {
    expect(
      aiCostSummarySchema.safeParse({ ...REAL_AI_COST, caveat: "some_future_code" }).success,
    ).toBe(true);
  });
});

describe("ai_cost — ₹ crosses the wire as an exact decimal STRING", () => {
  /*
   * `total_cost_inr` is `numeric(16,6)` summed in Postgres and serialised verbatim. Typing it
   * as `z.number()` would parse today's payload as well as a string one does under a loose
   * schema — so the REJECTION is the assertion that matters, and the acceptance below pins
   * that a sub-paisa value survives with all six places.
   */
  it("REJECTS total_cost_inr sent as a number — the column is numeric, not a float", () => {
    const wrong = { ...REAL_AI_COST, total_cost_inr: 23.75 };
    expect(aiCostSummarySchema.safeParse(wrong).success).toBe(false);
  });

  it("REJECTS a provider bucket whose total_cost_inr is a number", () => {
    const wrong = {
      ...REAL_AI_COST,
      by_provider: [{ ...REAL_AI_COST.by_provider[0], total_cost_inr: 12.5 }],
    };
    expect(aiCostSummarySchema.safeParse(wrong).success).toBe(false);
  });

  it("keeps a sub-paisa amount as sent, to the last digit", () => {
    const parsed = aiCostSummarySchema.parse({ ...REAL_AI_COST, total_cost_inr: "0.000012" });
    expect(parsed.total_cost_inr).toBe("0.000012");
  });

  it("REJECTS a count sent as a string — only the money is a string", () => {
    const wrong = { ...REAL_AI_COST, total_calls: "156" };
    expect(aiCostSummarySchema.safeParse(wrong).success).toBe(false);
  });
});

describe("ai_cost — provider and task type are OPEN sets", () => {
  /*
   * The API DTO is explicit that both are read from stored `text` columns and neither is an
   * enum. A mirrored `z.enum` here would reject the ENTIRE response the first time a provider
   * was added — blanking a spend page over a label it could simply have displayed.
   */
  it("accepts a provider label this build has never seen", () => {
    const parsed = aiCostSummarySchema.safeParse({
      ...REAL_AI_COST,
      by_provider: [
        ...REAL_AI_COST.by_provider,
        {
          provider: "some_new_vendor",
          total_cost_inr: "0.500000",
          call_count: 1,
          real_call_count: 1,
          first_recorded_at: "2026-08-19T02:00:00.000Z",
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts an unseen task type and an unseen breach reason", () => {
    const parsed = aiCostSummarySchema.safeParse({
      ...REAL_AI_COST,
      by_task_type: [
        { task_type: "future_task", total_cost_inr: "0.100000", call_count: 1, real_call_count: 0 },
      ],
      cap_breaches: {
        ...REAL_AI_COST.cap_breaches,
        by_reason: [{ reason: "a_reason_from_a_later_build", count: 1 }],
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("keeps the `unknown` provider row — dropping it would understate the total", () => {
    const parsed = aiCostSummarySchema.parse(REAL_AI_COST);
    const labels = parsed.by_provider.map((p) => p.provider);
    expect(labels).toContain("unknown");
    expect(labels).toContain("sarvam");
  });
});

describe("ai_cost — cap_breaches carries its own SCOPE", () => {
  it("REJECTS a cap_breaches block missing `scope` — a bare 0 reads as an all-clear", () => {
    const { scope: _omitted, ...breaches } = REAL_AI_COST.cap_breaches;
    expect(aiCostSummarySchema.safeParse({ ...REAL_AI_COST, cap_breaches: breaches }).success).toBe(
      false,
    );
  });

  it("REJECTS a cap_breaches block missing `window_days` — the count has no period", () => {
    const { window_days: _omitted, ...breaches } = REAL_AI_COST.cap_breaches;
    expect(aiCostSummarySchema.safeParse({ ...REAL_AI_COST, cap_breaches: breaches }).success).toBe(
      false,
    );
  });

  it("REJECTS by_reason rows keyed `key` — the mirror of the by_day bug on events", () => {
    const wrong = {
      ...REAL_AI_COST,
      cap_breaches: { ...REAL_AI_COST.cap_breaches, by_reason: [{ key: "x", count: 1 }] },
    };
    expect(aiCostSummarySchema.safeParse(wrong).success).toBe(false);
  });
});

describe("volume — every enum breakdown keeps its buckets", () => {
  it("parses the captured volume block", () => {
    expect(volumeSummarySchema.safeParse(REAL_VOLUME).success).toBe(true);
  });

  it("keeps the `other` bucket — it is the reason total === count(*)", () => {
    const parsed = volumeSummarySchema.parse(REAL_VOLUME);
    const other = parsed.workers.by_status.find((b) => b.key === "other");
    expect(other?.count).toBe(1);
    // The server sums the headline FROM these buckets, so the two cannot disagree. Asserted
    // here because a schema that silently dropped a bucket would break exactly that property.
    const summed = parsed.workers.by_status.reduce((n, b) => n + b.count, 0);
    expect(summed).toBe(parsed.workers.total);
  });

  it("REJECTS a bucket list sent as an object map instead of an array", () => {
    const wrong = {
      ...REAL_VOLUME,
      workers: { ...REAL_VOLUME.workers, by_status: { active: 36, pending: 5 } },
    };
    expect(volumeSummarySchema.safeParse(wrong).success).toBe(false);
  });

  it("REJECTS a volume block missing `pending_deletion` — a DPDP erasure in flight", () => {
    const { pending_deletion: _omitted, ...workers } = REAL_VOLUME.workers;
    expect(volumeSummarySchema.safeParse({ ...REAL_VOLUME, workers }).success).toBe(false);
  });

  it("REJECTS `applications` collapsed to a single number — applies and skips differ", () => {
    const wrong = { ...REAL_VOLUME, applications: { total: 240 } };
    expect(volumeSummarySchema.safeParse(wrong).success).toBe(false);
  });

  it("accepts a status member this build has never seen", () => {
    // `key` is `z.string()`, not a mirrored enum: a status added server-side must appear the
    // day it ships rather than rejecting the response.
    const parsed = volumeSummarySchema.safeParse({
      ...REAL_VOLUME,
      workers: {
        ...REAL_VOLUME.workers,
        by_status: [...REAL_VOLUME.workers.by_status, { key: "dormant", count: 0 }],
      },
    });
    expect(parsed.success).toBe(true);
  });
});
