import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decl, rule, rules } from "../../test/css-rules";

/**
 * Row headers vs column headers. `.table th` styles the sticky COLUMN header; a ROW header
 * (`tbody th scope="row"`) used to inherit its `position: sticky; top: 0`, so on a table that
 * scrolls in place every row header pinned over the real column header and covered it. The
 * node env has no layout engine, so this pins the declared rule.
 */
const here = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(here, "globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function block(selector: string): string {
  const at = CSS.indexOf(`${selector} {`);
  expect(at, `${selector} must be declared`).toBeGreaterThanOrEqual(0);
  return CSS.slice(CSS.indexOf("{", at) + 1, CSS.indexOf("}", at));
}

describe("admin table row headers", () => {
  it("the column header stays sticky", () => {
    const th = block(".table th");
    expect(th).toMatch(/position:\s*sticky/);
    expect(th).toMatch(/top:\s*0/);
  });

  it("a row header is NOT sticky and does not take the column-header chrome", () => {
    const rowTh = block(".table tbody th");
    expect(rowTh).toMatch(/position:\s*static/);
    expect(rowTh).toMatch(/box-shadow:\s*none/);
    expect(rowTh).toMatch(/text-transform:\s*none/);
    expect(rowTh).toMatch(/background:\s*transparent/);
  });

  it("the row-header rule is `.table tbody th` — it outranks `.table th` on specificity", () => {
    // (0,1,2) against (0,1,1), so it wins wherever it sits in the file and source order is
    // irrelevant. What must not change is the SELECTOR: rewritten as `.table__rowhead` (0,1,0)
    // or `tbody th` (0,0,2) it would lose to the column-header rule, and every row header would
    // go sticky again. Anchored to the start of a rule so a scoped copy (`.x .table tbody th`)
    // cannot satisfy it.
    expect(CSS).toMatch(/(^|\n)\.table tbody th \{/);
  });
});

/**
 * (ids, classes/attributes/pseudo-classes, types) of a simple selector — enough for the table
 * selectors below (no :is/:where/:not arguments to weigh).
 */
function specificity(selector: string): [number, number, number] {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length;
  const classes = (selector.match(/\.[\w-]+|\[[^\]]*\]|:[\w-]+/g) ?? []).length;
  const bare = selector.replace(/\.[\w-]+|\[[^\]]*\]|:[\w-]+|#[\w-]+/g, "");
  const types = (bare.match(/[a-z][\w-]*/gi) ?? []).length;
  return [ids, classes, types];
}
const outranks = (a: string, b: string) => {
  const [x, y] = [specificity(a), specificity(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
};

describe("the roles matrix keeps its capability column in view", () => {
  // Scrolled sideways at 320/375/768 the capability labels left the screen (0 of 14 visible,
  // measured) — every mark in the grid lost what it meant. THIS table only pins its row header.
  const ROWHEAD = ".table--matrix .table__rowhead";
  const CORNER = ".table--matrix thead th:first-child";
  const own = (selector: string) => {
    const body = rule(CSS, selector);
    expect(body, `${selector} must be declared at top level`).not.toBeNull();
    return body!;
  };

  it("pins the row header to the scroller's inline start, on an opaque fill", () => {
    const head = own(ROWHEAD);
    expect(decl(head, "position")).toBe("sticky");
    expect(decl(head, "inset-inline-start")).toBe("0");
    // Opaque: the role cells slide UNDER it. The card fill is what the table sits on.
    expect(decl(head, "background")).toBe("var(--surface-card)");
    // Its inline-end edge, drawn by the cell (a sticky cell leaves the collapsed border grid).
    expect(decl(head, "box-shadow")).toContain("var(--divider)");
  });

  it("outranks the static row-header rule wherever it sits in the file", () => {
    expect(outranks(ROWHEAD, ".table tbody th")).toBe(true);
    expect(outranks(CORNER, ".table th")).toBe(true);
  });

  it("wraps with a floor, never a fixed width — pinned, the unwrapped column covered the scroller", () => {
    const head = own(ROWHEAD);
    // Unwrapped it was 439px inside a 307px scroller at 375: pinned, no role column would show.
    expect(decl(head, "white-space")).toBe("normal");
    expect(decl(head, "min-inline-size")).toBe("9rem");
    // A fixed width would also wrap it at 1280, where the whole matrix fits on one line.
    for (const prop of ["width", "inline-size", "max-width", "max-inline-size"]) {
      expect(decl(head, prop), prop).toBeNull();
    }
  });

  it("stacks under the column header and under the corner, which is pinned on both axes", () => {
    // z-auto: painted over the static cells, under the column header's z-index 1, so a vertical
    // scroll still passes rows beneath the header.
    expect(decl(own(ROWHEAD), "z-index")).toBeNull();
    const headerZ = Number(decl(own(".table th"), "z-index"));
    const corner = own(CORNER);
    expect(decl(corner, "inset-inline-start")).toBe("0");
    expect(Number(decl(corner, "z-index"))).toBeGreaterThan(headerZ);
  });

  it("repeats the row-hover fill on the pinned cell (it paints its own background)", () => {
    expect(decl(own(".table--matrix tbody tr:hover .table__rowhead"), "background")).toBe(
      decl(own(".table tbody tr:hover"), "background"),
    );
  });

  it("is scoped: no other rule, in any at-rule, makes a row header sticky", () => {
    const rowHeadSelector = (s: string) =>
      s.includes("tbody th") || s.includes(".table__rowhead") || s.includes('scope="row"');
    const sticky = rules(CSS, true)
      .filter((r) => rowHeadSelector(r.selector) && decl(r.body, "position") === "sticky")
      .map((r) => [...r.atRules, r.selector].join(" > "));
    expect(sticky).toEqual([ROWHEAD]);
  });
});
