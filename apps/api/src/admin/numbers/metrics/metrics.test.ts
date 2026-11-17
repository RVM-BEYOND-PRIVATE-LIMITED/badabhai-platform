import { describe, expect, it } from "vitest";
import { activeWorkers30d, lastActiveDayAsOfWeekEnd } from "./active-workers";
import { UNKNOWN_DIMS, type NumbersDims, type NumbersMetricCells } from "./cells";
import { companiesPosted } from "./companies-posted";
import { completedProfiles } from "./completed-profiles";
import { computeNumbersWeek, type NumbersWeekSources } from "./compute-week";
import { confirmedHires } from "./confirmed-hires";
import { contactsPerHire } from "./contacts-per-hire";
import { formCompletedUnconfirmed } from "./form-completed-unconfirmed";
import { payingCompanies } from "./paying-companies";
import { revenueByPack } from "./revenue-by-pack";
import { weekWindow, type NumbersDimsLookup } from "./types";

/**
 * #2755 part B — each metric function over hand-written source rows: the week edges (India time),
 * once-per-company counting, cumulative variants, the small-cell floor on worker figures only, the
 * ratio's null, per-pack revenue and the form-worker gap.
 */

const WEEK = "2026-11-09"; // Monday 9 Nov 2026 … Sunday 15 Nov, India time
const W = weekWindow(WEEK);
/** Monday 00:00 IST = Sunday 18:30 UTC. */
const MONDAY_START = new Date("2026-11-08T18:30:00.000Z");
/** The last millisecond of the week: Sunday 23:59:59.999 IST. */
const SUNDAY_END = new Date("2026-11-15T18:29:59.999Z");
const NEXT_MONDAY = new Date("2026-11-15T18:30:00.000Z");
const BEFORE = new Date("2026-11-08T18:29:59.999Z");

const PUNE_CNC: NumbersDims = { city: "pune", trade: "cnc_operator" };
const NCR_CAD: NumbersDims = { city: "ncr", trade: "cad_3d_designer" };
const dimsOf =
  (map: Record<string, NumbersDims>): NumbersDimsLookup =>
  (id) =>
    map[id] ?? UNKNOWN_DIMS;

const byId = (metrics: NumbersMetricCells[], id: string) => metrics.find((m) => m.metric === id)!;
const at = (m: NumbersMetricCells, city: string, trade: string) =>
  m.cells.find((c) => c.cityGroup === city && c.tradeGroup === trade)!;
const total = (m: NumbersMetricCells) => at(m, "all", "all").value;

describe("the week window", () => {
  it("is Monday 00:00 to Sunday 23:59:59.999 India time", () => {
    expect(W).toEqual({
      week: WEEK,
      sunday: "2026-11-15",
      fromUtc: MONDAY_START,
      toUtcExclusive: NEXT_MONDAY,
    });
  });
});

describe("payingCompanies", () => {
  const order = (payerId: string, settledAt: Date) => ({
    payerId,
    packCode: "pack_50",
    amountInr: 2000,
    settledAt,
  });
  const dims = dimsOf({ a: PUNE_CNC, b: NCR_CAD, c: PUNE_CNC });
  const out = payingCompanies(
    W,
    [
      order("a", MONDAY_START),
      order("a", SUNDAY_END), // the same company twice: once
      order("b", BEFORE), // the week before: cumulative only
      order("c", NEXT_MONDAY), // the next week: neither
    ],
    dims,
  );

  it("counts each company once in the week, at its own city and trade, on the India-time edges", () => {
    const week = byId(out, "paying_companies");
    expect(total(week)).toBe(1);
    expect(at(week, "pune", "cnc_operator").value).toBe(1);
    expect(at(week, "ncr", "all").value).toBe(0);
  });

  it("the cumulative variant counts every company that paid by the week's end", () => {
    const cum = byId(out, "paying_companies_cumulative");
    expect(total(cum)).toBe(2);
    expect(at(cum, "ncr", "cad_3d_designer").value).toBe(1);
  });

  it("company figures are never suppressed", () => {
    for (const m of out) for (const c of m.cells) expect(c.suppressed).toBe(false);
  });
});

