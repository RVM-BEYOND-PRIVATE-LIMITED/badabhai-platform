import { describe, expect, it } from "vitest";
import { UNKNOWN_DIMS, type NumbersDims, type NumbersMetricCells } from "./cells";
import { computeCohortWeek, type NumbersWeekSources } from "./compute-week";
import {
  cohortOf,
  isPendingCohortCell,
  paidAgainWithin,
  repeatPurchase,
  repeatWindowClosesAt,
  repeatWindowComplete,
} from "./repeat-purchase";
import { weekWindow, type NumbersDimsLookup, type NumbersPaidOrderRow } from "./types";

/**
 * #2755 item 7 — repeat buying over hand-written orders: the cohort (FIRST paid order ever in the
 * week, India time), the 30/60/90-day windows measured from each company's own first payment, the
 * PENDING rule (a window not elapsed for every company of the cohort stores no share), and the
 * per-cell shares in hundredths.
 */

const WEEK = "2026-09-07"; // Monday 7 Sep … Sunday 13 Sep 2026, India time
const W = weekWindow(WEEK);
const MONDAY_START = new Date("2026-09-06T18:30:00.000Z");
const SUNDAY_END = new Date("2026-09-13T18:29:59.999Z");
const NEXT_MONDAY = new Date("2026-09-13T18:30:00.000Z");
const BEFORE = new Date("2026-09-06T18:29:59.999Z");
const DAY = 24 * 60 * 60 * 1000;
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);

const PUNE_CNC: NumbersDims = { city: "pune", trade: "cnc_operator" };
const NCR_CAD: NumbersDims = { city: "ncr", trade: "cad_3d_designer" };
const dimsOf =
  (map: Record<string, NumbersDims>): NumbersDimsLookup =>
  (id) =>
    map[id] ?? UNKNOWN_DIMS;

const order = (payerId: string, settledAt: Date): NumbersPaidOrderRow => ({
  payerId,
  packCode: "pack_50",
  amountInr: 2000,
  settledAt,
});
const byId = (metrics: NumbersMetricCells[], id: string) => metrics.find((m) => m.metric === id)!;
const at = (m: NumbersMetricCells, city = "all", trade = "all") =>
  m.cells.find((c) => c.cityGroup === city && c.tradeGroup === trade)!;

/** Long after every window: all three are complete. */
const LATER = plus(NEXT_MONDAY, 200 * DAY);

describe("the cohort", () => {
  it("is every company whose FIRST paid order ever settled in the week (India time, both edges)", () => {
    const cohort = cohortOf(W, [
      order("first-instant", MONDAY_START),
      order("last-instant", SUNDAY_END),
      order("next-week", NEXT_MONDAY),
      order("before", BEFORE),
      // An older first payment keeps a company out even when it pays again in the week.
      order("old-buyer", BEFORE),
      order("old-buyer", plus(MONDAY_START, DAY)),
    ]);
    expect(cohort.map((c) => c.payerId).sort()).toEqual(["first-instant", "last-instant"]);
  });

  it("measures the gap from each company's own first payment to its second (later ones ignored)", () => {
    const [c] = cohortOf(W, [
      order("a", plus(MONDAY_START, 50 * DAY)),
      order("a", plus(MONDAY_START, DAY)),
      order("a", MONDAY_START),
    ]);
    expect(c).toMatchObject({ payerId: "a", firstAt: MONDAY_START, gapMs: DAY });
  });

  it("a single order has no second; two settled at one instant are 0 ms apart", () => {
    expect(cohortOf(W, [order("a", MONDAY_START)])[0]!.gapMs).toBeNull();
    expect(cohortOf(W, [order("a", MONDAY_START), order("a", MONDAY_START)])[0]!.gapMs).toBe(0);
  });

  it("'within N days' is at most N × 24 hours after the first payment", () => {
    const company = (gapMs: number | null) => ({ payerId: "a", firstAt: MONDAY_START, gapMs });
    expect(paidAgainWithin(company(30 * DAY), 30)).toBe(true);
    expect(paidAgainWithin(company(30 * DAY + 1), 30)).toBe(false);
    expect(paidAgainWithin(company(30 * DAY + 1), 60)).toBe(true);
    expect(paidAgainWithin(company(0), 30)).toBe(true);
    expect(paidAgainWithin(company(null), 90)).toBe(false);
  });
});

