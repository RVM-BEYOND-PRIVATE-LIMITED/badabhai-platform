import { describe, expect, it } from "vitest";
import { UNKNOWN_DIMS, type NumbersDims, type NumbersMetricCells } from "./cells";
import { couldntReach, creditsWaived, welcomeCredits } from "./credit-rules";
import { weekWindow, type NumbersDimsLookup } from "./types";

/**
 * #2755 part E — metric groups 6 to 8 over hand-written source rows (#2750's welcome lots,
 * couldn't-reach cases and waivers): the week edges in India time, the company splits, and the
 * rules of `definitions.ts`.
 */

const W = weekWindow("2026-11-09"); // Monday 9 Nov … Sunday 15 Nov, India time
const MONDAY_START = new Date("2026-11-08T18:30:00.000Z");
const SUNDAY_END = new Date("2026-11-15T18:29:59.999Z");
const NEXT_MONDAY = new Date("2026-11-15T18:30:00.000Z");
const BEFORE = new Date("2026-11-08T18:29:59.999Z");

const PUNE_CNC: NumbersDims = { city: "pune", trade: "cnc_operator" };
const NCR_CAD: NumbersDims = { city: "ncr", trade: "cad_3d_designer" };
const dims: NumbersDimsLookup = (id) =>
  ({ a: PUNE_CNC, b: NCR_CAD, c: PUNE_CNC })[id] ?? UNKNOWN_DIMS;

const byId = (metrics: NumbersMetricCells[], id: string) => metrics.find((m) => m.metric === id)!;
const at = (m: NumbersMetricCells, city: string, trade: string) =>
  m.cells.find((c) => c.cityGroup === city && c.tradeGroup === trade)!;
const total = (m: NumbersMetricCells) => at(m, "all", "all").value;

describe("group 6 — welcome credits used up, and then bought", () => {
  const out = welcomeCredits(
    W,
    [
      // Ran out on Monday 00:00 IST, bought on Sunday night: both count.
      { payerId: "a", ranOutAt: MONDAY_START, firstPaidAfter: SUNDAY_END },
      // Ran out in the week, bought only the next Monday: used up, not "then bought" this week.
      { payerId: "b", ranOutAt: SUNDAY_END, firstPaidAfter: NEXT_MONDAY },
      // Ran out the week before: neither.
      { payerId: "c", ranOutAt: BEFORE, firstPaidAfter: MONDAY_START },
    ],
    dims,
  );

  it("counts the companies whose welcome lot ran out in the week", () => {
    expect(total(byId(out, "welcome_credits_used_up"))).toBe(2);
    expect(at(byId(out, "welcome_credits_used_up"), "pune", "all").value).toBe(1);
    expect(at(byId(out, "welcome_credits_used_up"), "ncr", "all").value).toBe(1);
  });

  it("and of those, the ones with a paid order after the run-out and by the week's end", () => {
    expect(total(byId(out, "welcome_then_bought"))).toBe(1);
    expect(at(byId(out, "welcome_then_bought"), "pune", "cnc_operator").value).toBe(1);
  });

  it("every metric fills all 42 cells", () => {
    for (const m of out) expect(m.cells).toHaveLength(42);
  });
});

describe("group 7 — couldn't-reach claims and the credits returned", () => {
  const out = couldntReach(
    W,
    [
      // Reported and closed not reached in the week: a claim and 2 credits back.
      { payerId: "a", reportedAt: MONDAY_START, resolvedAt: SUNDAY_END, creditsReturned: 2 },
      // Reported the week before, closed in this one: no claim this week, its credit counts.
      { payerId: "b", reportedAt: BEFORE, resolvedAt: MONDAY_START, creditsReturned: 1 },
      // Reported in the week, still open.
      { payerId: "c", reportedAt: SUNDAY_END, resolvedAt: null, creditsReturned: 0 },
      // Reported in the week, closed reached the next week: a claim, no credit this week.
      { payerId: "a", reportedAt: MONDAY_START, resolvedAt: NEXT_MONDAY, creditsReturned: 0 },
    ],
    dims,
  );

  it("counts the cases reported in the week", () => {
    expect(total(byId(out, "couldnt_reach_claims"))).toBe(3);
    expect(at(byId(out, "couldnt_reach_claims"), "pune", "cnc_operator").value).toBe(3);
  });

  it("sums the credits returned by cases closed in the week", () => {
    expect(total(byId(out, "couldnt_reach_credits_returned"))).toBe(3);
    expect(at(byId(out, "couldnt_reach_credits_returned"), "ncr", "all").value).toBe(1);
  });
});

describe("group 8 — credits waived", () => {
  it("one credit per waived open in the week; none outside it", () => {
    const out = creditsWaived(
      W,
      [
        { payerId: "a", at: MONDAY_START },
        { payerId: "a", at: SUNDAY_END },
        { payerId: "b", at: BEFORE },
        { payerId: "b", at: NEXT_MONDAY },
      ],
      dims,
    );
    expect(total(byId(out, "credits_waived"))).toBe(2);
    expect(at(byId(out, "credits_waived"), "ncr", "all").value).toBe(0);
  });
});