describe("companiesPosted", () => {
  const out = companiesPosted(
    W,
    [
      { payerId: "a", firstPublishedAt: SUNDAY_END },
      { payerId: "b", firstPublishedAt: BEFORE },
      { payerId: "c", firstPublishedAt: NEXT_MONDAY },
    ],
    dimsOf({ a: PUNE_CNC }),
  );

  it("counts a company in the week of its FIRST publish only", () => {
    expect(total(byId(out, "companies_posted"))).toBe(1);
    expect(at(byId(out, "companies_posted"), "pune", "cnc_operator").value).toBe(1);
  });

  it("the cumulative variant is every first publish by the week's end; an unplaced one is unknown", () => {
    const cum = byId(out, "companies_posted_cumulative");
    expect(total(cum)).toBe(2);
    expect(at(cum, "unknown", "unknown").value).toBe(1);
  });
});

describe("completedProfiles", () => {
  const confirmed = (workerId: string, confirmedAt: Date | null, status = "confirmed") => ({
    workerId,
    status,
    confirmedAt,
  });
  const six = Array.from({ length: 6 }, (_, i) => confirmed(`p${i}`, MONDAY_START));
  const out = completedProfiles(
    W,
    [
      ...six,
      confirmed("n1", SUNDAY_END),
      confirmed("old", BEFORE),
      confirmed("draft", MONDAY_START, "extracted"), // not confirmed: never counted
      confirmed("noTime", null), // confirmed with no time: cannot be placed in a week
    ],
    dimsOf({ ...Object.fromEntries(six.map((p) => [p.workerId, PUNE_CNC])), n1: NCR_CAD }),
  );

  it("counts current profiles confirmed in the week (the funnel's rule)", () => {
    const week = byId(out, "completed_profiles");
    expect(total(week)).toBe(7);
    expect(at(week, "pune", "cnc_operator").value).toBe(6);
  });

  it("suppresses a worker cell under the floor of 5, never the total", () => {
    const week = byId(out, "completed_profiles");
    expect(at(week, "ncr", "cad_3d_designer")).toMatchObject({ value: null, suppressed: true });
    expect(at(week, "ncr", "all")).toMatchObject({ value: null, suppressed: true });
    expect(at(week, "all", "all")).toMatchObject({ value: 7, suppressed: false });
  });

  it("the cumulative variant is every confirmation by the week's end", () => {
    expect(total(byId(out, "completed_profiles_cumulative"))).toBe(8);
  });
});

describe("activeWorkers30d", () => {
  const row = (workerId: string, activeOn: string | null, lastSeenAt: Date | null = null) => ({
    workerId,
    activeOn,
    lastSeenAt,
  });

  it("reuses #2753's last active day: the later of the activity day and the device day", () => {
    expect(lastActiveDayAsOfWeekEnd(row("a", "2026-11-01", MONDAY_START), W)).toBe("2026-11-09");
    expect(lastActiveDayAsOfWeekEnd(row("a", "2026-11-14", MONDAY_START), W)).toBe("2026-11-14");
    expect(lastActiveDayAsOfWeekEnd(row("a", null, null), W)).toBeNull();
  });

  it("never reads a device sighting after the week's end", () => {
    expect(lastActiveDayAsOfWeekEnd(row("a", "2026-10-01", NEXT_MONDAY), W)).toBe("2026-10-01");
    expect(lastActiveDayAsOfWeekEnd(row("a", null, SUNDAY_END), W)).toBe("2026-11-15");
  });

  it("is active when the last active day is in the 30 days ending on the Sunday", () => {
    const rows = [
      row("in1", "2026-11-15"), // the Sunday itself
      row("in2", "2026-10-17"), // 29 days before: the window's first day
      row("out", "2026-10-16"), // 30 days before: outside
      row("dev", null, new Date("2026-10-17T00:00:00.000Z")), // device day 2026-10-17 IST
    ];
    const m = byId(activeWorkers30d(W, rows, dimsOf({})), "active_workers_30d");
    expect(total(m)).toBe(3);
    // All four unplaced: unknown × unknown, three of them — under the floor, suppressed.
    expect(at(m, "unknown", "unknown")).toMatchObject({ value: null, suppressed: true });
  });
});