describe("the pending rule", () => {
  it("a window closes N days after the week ends — the latest first payment the cohort can hold", () => {
    expect(repeatWindowClosesAt(W, 30).toISOString()).toBe("2026-10-13T18:30:00.000Z");
    expect(repeatWindowComplete(W, 30, new Date("2026-10-13T18:29:59.999Z"))).toBe(false);
    expect(repeatWindowComplete(W, 30, new Date("2026-10-13T18:30:00.000Z"))).toBe(true);
    expect(repeatWindowClosesAt(W, 90).toISOString()).toBe("2026-12-12T18:30:00.000Z");
  });

  it("a pending window stores the cohort size and NO share (never a partial one)", () => {
    const orders = [order("a", MONDAY_START), order("a", plus(MONDAY_START, DAY))];
    // 40 days after the week: 30 closed, 60 and 90 still open.
    const out = repeatPurchase(W, orders, dimsOf({}), plus(NEXT_MONDAY, 40 * DAY));
    expect(at(byId(out, "repeat_purchase_30d"))).toMatchObject({
      value: 100,
      numerator: 1,
      denominator: 1,
    });
    for (const id of ["repeat_purchase_60d", "repeat_purchase_90d"]) {
      const cell = at(byId(out, id));
      expect(cell, id).toMatchObject({ value: null, numerator: null, denominator: 1 });
      expect(isPendingCohortCell(cell), id).toBe(true);
    }
    expect(isPendingCohortCell(at(byId(out, "repeat_purchase_30d")))).toBe(false);
  });

  it("an empty cohort: pending stores 0 companies and no numerator; closed stores 0 of 0, no share", () => {
    const open = repeatPurchase(W, [], dimsOf({}), NEXT_MONDAY);
    expect(at(byId(open, "repeat_purchase_30d"))).toMatchObject({
      value: null,
      numerator: null,
      denominator: 0,
    });
    const closed = repeatPurchase(W, [], dimsOf({}), LATER);
    const cell = at(byId(closed, "repeat_purchase_90d"));
    expect(cell).toMatchObject({ value: null, numerator: 0, denominator: 0, suppressed: false });
    expect(isPendingCohortCell(cell)).toBe(false);
  });
});

