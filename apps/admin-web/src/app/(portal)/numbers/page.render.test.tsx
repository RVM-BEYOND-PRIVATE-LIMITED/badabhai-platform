import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => {
  class RequestError extends Error {
    status: number;
    constructor(status: number) {
      super("request failed");
      this.name = "AdminRequestError";
      this.status = status;
    }
  }
  return {
    RequestError,
    gate: [] as string[],
    weekly: null as unknown,
    definitions: null as unknown,
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("../../../lib/auth", () => ({
  requireCapability: async (capability: string) => {
    h.gate.push(capability);
    return { adminId: "a-1", role: "ops_admin", capabilities: [capability] };
  },
}));

vi.mock("../../../lib/admin-http", () => ({
  isAdminRequestError: (err: unknown) => err instanceof h.RequestError,
  isAdminUnauthorized: () => false,
}));

vi.mock("../../../lib/numbers", () => ({
  getWeeklyNumbers: async () => {
    if (h.weekly instanceof Error) throw h.weekly;
    return h.weekly;
  },
  getNumbersDefinitions: async () => {
    if (h.definitions instanceof Error) throw h.definitions;
    return h.definitions;
  },
}));

const { default: NumbersPage } = await import("./page");

const point = (value: number | null, extra: Record<string, unknown> = {}) => ({
  week_start: "2026-11-09",
  value,
  numerator: null,
  denominator: null,
  suppressed: false,
  pending: false,
  before_real_payments: false,
  frozen: false,
  definition_version: 1,
  ...extra,
});

function weekly() {
  return {
    definition_version: 1,
    payments_posture: { mode: "mock", blocked_reason: "PAYMENTS_ENABLE_REAL=false" },
    city: "all",
    trade: "all",
    weeks: ["2026-11-02", "2026-11-09"],
    computed_at: "2026-11-10T00:00:00.000Z",
    metrics: [
      {
        id: "paying_companies",
        group: "paying",
        title: "Paying companies",
        unit: "count",
        kind: "headline",
        availability: "live",
        this_week: 4,
        last_week: null,
        change: null,
        series: [point(3, { before_real_payments: true }), point(4)],
      },
      {
        id: "revenue_by_pack",
        group: "revenue",
        title: "Revenue by pack, as charged",
        unit: "paise",
        kind: "headline",
        availability: "live",
        this_week: 150000,
        last_week: 100000,
        change: { absolute: 50000, percent: 50 },
        series: [point(100000), point(150000)],
      },
      {
        id: "revenue_by_pack:pack_10",
        group: "revenue",
        title: "Revenue by pack, as charged",
        unit: "paise",
        kind: "headline",
        availability: "live",
        pack: "pack_10",
        this_week: 150000,
        last_week: 100000,
        change: { absolute: 50000, percent: 50 },
        series: [point(100000), point(150000)],
      },
      {
        id: "revenue_gst_split",
        group: "revenue",
        title: "Revenue before GST",
        unit: "paise",
        kind: "headline",
        availability: "not_available",
        reason: "orders carry no GST split",
        waits_on: "#2749",
        this_week: null,
        last_week: null,
        change: null,
        series: [],
      },
      {
        id: "repeat_purchase_30d",
        group: "repeat",
        title: "Repeat buying in 30 days",
        unit: "share",
        kind: "headline",
        availability: "live",
        latest_complete: point(0.5, { week_start: "2026-10-05" }),
        this_week: null,
        last_week: null,
        change: null,
        series: [point(null, { pending: true })],
      },
      {
        id: "form_completed_unconfirmed",
        group: "profiles",
        title: "Form workers with no confirmed profile",
        unit: "count",
        kind: "diagnostic",
        availability: "live",
        this_week: null,
        last_week: null,
        change: null,
        series: [point(null, { suppressed: true }), point(null, { suppressed: true })],
      },
    ],
  };
}

function definitions() {
  return {
    definition_version: 7,
    week: {
      rule: "Monday 00:00 to Sunday 23:59:59 India time",
      time_zone: "Asia/Kolkata",
      utc_offset: "+05:30",
      starts_on: "monday",
    },
    cities: {
      normalisation: "lower case, up to the first comma",
      buckets: "other and unknown",
      groups: [{ id: "ncr", title: "NCR", members: ["delhi", "noida"] }],
    },
    trades: {
      buckets: "other and unknown",
      groups: [
        { id: "cnc_operator", title: "CNC operator", role_kinds: ["cnc_turner"], taxonomy_roles: [] },
      ],
    },
    exclusions: { companies: "test companies", workers: "sample workers" },
    metric_groups: [
      {
        number: 1,
        id: "paying",
        title: "Paying companies",
        metrics: [
          {
            id: "paying_companies",
            title: "Paying companies",
            unit: "count",
            source: "payment_orders",
            rule: "Counted in the week.",
            availability: { status: "live" },
            kind: "headline",
          },
        ],
      },
    ],
    small_cell_floor: 5,
    payments: { mode: "mock", blocked_reason: null },
  };
}

const render = async (sp: Record<string, string> = {}) =>
  renderToStaticMarkup(await NumbersPage({ searchParams: Promise.resolve(sp) }));

beforeEach(() => {
  h.gate.length = 0;
  h.weekly = weekly();
  h.definitions = definitions();
});

describe("the weekly numbers page", () => {
  it("gates on read_business_numbers", async () => {
    await render();
    expect(h.gate).toEqual(["read_business_numbers"]);
  });

  it("marks mock money, a partial week, the suppressed floor and a not-available figure", async () => {
    const out = await render();
    expect(out).toContain("Simulated money — not revenue.");
    expect(out).toContain("partial");
    expect(out).toContain("fewer than 5");
    expect(out).toContain("Not available yet");
    expect(out).toContain("waits on #2749");
    expect(out).not.toContain(">0<");
  });

  it("headlines the newest complete cohort and groups revenue by pack", async () => {
    const out = await render();
    expect(out).toContain("latest complete cohort");
    expect(out).toContain("50.0%");
    expect(out).toContain("10-credit pack");
    expect(out).toContain("Revenue by pack, as charged");
  });

  it("puts diagnostics in their own section and explains the definitions", async () => {
    const out = await render();
    expect(out).toContain("Diagnostics");
    expect(out).toContain("Form workers with no confirmed profile");
    expect(out).toContain("About these numbers");
    expect(out).toContain("Version 7");
    expect(out).toContain("Monday 00:00 to Sunday 23:59:59 India time");
    expect(out).toContain("delhi, noida");
  });

  it("a switch-off 404 reads as Not switched on yet", async () => {
    h.weekly = new h.RequestError(404);
    h.definitions = new h.RequestError(404);
    const out = await render();
    expect(out).toContain("Not switched on yet");
    expect(out).not.toContain("The figures did not load");
  });

  it("a missing migration 503 reads as Try again later", async () => {
    h.weekly = new h.RequestError(503);
    const out = await render();
    expect(out).toContain("Try again later");
  });

  it("an unknown filter is the server's refusal, not an outage", async () => {
    h.weekly = new h.RequestError(400);
    const out = await render({ city: "atlantis" });
    expect(out).toContain("The server rejected that filter");
    expect(out).toContain("Clear filters");
  });
});
