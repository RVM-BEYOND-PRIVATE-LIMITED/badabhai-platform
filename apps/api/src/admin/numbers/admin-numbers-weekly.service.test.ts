import { ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { AdminNumbersWeeklyQuerySchema } from "./admin-numbers.dto";
import { AdminNumbersWeeklyService, weekOnWeekChange } from "./admin-numbers-weekly.service";
import { allNumbersMetrics, NUMBERS_SNAPSHOT_METRICS } from "./definitions";
import type { NumbersStoredCellRow, NumbersWeeklyRepository } from "./numbers-weekly.repository";

/**
 * #2755 item 5 — `GET /admin/numbers/weekly` over a fake snapshot: the shape, this week / last week
 * and the change, suppression, the filter reaching the read, `before_real_payments`, frozen weeks,
 * per-pack revenue, `not_available` figures and the 503 on a missing table.
 */

const NOW = new Date("2026-11-18T06:00:00.000Z"); // Wednesday 18 Nov 2026, IST
const THIS = "2026-11-16";
const LAST = "2026-11-09";
const BEFORE_LAST = "2026-11-02";

function row(
  weekStart: string,
  metric: string,
  value: number | null,
  over: Partial<NumbersStoredCellRow> = {},
): NumbersStoredCellRow {
  return {
    weekStart,
    metric,
    cityGroup: "all",
    tradeGroup: "all",
    value,
    numerator: null,
    denominator: null,
    suppressed: false,
    definitionVersion: 1,
    computedAt: new Date("2026-11-18T00:00:00.000Z"),
    frozenAt: null,
    ...over,
  };
}

function setup(
  cells: NumbersStoredCellRow[],
  firstPaidWeek: string | null = null,
  config: Partial<ServerConfig> = {},
  latestComplete: NumbersStoredCellRow[] = [],
) {
  const repo = {
    readCells: vi.fn(async () => cells),
    firstPaidWeek: vi.fn(async () => firstPaidWeek),
    readLatestCompleteCohorts: vi.fn(async () => latestComplete),
  };
  const service = new AdminNumbersWeeklyService(
    repo as unknown as NumbersWeeklyRepository,
    config as ServerConfig,
  );
  const query = (q: Record<string, unknown> = {}) => AdminNumbersWeeklyQuerySchema.parse(q);
  return { repo, service, query };
}

const metricOf = (out: { metrics: Array<{ id: string }> }, id: string) =>
  out.metrics.find((m) => m.id === id) as never as {
    id: string;
    availability: string;
    this_week: number | null;
    last_week: number | null;
    change: { absolute: number; percent: number | null } | null;
    series: Array<{
      week_start: string;
      value: number | null;
      suppressed: boolean;
      frozen: boolean;
      before_real_payments: boolean;
      numerator: number | null;
      denominator: number | null;
      definition_version: number | null;
    }>;
    reason?: string;
    waits_on?: string;
    pack?: string;
    list_route?: string;
    latest_complete?: Record<string, unknown> | null;
    kind: string;
    unit: string;
  };

describe("weekOnWeekChange", () => {
  const point = (value: number | null, over: Record<string, unknown> = {}) =>
    ({
      week_start: LAST,
      value,
      numerator: null,
      denominator: null,
      suppressed: false,
      pending: false,
      before_real_payments: false,
      frozen: false,
      definition_version: 1,
      ...over,
    }) as never;

  it("is the absolute difference and the percent of last week, one decimal", () => {
    expect(weekOnWeekChange(point(12), point(10))).toEqual({ absolute: 2, percent: 20 });
    expect(weekOnWeekChange(point(10), point(12))).toEqual({ absolute: -2, percent: -16.7 });
    expect(weekOnWeekChange(point(10), point(10))).toEqual({ absolute: 0, percent: 0 });
  });

  it("has no percent when last week is 0", () => {
    expect(weekOnWeekChange(point(5), point(0))).toEqual({ absolute: 5, percent: null });
  });

  it("is null when either week is suppressed, has no value, or was counted under another version", () => {
    expect(weekOnWeekChange(point(null, { suppressed: true }), point(9))).toBeNull();
    expect(weekOnWeekChange(point(9), point(null, { suppressed: true }))).toBeNull();
    expect(weekOnWeekChange(point(null), point(9))).toBeNull();
    expect(weekOnWeekChange(point(9), point(9, { definition_version: 2 }))).toBeNull();
    expect(weekOnWeekChange(undefined, point(9))).toBeNull();
  });

  it("does a ratio's arithmetic in hundredths, without float drift", () => {
    expect(weekOnWeekChange(point(2.3), point(2.1), 100)).toEqual({ absolute: 0.2, percent: 9.5 });
  });
});

describe("AdminNumbersWeeklyService.weekly", () => {
  it("reads the filter's own cells for the series weeks plus the week before, and nothing else", async () => {
    const { repo, service, query } = setup([]);
    const out = await service.weekly(
      query({ city: "pune", trade: "cnc_operator", weeks: "3" }),
      NOW,
    );
    expect(out.weeks).toEqual([BEFORE_LAST, LAST, THIS]);
    expect(repo.readCells).toHaveBeenCalledWith(
      ["2026-10-26", BEFORE_LAST, LAST, THIS],
      "pune",
      "cnc_operator",
    );
    expect(out).toMatchObject({ city: "pune", trade: "cnc_operator", definition_version: 2 });
    // …and the newest closed cohort of each repeat window, for the same filter, up to this week.
    expect(repo.readLatestCompleteCohorts).toHaveBeenCalledWith(THIS, "pune", "cnc_operator");
  });

  it("answers every catalogue metric, in catalogue order, live or not", async () => {
    const { service, query } = setup([]);
    const out = await service.weekly(query(), NOW);
    expect(out.metrics.map((m) => m.id)).toEqual(allNumbersMetrics().map((m) => m.id));
    for (const m of out.metrics) {
      const listed = m.id === "out_of_credits_companies";
      expect(m.availability, m.id).toBe(
        m.id in NUMBERS_SNAPSHOT_METRICS || listed ? "live" : "not_available",
      );
    }
  });

  it("gives this week, last week, the change and the series, oldest first", async () => {
    const { service, query } = setup([
      row(BEFORE_LAST, "paying_companies", 4, { frozenAt: new Date("2026-11-12T00:00:00Z") }),
      row(LAST, "paying_companies", 10),
      row(THIS, "paying_companies", 12),
    ]);
    const out = await service.weekly(query({ weeks: "2" }), NOW);
    const m = metricOf(out, "paying_companies");
    expect(m).toMatchObject({
      availability: "live",
      unit: "count",
      kind: "headline",
      this_week: 12,
      last_week: 10,
      change: { absolute: 2, percent: 20 },
    });
    expect(m.series.map((p) => [p.week_start, p.value])).toEqual([
      [LAST, 10],
      [THIS, 12],
    ]);
  });

  it("a one-week series still has a last week (the week before is read for it)", async () => {
    const { service, query } = setup([
      row(LAST, "paying_companies", 10),
      row(THIS, "paying_companies", 15),
    ]);
    const m = metricOf(await service.weekly(query({ weeks: "1" }), NOW), "paying_companies");
    expect(m.series).toHaveLength(1);
    expect(m).toMatchObject({ this_week: 15, last_week: 10, change: { absolute: 5, percent: 50 } });
  });

  it("a suppressed worker cell shows no number and no change", async () => {
    const { service, query } = setup([
      row(LAST, "completed_profiles", null, { suppressed: true, cityGroup: "pune" }),
      row(THIS, "completed_profiles", 7, { cityGroup: "pune" }),
    ]);
    const m = metricOf(
      await service.weekly(query({ city: "pune", weeks: "2" }), NOW),
      "completed_profiles",
    );
    expect(m.series[0]).toMatchObject({ value: null, suppressed: true });
    expect(m).toMatchObject({ this_week: 7, last_week: null, change: null });
  });

  it("a week not computed yet is null and not frozen; a frozen week says so", async () => {
    const { service, query } = setup([
      row(LAST, "companies_posted", 3, { frozenAt: new Date("2026-11-18T00:00:00Z") }),
    ]);
    const m = metricOf(await service.weekly(query({ weeks: "2" }), NOW), "companies_posted");
    expect(m.series).toEqual([
      expect.objectContaining({ week_start: LAST, value: 3, frozen: true, definition_version: 1 }),
      expect.objectContaining({
        week_start: THIS,
        value: null,
        frozen: false,
        definition_version: null,
      }),
    ]);
    expect(m.change).toBeNull();
  });

  it("marks every week before the first real payment's week, from the snapshot alone", async () => {
    const { service, query } = setup([], LAST);
    const m = metricOf(await service.weekly(query({ weeks: "3" }), NOW), "revenue_by_pack");
    expect(m.series.map((p) => [p.week_start, p.before_real_payments])).toEqual([
      [BEFORE_LAST, true],
      [LAST, false],
      [THIS, false],
    ]);
    const none = metricOf(
      await setup([], null).service.weekly(query({ weeks: "1" }), NOW),
      "revenue_by_pack",
    );
    expect(none.series[0]!.before_real_payments).toBe(true);
  });

  it("a ratio is the quotient with two decimals, its two terms beside it; no hire is null", async () => {
    const { service, query } = setup([
      row(LAST, "contacts_per_hire", null, { numerator: 3, denominator: 0 }),
      row(THIS, "contacts_per_hire", 250, { numerator: 5, denominator: 2 }),
    ]);
    const m = metricOf(await service.weekly(query({ weeks: "2" }), NOW), "contacts_per_hire");
    expect(m.unit).toBe("ratio");
    expect(m.series[1]).toMatchObject({ value: 2.5, numerator: 5, denominator: 2 });
    expect(m.series[0]).toMatchObject({ value: null, numerator: 3, denominator: 0 });
    expect(m).toMatchObject({ this_week: 2.5, last_week: null, change: null });
  });

  it("lists one revenue figure per stored pack after the total; a computed week with no pack row is 0", async () => {
    const { service, query } = setup([
      row(LAST, "revenue_by_pack", 200_000),
      row(LAST, "revenue_by_pack:pack_50", 200_000),
      row(THIS, "revenue_by_pack", 800_000),
      row(THIS, "revenue_by_pack:pack_50", 0),
      row(THIS, "revenue_by_pack:pack_200", 800_000),
    ]);
    const out = await service.weekly(query({ weeks: "2" }), NOW);
    const ids = out.metrics.map((m) => m.id);
    const at = ids.indexOf("revenue_by_pack");
    expect(ids.slice(at, at + 3)).toEqual([
      "revenue_by_pack",
      "revenue_by_pack:pack_200",
      "revenue_by_pack:pack_50",
    ]);
    const p200 = metricOf(out, "revenue_by_pack:pack_200");
    expect(p200).toMatchObject({
      pack: "pack_200",
      unit: "paise",
      this_week: 800_000,
      last_week: 0,
    });
    expect(p200.change).toEqual({ absolute: 800_000, percent: null });
    expect(metricOf(out, "revenue_by_pack:pack_50").change).toEqual({
      absolute: -200_000,
      percent: -100,
    });
  });

  it("a not_available figure carries its reason and the issue it waits on, never a zero", async () => {
    const { service, query } = setup([]);
    const out = await service.weekly(query(), NOW);
    for (const id of ["revenue_gst_split", "posting_choice_free_share", "revenue_managed_hiring"]) {
      const m = metricOf(out, id);
      expect(m.availability, id).toBe("not_available");
      expect(m.reason?.length, id).toBeGreaterThan(5);
      expect(m.waits_on, id).toMatch(/^#27\d\d$/);
      expect(m).toMatchObject({ this_week: null, last_week: null, change: null, series: [] });
    }
  });

  it("the call list is live as a LIST: its route, no values and no series, never a zero", async () => {
    const { service, query } = setup([row(THIS, "paying_companies", 1)]);
    const m = metricOf(await service.weekly(query(), NOW), "out_of_credits_companies");
    expect(m).toMatchObject({
      availability: "live",
      list_route: "GET /admin/numbers/out-of-credits",
      this_week: null,
      last_week: null,
      change: null,
      series: [],
    });
    expect(m.reason).toBeUndefined();
  });

  it("repeat buying: a share in hundredths, PENDING points with the cohort size only, and the newest closed cohort", async () => {
    const OLD = "2026-08-03";
    const { service, query } = setup(
      [
        // Last week's and this week's cohorts are still open (pending): no share, the cohort size.
        row(LAST, "repeat_purchase_30d", null, { numerator: null, denominator: 4 }),
        row(THIS, "repeat_purchase_30d", null, { numerator: null, denominator: 2 }),
        // Two weeks ago the 30-day window had closed on an empty cohort: no share, not pending.
        row(BEFORE_LAST, "repeat_purchase_30d", null, { numerator: 0, denominator: 0 }),
        row(THIS, "paying_companies", 2),
      ],
      null,
      {},
      [
        row(OLD, "repeat_purchase_30d", 33, {
          numerator: 1,
          denominator: 3,
          frozenAt: new Date("2026-11-10T00:00:00.000Z"),
        }),
      ],
    );
    const out = await service.weekly(query({ weeks: "3" }), NOW);
    const m30 = metricOf(out, "repeat_purchase_30d");
    expect(m30).toMatchObject({
      availability: "live",
      unit: "share",
      this_week: null,
      change: null,
    });
    expect(
      m30.series.map((p) => [p.week_start, p.value, (p as never as { pending: boolean }).pending]),
    ).toEqual([
      [BEFORE_LAST, null, false],
      [LAST, null, true],
      [THIS, null, true],
    ]);
    expect(m30.series[2]).toMatchObject({ numerator: null, denominator: 2 });
    // The headline: the newest closed cohort, its share as a fraction (33 hundredths = 0.33).
    expect(m30.latest_complete).toMatchObject({
      week_start: OLD,
      value: 0.33,
      numerator: 1,
      denominator: 3,
      pending: false,
      frozen: true,
    });
    // No closed cohort yet for the 90-day window: null, never a zero.
    expect(metricOf(out, "repeat_purchase_90d").latest_complete).toBeNull();
    // Every other metric's points are never pending, and carry no latest_complete.
    const paying = metricOf(out, "paying_companies");
    for (const p of paying.series) expect((p as never as { pending: boolean }).pending).toBe(false);
    expect(paying.latest_complete).toBeUndefined();
  });

  it("the diagnostic is served as a diagnostic", async () => {
    const { service, query } = setup([
      row(THIS, "form_completed_unconfirmed", 6, { numerator: 6, denominator: 8 }),
    ]);
    const m = metricOf(
      await service.weekly(query({ weeks: "1" }), NOW),
      "form_completed_unconfirmed",
    );
    expect(m).toMatchObject({ kind: "diagnostic", this_week: 6 });
    expect(m.series[0]).toMatchObject({ numerator: 6, denominator: 8 });
  });

  it("carries the payments posture beside the money and the newest computed time", async () => {
    const { service, query } = setup([row(THIS, "paying_companies", 1)]);
    const out = await service.weekly(query(), NOW);
    expect(out.payments_posture.mode).toBe("mock");
    expect(out.computed_at).toBe("2026-11-18T00:00:00.000Z");
    expect((await setup([]).service.weekly(query(), NOW)).computed_at).toBeNull();
  });

  it("answers 503 when the snapshot table is missing (42P01), and rethrows anything else", async () => {
    const { repo, service, query } = setup([]);
    repo.readCells.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "42P01" }));
    await expect(service.weekly(query(), NOW)).rejects.toBeInstanceOf(ServiceUnavailableException);
    const boom = new Error("boom");
    repo.readCells.mockRejectedValueOnce(boom);
    await expect(service.weekly(query(), NOW)).rejects.toBe(boom);
  });
});
