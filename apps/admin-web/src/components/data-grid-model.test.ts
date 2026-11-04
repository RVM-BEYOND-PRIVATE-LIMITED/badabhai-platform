import { describe, expect, it } from "vitest";
import { gridColumnMeta } from "./data-grid";
import { POSTING_COLUMNS } from "../app/(portal)/jobs/columns";
import {
  GRID_END_REM,
  GRID_WIDTH_REM,
  gridMinWidthRem,
  parseColumnChoices,
  visibleColumns,
  type GridColumnMeta,
} from "./data-grid-model";

/**
 * The data grid's pure rules (A4, #2574): which columns a viewer sees, how a stored choice is
 * read, and how narrow a table may get before it scrolls sideways instead.
 */
const col = (id: string, over: Partial<GridColumnMeta> = {}): GridColumnMeta => ({
  id,
  header: id,
  width: "fill",
  locked: false,
  defaultHidden: false,
  ...over,
});

const ids = (columns: readonly { id: string }[]) => columns.map((c) => c.id);

describe("visibleColumns", () => {
  const columns = [col("name", { locked: true }), col("status"), col("city", { defaultHidden: true })];

  it("with no choice made: every column but the ones hidden by default", () => {
    expect(ids(visibleColumns(columns, {}))).toEqual(["name", "status"]);
  });

  it("a choice overrides the default, both ways, and keeps the column order", () => {
    expect(ids(visibleColumns(columns, { status: false, city: true }))).toEqual(["name", "city"]);
  });

  it("a locked column is shown whatever was stored for it", () => {
    expect(ids(visibleColumns(columns, { name: false }))).toEqual(["name", "status"]);
  });

  it("a choice for a column that no longer exists changes nothing", () => {
    expect(ids(visibleColumns(columns, { gone: true, removed: false }))).toEqual(["name", "status"]);
  });

  it("is never empty — the first column stays if every column was hidden", () => {
    const loose = [col("a"), col("b")];
    expect(ids(visibleColumns(loose, { a: false, b: false }))).toEqual(["a"]);
    expect(visibleColumns([], {})).toEqual([]);
  });

  it("keeps whatever else the caller carries on each column (the view's cell index)", () => {
    const indexed = columns.map((c, index) => ({ ...c, index }));
    expect(visibleColumns(indexed, { status: false }).map((c) => c.index)).toEqual([0]);
  });
});

describe("parseColumnChoices — localStorage is the viewer's to edit, so it is read defensively", () => {
  it("reads a stored object of booleans", () => {
    expect(parseColumnChoices('{"status":false,"city":true}')).toEqual({
      status: false,
      city: true,
    });
  });

  it("nothing stored, or anything that is not that object, is the defaults — never a crash", () => {
    for (const raw of [null, undefined, "", "not json", "[1,2]", "true", "null", '"x"']) {
      expect(parseColumnChoices(raw), String(raw)).toEqual({});
    }
  });

  it("drops a value that is not a boolean and keeps the rest", () => {
    expect(parseColumnChoices('{"a":"yes","b":false,"c":1}')).toEqual({ b: false });
  });
});

describe("gridMinWidthRem — the narrowest a table may be before it scrolls sideways", () => {
  it("sums each column's width kind, the chevron column when rows link", () => {
    const columns = [col("t"), col("s", { width: "status" }), col("d", { width: "date" })];
    expect(gridMinWidthRem(columns, false)).toBe(
      GRID_WIDTH_REM.fill + GRID_WIDTH_REM.status + GRID_WIDTH_REM.date,
    );
    expect(gridMinWidthRem(columns, true)).toBe(gridMinWidthRem(columns, false) + GRID_END_REM);
  });

  it("gives a wrapping text column (a worker's message) a reading width", () => {
    expect(gridMinWidthRem([col("m", { text: "wrap" })], false)).toBeGreaterThan(
      gridMinWidthRem([col("m", { text: "truncate" })], false),
    );
  });

  /**
   * THE 1440 ACCEPTANCE (#2574): Postings scrolls sideways nowhere at 1440px. The full sidebar is
   * 16.5rem there (the rail collapses only below 1440), the content gutter 2rem a side, the panel
   * pad 1.5rem a side, a classic scrollbar ~1rem — and in the fill layout the grid's own vertical
   * scrollbar ~1rem more. Postings' nine columns must fit what is left.
   */
  it("the REAL Postings columns fit beside the full sidebar at 1440px, scrollbars included", () => {
    const rootPx = 16;
    const available = 1440 / rootPx - 16.5 - 2 * 2 - 2 * 1.5 - 1 - 1;
    const postings = gridColumnMeta(POSTING_COLUMNS, "title");
    expect(postings.map((c) => c.id)).toEqual([
      "title",
      "org",
      "location",
      "pay",
      "status",
      "trust",
      "customer",
      "created",
    ]);
    expect(gridMinWidthRem(postings, true)).toBeLessThanOrEqual(available);
  });
});
