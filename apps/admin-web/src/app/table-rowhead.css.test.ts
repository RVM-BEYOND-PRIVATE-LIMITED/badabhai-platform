import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