describe("the shares", () => {
  const orders = [
    // a: Pune, paid again after 10 days → in all three windows.
    order("a", MONDAY_START),
    order("a", plus(MONDAY_START, 10 * DAY)),
    // b: Pune, paid again after exactly 45 days → 60 and 90 only.
    order("b", plus(MONDAY_START, 2 * DAY)),
    order("b", plus(MONDAY_START, 47 * DAY)),
    // c: NCR, paid again after 91 days → in none.
    order("c", SUNDAY_END),
    order("c", plus(SUNDAY_END, 91 * DAY)),
    // d: no posting (unknown), one order only.
    order("d", plus(MONDAY_START, 3 * DAY)),
    // e: first paid before the week — never in this cohort.
    order("e", BEFORE),
    order("e", plus(MONDAY_START, DAY)),
  ];
  const dims = dimsOf({ a: PUNE_CNC, b: PUNE_CNC, c: NCR_CAD, e: PUNE_CNC });
  const out = repeatPurchase(W, orders, dims, LATER);

  it("count once per company, in its own cell and every roll-up, as shares in hundredths", () => {
    expect(at(byId(out, "repeat_purchase_30d"))).toMatchObject({
      value: 25,
      numerator: 1,
      denominator: 4,
    });
    expect(at(byId(out, "repeat_purchase_60d"))).toMatchObject({
      value: 50,
      numerator: 2,
      denominator: 4,
    });
    expect(at(byId(out, "repeat_purchase_90d"))).toMatchObject({ numerator: 2, denominator: 4 });
    expect(at(byId(out, "repeat_purchase_30d"), "pune", "cnc_operator")).toMatchObject({
      value: 50,
      numerator: 1,
      denominator: 2,
    });
    expect(at(byId(out, "repeat_purchase_60d"), "pune", "all")).toMatchObject({
      value: 100,
      numerator: 2,
      denominator: 2,
    });
    expect(at(byId(out, "repeat_purchase_90d"), "ncr", "cad_3d_designer")).toMatchObject({
      value: 0,
      numerator: 0,
      denominator: 1,
    });
    expect(at(byId(out, "repeat_purchase_90d"), "unknown", "unknown")).toMatchObject({
      numerator: 0,
      denominator: 1,
    });
    // An empty cell of a closed window has no share, never a 0 that reads as "nobody repeated".
    expect(at(byId(out, "repeat_purchase_90d"), "ahmedabad", "all")).toMatchObject({
      value: null,
      numerator: 0,
      denominator: 0,
    });
  });

  it("rounds a share half up in hundredths (1 of 3 = 33, 2 of 3 = 67)", () => {
    const three = [
      order("x", MONDAY_START),
      order("x", plus(MONDAY_START, DAY)),
      order("y", MONDAY_START),
      order("y", plus(MONDAY_START, DAY)),
      order("z", MONDAY_START),
    ];
    const r = repeatPurchase(W, three, dimsOf({}), LATER);
    expect(at(byId(r, "repeat_purchase_30d")).value).toBe(67);
    const one = repeatPurchase(W, three.slice(0, 2).concat(three.slice(4)), dimsOf({}), LATER);
    expect(at(byId(one, "repeat_purchase_30d"))).toMatchObject({ value: 50, denominator: 2 });
    const third = repeatPurchase(
      W,
      [...three.slice(0, 2), order("y", MONDAY_START), order("z", MONDAY_START)],
      dimsOf({}),
      LATER,
    );
    expect(at(byId(third, "repeat_purchase_30d")).value).toBe(33);
  });

  it("never suppresses a company figure, and every metric has its 42 cells", () => {
    for (const m of out) {
      expect(m.cells).toHaveLength(42);
      for (const c of m.cells) expect(c.suppressed).toBe(false);
    }
  });
});

describe("computeCohortWeek", () => {
  it("reads only the cohort orders and the cohort's companies, and returns the three windows", async () => {
    const calls: string[] = [];
    const never = async () => {
      throw new Error("not a cohort read");
    };
    const sources = {
      paidOrders: never,
      firstPublications: never,
      currentProfiles: never,
      activity: never,
      confirmedHires: never,
      openedContacts: never,
      formCompletions: never,
      welcomeRunOuts: never,
      reachCases: never,
      waivedOpens: never,
      workerDims: never,
      cohortOrders: async () => {
        calls.push("cohortOrders");
        return [order("a", MONDAY_START), order("old", BEFORE)];
      },
      companyDims: async (ids: readonly string[]) => {
        calls.push(`companyDims:${[...ids].sort().join(",")}`);
        return new Map([["a", PUNE_CNC]]);
      },
    } as unknown as NumbersWeekSources;
    const out = await computeCohortWeek(sources, WEEK, LATER);
    expect(calls).toEqual(["cohortOrders", "companyDims:a"]);
    expect(out.map((m) => m.metric)).toEqual([
      "repeat_purchase_30d",
      "repeat_purchase_60d",
      "repeat_purchase_90d",
    ]);
    expect(at(byId(out, "repeat_purchase_30d"), "pune", "cnc_operator")).toMatchObject({
      numerator: 0,
      denominator: 1,
    });
  });
});
