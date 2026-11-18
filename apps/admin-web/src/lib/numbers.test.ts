import { beforeEach, describe, expect, it, vi } from "vitest";

const adminFetch = vi.fn();

vi.mock("./admin-http", () => ({
  adminFetch: (...args: unknown[]) => adminFetch(...args),
}));

const {
  getWeeklyNumbers,
  getNumbersDefinitions,
  listOutOfCredits,
  listLaunchCohort,
  getContactsPerHire,
} = await import("./numbers");

beforeEach(() => {
  adminFetch.mockReset();
  adminFetch.mockResolvedValue({});
});

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

describe("the weekly read", () => {
  it("sends only the filters that are set, and parses a live, a suppressed and a pending point", async () => {
    adminFetch.mockResolvedValueOnce({
      definition_version: 1,
      payments_posture: { mode: "mock", blocked_reason: "PAYMENTS_ENABLE_REAL=false" },
      city: "pune",
      trade: "cnc_operator",
      weeks: ["2026-11-09"],
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
          last_week: 3,
          change: { absolute: 1, percent: 33.3 },
          series: [point(3), point(null, { suppressed: true }), point(null, { pending: true })],
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
      ],
    });

    const body = await getWeeklyNumbers({ city: "pune", trade: "cnc_operator", weeks: 8 });
    expect(adminFetch).toHaveBeenCalledWith(
      "/admin/numbers/weekly?city=pune&trade=cnc_operator&weeks=8",
      expect.objectContaining({ schema: expect.anything() }),
    );
    expect(body.metrics[0]?.series[1]?.pending).toBe(false);
    expect(body.metrics[0]?.series[2]?.pending).toBe(true);
    expect(body.metrics[1]?.latest_complete?.value).toBe(0.5);
  });

  it("omits the query entirely for the defaults", async () => {
    adminFetch.mockResolvedValueOnce({
      definition_version: 1,
      payments_posture: { mode: "real", blocked_reason: null },
      city: "all",
      trade: "all",
      weeks: [],
      computed_at: null,
      metrics: [],
    });
    await getWeeklyNumbers();
    expect(adminFetch).toHaveBeenCalledWith("/admin/numbers/weekly", expect.anything());
  });
});

describe("the definitions read", () => {
  it("keeps an absent reason off a live metric", async () => {
    adminFetch.mockResolvedValueOnce({
      definition_version: 1,
      week: {
        rule: "Monday to Sunday",
        time_zone: "Asia/Kolkata",
        utc_offset: "+05:30",
        starts_on: "monday",
      },
      cities: { normalisation: "lower case", buckets: "other/unknown", groups: [] },
      trades: { buckets: "other/unknown", groups: [] },
      exclusions: { companies: "test companies", workers: "sample workers" },
      metric_groups: [
        {
          number: 1,
          id: "paying",
          title: "Paying",
          metrics: [
            {
              id: "paying_companies",
              title: "Paying companies",
              unit: "count",
              source: "payment_orders",
              rule: "Counted in the week",
              availability: { status: "live" },
              kind: "headline",
            },
          ],
        },
      ],
      small_cell_floor: 5,
      payments: { mode: "mock", blocked_reason: null },
    });
    const body = await getNumbersDefinitions();
    expect(body.metric_groups[0]?.metrics[0]?.availability).toEqual({ status: "live" });
  });
});

describe("the call list", () => {
  it("passes the keyset cursor and keeps a name absent when the route withheld it", async () => {
    adminFetch.mockResolvedValueOnce({
      rows: [
        {
          payer_id: "8a110000-0001-4a00-8000-000000000001",
          ran_out_at: "2026-11-01T00:00:00.000Z",
          last_purchase: null,
          last_open_at: null,
          last_call: null,
        },
      ],
      next_cursor: "next",
      accounts_link_hint: true,
    });
    const body = await listOutOfCredits({ cursor: "abc" });
    expect(adminFetch).toHaveBeenCalledWith(
      "/admin/numbers/out-of-credits?limit=50&cursor=abc",
      expect.anything(),
    );
    expect(body.rows[0]).not.toHaveProperty("org_name");
  });
});

describe("the launch-test reads", () => {
  it("reads a cohort page without a cursor and keeps a disclosed null name", async () => {
    adminFetch.mockResolvedValueOnce({
      rows: [
        {
          id: "0d110000-0001-4a00-8000-000000000001",
          factory_name: null,
          has_phone: true,
          city_group: "ncr",
          trade_group: "cnc_operator",
          payer_id: null,
          sent_by_admin_id: "a-1",
          sent_at: "2026-11-01T00:00:00.000Z",
          payment_link_ref: null,
          link_created_at: null,
          result: "pending",
          paid_at: null,
          payment_order_id: null,
          share_count: 2,
          worker_ids: [
            "8a110000-0001-4a00-8000-000000000001",
            "8a110000-0001-4a00-8000-000000000002",
          ],
          created_at: "2026-11-01T00:00:00.000Z",
          updated_at: "2026-11-01T00:00:00.000Z",
          updated_by_admin_id: "a-1",
        },
      ],
      next_cursor: null,
    });
    const body = await listLaunchCohort();
    expect(adminFetch).toHaveBeenCalledWith(
      "/admin/launch-tests/cohort?limit=50",
      expect.anything(),
    );
    expect(body.rows[0]?.factory_name).toBeNull();
  });

  it("reads the contacts-per-hire report and keeps 0/0 as a fraction", async () => {
    adminFetch.mockResolvedValueOnce({
      limit: 50,
      hires: [],
      totals: {
        hires_listed: 0,
        hires_counted: 0,
        contacts_opened: 0,
        contacts_per_hire: { numerator: 0, denominator: 0 },
      },
    });
    const body = await getContactsPerHire();
    expect(body.totals.contacts_per_hire).toEqual({ numerator: 0, denominator: 0 });
  });
});
