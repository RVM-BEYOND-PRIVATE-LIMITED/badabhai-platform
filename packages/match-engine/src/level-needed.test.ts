import { LEVEL_FIT_ORDER, levelFitFor, levelNeededSpec } from "@badabhai/taxonomy";
import { describe, expect, it } from "vitest";
import { DEFAULT_MATCH_CONFIG } from "./config";
import { rankKeyCompare } from "./rank";
import type { RankInputs } from "./types";

/**
 * ENGINE v1.1 — "LEVEL NEEDED" (CEO ruling 30 Oct 2026, ADR-0061). Release gate for the one key
 * v1.1 adds: `levelOrder`, between the tier group and months.
 *
 *   1. the ruling's §3 worked example produces exactly its order (DoD §8.3);
 *   2. nobody leaves the list — the sort is a permutation (DoD §8.4);
 *   3. an "Any level" list is v1.0's, element for element (DoD §8.5);
 *   4. the 36-month floor stays exactly as it is (owner ruling 2026-11-04).
 */

const cfg = DEFAULT_MATCH_CONFIG;
const SETTER_NEEDED = levelNeededSpec("cnc_turner", "setter")!;

interface Worker {
  id: string;
  matchTier: 1 | 2;
  months: number;
  /** The rung frozen on his application, and its confirm bit. */
  rung: string | null;
  confirmed: boolean | null;
}

/** One worker's rank inputs. `levelled` false = an "Any level" posting (no levelOrder). */
function inputs(w: Worker, levelled: boolean): RankInputs {
  return {
    id: w.id,
    matchTier: w.matchTier,
    skillMonths: w.months,
    industryMonths: w.months,
    lastWorkedAt: null,
    lastActiveAt: "2026-11-01T00:00:00.000Z",
    ...(levelled
      ? { levelOrder: LEVEL_FIT_ORDER[levelFitFor(SETTER_NEEDED, w.rung, w.confirmed)] }
      : {}),
  };
}

function order(workers: readonly Worker[], levelled: boolean): string[] {
  return workers
    .map((w) => inputs(w, levelled))
    .sort((a, b) => rankKeyCompare(a, b, cfg))
    .map((r) => r.id);
}

// §3 worked example — CNC Turner job, "Setter needed". C is the related-trade VMC Setter.
const A: Worker = { id: "A", matchTier: 1, months: 48, rung: "setter", confirmed: true };
const D: Worker = { id: "D", matchTier: 1, months: 72, rung: null, confirmed: null };
const B: Worker = { id: "B", matchTier: 1, months: 120, rung: "operator", confirmed: false };

describe("engine v1.1 — the 30 Oct §3 worked example", () => {
  it("A (Setter) → D (not confirmed) → B (Operator) → C (related trade)", () => {
    // C at 24 months is under the 36-month floor, so he stays in the related group. The ruling's
    // table prints 72 months for him; at 72 the floor promotes him (next case) — the owner kept
    // the floor exactly as it is (2026-11-04), so the example is pinned at a sub-floor month count.
    const C: Worker = { id: "C", matchTier: 2, months: 24, rung: "setter", confirmed: true };
    expect(order([B, C, D, A], true)).toEqual(["A", "D", "B", "C"]);
  });

  it("the floor stays as it is: C at 72 months is promoted and, as a Setter, comes first", () => {
    const C: Worker = { id: "C", matchTier: 2, months: 72, rung: "setter", confirmed: true };
    expect(order([B, C, D, A], true)).toEqual(["C", "A", "D", "B"]);
  });

  it("level groups sit INSIDE the tier group: a related Setter never jumps an exact Operator", () => {
    const C: Worker = { id: "C", matchTier: 2, months: 24, rung: "setter", confirmed: true };
    const ids = order([C, B], true);
    expect(ids.indexOf("B")).toBeLessThan(ids.indexOf("C"));
  });

  it("months still order each level group (skill → industry → recency)", () => {
    const A2: Worker = { id: "A2", matchTier: 1, months: 96, rung: "programmer", confirmed: true };
    const D2: Worker = { id: "D2", matchTier: 1, months: 6, rung: null, confirmed: null };
    expect(order([A, D, A2, D2, B], true)).toEqual(["A2", "A", "D", "D2", "B"]);
  });

  it("a 'koi aur' Setter sits with the not-confirmed group, above every below-level worker", () => {
    const S: Worker = { id: "S", matchTier: 1, months: 200, rung: "setter", confirmed: false };
    expect(order([B, S, A], true)).toEqual(["A", "S", "B"]);
  });
});

describe("engine v1.1 — what does NOT change", () => {
  const C: Worker = { id: "C", matchTier: 2, months: 24, rung: "setter", confirmed: true };
  const fleet: Worker[] = [A, B, C, D];

  it("nobody leaves the list: a levelled order is a permutation of the input (DoD §8.4)", () => {
    const levelled = order(fleet, true);
    expect([...levelled].sort()).toEqual(fleet.map((w) => w.id).sort());
  });

  it("'Any level' is v1.0 exactly — the months order, untouched by any rung (DoD §8.5)", () => {
    // Without levelOrder the comparator is the v1.0 tuple: B (120) > D (72) > A (48), C last.
    expect(order(fleet, false)).toEqual(["B", "D", "A", "C"]);
    // ...and changing every rung changes nothing.
    const rerung = fleet.map((w) => ({ ...w, rung: "supervisor", confirmed: true }));
    expect(order(rerung, false)).toEqual(order(fleet, false));
  });

  it("is a total order: every input permutation sorts the same way", () => {
    const expected = order(fleet, true);
    const perms = [
      [A, B, C, D],
      [D, C, B, A],
      [B, D, A, C],
      [C, A, D, B],
    ];
    for (const p of perms) expect(order(p, true)).toEqual(expected);
  });
});