describe("confirmedHires and contactsPerHire", () => {
  const hires = [
    { payerId: "a", hiredOn: "2026-11-09" },
    { payerId: "a", hiredOn: "2026-11-15" },
    { payerId: "b", hiredOn: "2026-11-08" }, // the Sunday before
    { payerId: "c", hiredOn: "2026-11-16" }, // the Monday after: not yet
  ];
  const dims = dimsOf({ a: PUNE_CNC, b: NCR_CAD });

  it("counts confirmed hire RECORDS by hired_on, two from one company being two", () => {
    const out = confirmedHires(W, hires, dims);
    expect(total(byId(out, "confirmed_hires"))).toBe(2);
    expect(at(byId(out, "confirmed_hires"), "pune", "cnc_operator").value).toBe(2);
    expect(total(byId(out, "confirmed_hires_cumulative"))).toBe(3);
  });

  it("contacts per hire: opens in the week over hires in the week, in hundredths, both terms kept", () => {
    const opened = [
      ...Array.from({ length: 5 }, () => ({ payerId: "a", grantedAt: MONDAY_START })),
      { payerId: "b", grantedAt: SUNDAY_END },
      { payerId: "a", grantedAt: BEFORE }, // last week's open
    ];
    const m = byId(contactsPerHire(W, opened, hires, dims), "contacts_per_hire");
    expect(at(m, "all", "all")).toMatchObject({ value: 300, numerator: 6, denominator: 2 });
    expect(at(m, "pune", "cnc_operator")).toMatchObject({
      value: 250,
      numerator: 5,
      denominator: 2,
    });
    // NCR opened one contact and hired nobody this week: not computable, never zero.
    expect(at(m, "ncr", "cad_3d_designer")).toMatchObject({
      value: null,
      numerator: 1,
      denominator: 0,
      suppressed: false,
    });
  });
});

describe("revenueByPack", () => {
  const order = (payerId: string, packCode: string, amountInr: number, settledAt: Date) => ({
    payerId,
    packCode,
    amountInr,
    settledAt,
  });
  const out = revenueByPack(
    W,
    [
      order("a", "pack_50", 2000, MONDAY_START),
      order("a", "pack_200", 8000, SUNDAY_END),
      order("b", "pack_50", 2000, BEFORE), // sold before: pack_50 already exists
      order("c", "pack_1000", 32000, NEXT_MONDAY), // after the week: no row yet
      order("a", "Weird Code!", 1, MONDAY_START),
    ],
    dimsOf({ a: PUNE_CNC }),
  );

  it("the total is amount_inr × 100, in paise, for the week's paid orders", () => {
    expect(total(byId(out, "revenue_by_pack"))).toBe(1_000_100);
    expect(at(byId(out, "revenue_by_pack"), "pune", "cnc_operator").value).toBe(1_000_100);
  });

  it("one figure per pack paid for by the week's end, a malformed code folded into other", () => {
    expect(out.map((m) => m.metric)).toEqual([
      "revenue_by_pack",
      "revenue_by_pack:other",
      "revenue_by_pack:pack_200",
      "revenue_by_pack:pack_50",
    ]);
    expect(total(byId(out, "revenue_by_pack:pack_50"))).toBe(200_000);
    expect(total(byId(out, "revenue_by_pack:pack_200"))).toBe(800_000);
    expect(total(byId(out, "revenue_by_pack:other"))).toBe(100);
  });
});

