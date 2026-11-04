import { describe, expect, it } from "vitest";
import { gridColumnMeta } from "./data-grid";
import { POSTING_COLUMNS } from "../app/(portal)/jobs/columns";
import {
  GRID_CELL_PAD_REM,
  GRID_END_REM,
  GRID_WIDTH_REM,
  gridMinWidthRem,
  headerMayCut,
  headerWidthRem,
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

  it("a fixed column whose header is wider than its kind takes the header's width — it is drawn so", () => {
    const narrow = col("n", { header: "Questions settled", width: "number" });
    expect(gridMinWidthRem([narrow], false)).toBeCloseTo(
      Math.round((headerWidthRem("Questions settled") + GRID_CELL_PAD_REM) * 4) / 4,
    );
    expect(gridMinWidthRem([narrow], false)).toBeGreaterThan(GRID_WIDTH_REM.number);
    // A short header leaves the kind's own width; a text column's header never widens it.
    expect(gridMinWidthRem([col("b", { header: "Band", width: "number" })], false)).toBe(GRID_WIDTH_REM.number);
    expect(gridMinWidthRem([col("p", { header: "Published as" })], false)).toBe(GRID_WIDTH_REM.fill);
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

/**
 * THE HEADER ESTIMATE (finding of the A4 review: seven headers drawn "QUESTI…", "MOVEME…"). The
 * header type is 11.5px Inter Bold, uppercase, tracked 0.06em; the widths by kind are in the 13.5px
 * cells' `ch`. These are the drawn advances, in px, measured in Chrome 153 with Inter loaded
 * (2026-11-04): each glyph ten times over, divided by ten, tracking included.
 */
const MEASURED_GLYPH_PX: Record<string, number> = {
  " ": 3.41, "&": 8.42, "'": 4.59, "(": 5.03, ")": 5.03, ",": 4.53, "-": 6.07, ".": 4.53, "/": 5.15,
  "0": 8.45, "1": 5.65, "2": 7.93, "3": 8.11, "4": 8.47, "5": 7.85, "6": 8.16, "7": 7.58, "8": 8.18,
  "9": 8.16, A: 9.43, B: 8.3, C: 9.2, D: 9, E: 7.68, F: 7.44, G: 9.32, H: 9.28, I: 3.92, J: 7.41,
  K: 8.96, L: 7.19, M: 11.4, N: 9.46, O: 9.55, P: 8.14, Q: 9.63, R: 8.24, S: 8.22, T: 8.37, U: 9.11,
  V: 9.43, W: 12.85, X: 9.18, Y: 9.1, Z: 8.33, "·": 4.53, "—": 12.19,
};
/** Whole labels as Chrome drew them — the console's widest, and the seven the review found cut. */
const MEASURED_HEADER_PX: Record<string, number> = {
  "Idle since last word": 148.4, "Questions settled": 134, "Suggested action": 129.5,
  "Provider call": 99.5, Organisation: 97, "Resume prefs": 95.5, "Last updated": 95.3,
  "Trust review": 95, "Published as": 91.6, "Net credits": 83.5, Movements: 82.5,
  Language: 69.9, Messages: 69.4, Amount: 57.2, When: 39, Name: 37.8,
};

describe("headerWidthRem — a header's drawn width, never under it", () => {
  it("counts every measured glyph at no less than its drawn advance", () => {
    for (const [glyph, px] of Object.entries(MEASURED_GLYPH_PX)) {
      expect(headerWidthRem(glyph) * 16, glyph).toBeGreaterThanOrEqual(px);
    }
  });

  it("is never short of a real label, and close enough not to waste a column (≤ 16% over)", () => {
    for (const [header, px] of Object.entries(MEASURED_HEADER_PX)) {
      const estimate = headerWidthRem(header) * 16;
      expect(estimate, header).toBeGreaterThanOrEqual(px);
      expect(estimate / px, header).toBeLessThanOrEqual(1.16);
    }
  });

  it("is case-blind (the header type is uppercase), counts an unknown glyph as wide, and adds a sort arrow", () => {
    expect(headerWidthRem("net credits")).toBe(headerWidthRem("NET CREDITS"));
    expect(headerWidthRem("ä")).toBeGreaterThanOrEqual(headerWidthRem("W"));
    expect(headerWidthRem("When", true)).toBeCloseTo(headerWidthRem("When") + 1.25);
  });
});

describe("headerMayCut — which headers carry their full label in a title", () => {
  it("a text column's long header: it can be squeezed to the column's minimum", () => {
    expect(headerMayCut({ width: "fill", header: "Published as" })).toBe(true);
    expect(headerMayCut({ width: "fill", header: "Name" })).toBe(false);
  });

  it("never a fixed kind's: it is drawn at least as wide as its header", () => {
    expect(headerMayCut({ width: "number", header: "Questions settled" })).toBe(false);
    expect(headerMayCut({ width: "short", header: "Idle since last word" })).toBe(false);
  });
});
