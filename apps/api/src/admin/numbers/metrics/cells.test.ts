import { describe, expect, it } from "vitest";
import {
  NUMBERS_SMALL_CELL_FLOOR,
  cellGrid,
  cellKey,
  distinctCountCells,
  hundredths,
  ratioCells,
  sumByCell,
  suppressSmallCells,
  valueCells,
  type NumbersDims,
  type NumbersMetricCells,
} from "./cells";

/** #2755 part B — the cell grid: one leaf per entity, roll-ups from the leaves, small cells hidden. */

const PUNE_CNC: NumbersDims = { city: "pune", trade: "cnc_operator" };
const PUNE_CAD: NumbersDims = { city: "pune", trade: "cad_3d_designer" };
const NCR_CNC: NumbersDims = { city: "ncr", trade: "cnc_operator" };
const UNKNOWN: NumbersDims = { city: "unknown", trade: "unknown" };

const cell = (m: NumbersMetricCells, city: string, trade: string) =>
  m.cells.find((c) => c.cityGroup === city && c.tradeGroup === trade)!;

describe("the grid", () => {
  it("is every city label × every trade label, the roll-ups included: 6 × 7 = 42 cells", () => {
    const grid = cellGrid();
    expect(grid).toHaveLength(42);
    expect(new Set(grid.map((g) => cellKey(g.cityGroup, g.tradeGroup))).size).toBe(42);
    expect(grid[0]).toEqual({ cityGroup: "all", tradeGroup: "all" });
  });
});

describe("sumByCell", () => {
  const items = [
    { d: PUNE_CNC, n: 3 },
    { d: PUNE_CNC, n: 4 },
    { d: PUNE_CAD, n: 10 },
    { d: NCR_CNC, n: 100 },
    { d: UNKNOWN, n: 1000 },
  ];
  const totals = sumByCell(
    items,
    (i) => i.d,
    (i) => i.n,
  );

  it("each entity lands in its own leaf, and every roll-up is summed from the leaves", () => {
    expect(totals.get("pune|cnc_operator")).toBe(7);
    expect(totals.get("pune|cad_3d_designer")).toBe(10);
    expect(totals.get("pune|all")).toBe(17);
    expect(totals.get("all|cnc_operator")).toBe(107);
    expect(totals.get("unknown|unknown")).toBe(1000);
    expect(totals.get("all|unknown")).toBe(1000);
    expect(totals.get("all|all")).toBe(1117);
  });

  it("every cell is present, a zero where nothing sits", () => {
    expect(totals.size).toBe(42);
    expect(totals.get("ahmedabad|sheet_metal")).toBe(0);
    expect(totals.get("ahmedabad|all")).toBe(0);
  });

  it("counts one per entity by default", () => {
    expect(sumByCell(items, (i) => i.d).get("all|all")).toBe(5);
  });
});

describe("distinctCountCells", () => {
  it("counts a key once however many rows carry it", () => {
    const rows = [
      { id: "a", d: PUNE_CNC },
      { id: "a", d: PUNE_CNC },
      { id: "b", d: PUNE_CNC },
    ];
    const m = distinctCountCells(
      "x",
      rows,
      (r) => r.id,
      (r) => r.d,
    );
    expect(cell(m, "pune", "cnc_operator").value).toBe(2);
    expect(cell(m, "all", "all").value).toBe(2);
    expect(m.cells).toHaveLength(42);
  });
});

describe("ratioCells and hundredths", () => {
  it("rounds half up in hundredths, with integers only", () => {
    expect(hundredths(5, 2)).toBe(250);
    expect(hundredths(1, 3)).toBe(33);
    expect(hundredths(2, 3)).toBe(67);
    expect(hundredths(1, 8)).toBe(13); // 12.5 → 13
    expect(hundredths(0, 4)).toBe(0);
    expect(() => hundredths(1, 0)).toThrow(RangeError);
  });

  it("stores both terms, and a null value (never zero) where the denominator is zero", () => {
    const num = sumByCell(
      [{ d: PUNE_CNC }, { d: PUNE_CNC }, { d: PUNE_CNC }, { d: NCR_CNC }],
      (x) => x.d,
    );
    const den = sumByCell([{ d: PUNE_CNC }, { d: PUNE_CNC }], (x) => x.d);
    const m = ratioCells("contacts_per_hire", num, den);
    expect(cell(m, "pune", "cnc_operator")).toMatchObject({
      value: 150,
      numerator: 3,
      denominator: 2,
      suppressed: false,
    });
    // NCR opened a contact but hired nobody: not computable.
    expect(cell(m, "ncr", "cnc_operator")).toMatchObject({
      value: null,
      numerator: 1,
      denominator: 0,
    });
    expect(cell(m, "all", "all")).toMatchObject({ value: 200, numerator: 4, denominator: 2 });
  });
});

describe("suppressSmallCells", () => {
  const counts = sumByCell(
    [...Array(7).fill(PUNE_CNC), ...Array(2).fill(NCR_CNC)] as NumbersDims[],
    (d) => d,
  );
  const m = suppressSmallCells(valueCells("completed_profiles", counts));

  it("the floor is the onboarding funnel's 5", () => {
    expect(NUMBERS_SMALL_CELL_FLOOR).toBe(5);
  });

  it("a cell under the floor keeps no number at all, zero included", () => {
    expect(cell(m, "ncr", "cnc_operator")).toMatchObject({
      value: null,
      numerator: null,
      denominator: null,
      suppressed: true,
    });
    expect(cell(m, "ahmedabad", "all")).toMatchObject({ value: null, suppressed: true });
    expect(cell(m, "pune", "cnc_operator")).toMatchObject({ value: 7, suppressed: false });
    expect(cell(m, "all", "cnc_operator")).toMatchObject({ value: 9, suppressed: false });
  });

  it("the all × all total is never suppressed, however small", () => {
    const tiny = suppressSmallCells(
      valueCells(
        "x",
        sumByCell([NCR_CNC], (d) => d),
      ),
    );
    expect(cell(tiny, "all", "all")).toMatchObject({ value: 1, suppressed: false });
    expect(cell(tiny, "ncr", "all")).toMatchObject({ value: null, suppressed: true });
  });

  it("a suppressed cell's two terms go too", () => {
    const r = suppressSmallCells({
      metric: "x",
      cells: [
        {
          cityGroup: "pune",
          tradeGroup: "all",
          value: 2,
          numerator: 2,
          denominator: 9,
          suppressed: false,
        },
      ],
    });
    expect(r.cells[0]).toEqual({
      cityGroup: "pune",
      tradeGroup: "all",
      value: null,
      numerator: null,
      denominator: null,
      suppressed: true,
    });
  });
});