describe("formCompletedUnconfirmed (diagnostic)", () => {
  const done = (workerId: string, firstCompletedAt: Date, profileConfirmed: boolean) => ({
    workerId,
    firstCompletedAt,
    profileConfirmed,
  });
  const rows = [
    ...Array.from({ length: 6 }, (_, i) => done(`u${i}`, MONDAY_START, false)),
    done("c1", SUNDAY_END, true),
    done("c2", SUNDAY_END, true),
    done("late", NEXT_MONDAY, false), // next week's
    done("u0", SUNDAY_END, false), // a second completion: counted once
  ];
  const m = byId(
    formCompletedUnconfirmed(W, rows, dimsOf({ u0: PUNE_CNC, u1: PUNE_CNC })),
    "form_completed_unconfirmed",
  );

  it("the value is the unconfirmed count; the terms are it and every finisher of the week", () => {
    expect(at(m, "all", "all")).toMatchObject({ value: 6, numerator: 6, denominator: 8 });
  });

  it("is a worker figure: small cells suppressed", () => {
    expect(at(m, "pune", "cnc_operator")).toMatchObject({ value: null, suppressed: true });
    expect(at(m, "unknown", "unknown")).toMatchObject({ value: null, suppressed: true });
  });
});

describe("computeNumbersWeek", () => {
  it("reads every source once, places each company and worker, and returns every stored metric", async () => {
    const calls: string[] = [];
    const sources: NumbersWeekSources = {
      paidOrders: async () => {
        calls.push("paidOrders");
        return [{ payerId: "a", packCode: "pack_50", amountInr: 2000, settledAt: MONDAY_START }];
      },
      firstPublications: async () => {
        calls.push("firstPublications");
        return [{ payerId: "b", firstPublishedAt: MONDAY_START }];
      },
      currentProfiles: async () => {
        calls.push("currentProfiles");
        return [{ workerId: "w1", status: "confirmed", confirmedAt: MONDAY_START }];
      },
      activity: async () => {
        calls.push("activity");
        return [{ workerId: "w2", activeOn: "2026-11-10", lastSeenAt: null }];
      },
      confirmedHires: async () => {
        calls.push("confirmedHires");
        return [{ payerId: "a", hiredOn: "2026-11-10" }];
      },
      openedContacts: async () => {
        calls.push("openedContacts");
        return [{ payerId: "a", grantedAt: MONDAY_START }];
      },
      formCompletions: async () => {
        calls.push("formCompletions");
        return [{ workerId: "w3", firstCompletedAt: MONDAY_START, profileConfirmed: false }];
      },
      companyDims: async (ids) => {
        calls.push(`companyDims:${[...new Set(ids)].sort().join(",")}`);
        return new Map([["a", PUNE_CNC]]);
      },
      workerDims: async (ids) => {
        calls.push(`workerDims:${[...new Set(ids)].sort().join(",")}`);
        return new Map([["w1", NCR_CAD]]);
      },
    };
    const out = await computeNumbersWeek(sources, WEEK);
    expect(calls).toContain("companyDims:a,b");
    expect(calls).toContain("workerDims:w1,w2,w3");
    expect(out.map((m) => m.metric)).toEqual([
      "paying_companies",
      "paying_companies_cumulative",
      "companies_posted",
      "companies_posted_cumulative",
      "completed_profiles",
      "completed_profiles_cumulative",
      "active_workers_30d",
      "form_completed_unconfirmed",
      "confirmed_hires",
      "confirmed_hires_cumulative",
      "contacts_per_hire",
      "revenue_by_pack",
      "revenue_by_pack:pack_50",
    ]);
    for (const m of out) expect(m.cells).toHaveLength(42);
    expect(total(byId(out, "contacts_per_hire"))).toBe(100);
    expect(at(byId(out, "companies_posted"), "unknown", "unknown").value).toBe(1);
  });
});
