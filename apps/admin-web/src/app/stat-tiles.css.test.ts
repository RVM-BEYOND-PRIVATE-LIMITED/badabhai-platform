import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The phone-tier rules the stat tiles and dense tables depend on (PR-D1 review fixes). The node
 * env has no layout engine, so these pin the declared rules; the layout itself was measured in
 * headless Chrome at 375/360/320px when they were written.
 *
 *  - `Stat wide` only emits a class; these rules are the whole effect, and deleting one leaves
 *    the render test green while ₹ tiles split mid-number again. At every width a wide value
 *    is one unbroken line at the 22px step; on a phone the tile also takes the whole row.
 *  - A warn tile's label on the amber fill needs the secondary text step to clear 4.5:1.
 *  - Phone table cells tighten INLINE padding only, so rows keep their 44px touch height.
 */
const here = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(here, "globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The body of every `@media (max-width: 600px)` block, braces balanced. */
function phoneBlocks(): string[] {
  const out: string[] = [];
  const head = "@media (max-width: 600px) {";
  for (let at = CSS.indexOf(head); at >= 0; at = CSS.indexOf(head, at + 1)) {
    let depth = 0;
    const start = at + head.length - 1;
    for (let i = start; i < CSS.length; i++) {
      if (CSS[i] === "{") depth++;
      else if (CSS[i] === "}" && --depth === 0) {
        out.push(CSS.slice(start + 1, i));
        break;
      }
    }
  }
  return out;
}

/** The stylesheet with every `@media` block removed — the rules that apply at every width. */
function topLevel(): string {
  let out = "";
  let i = 0;
  while (i < CSS.length) {
    const at = CSS.indexOf("@media", i);
    if (at < 0) return out + CSS.slice(i);
    out += CSS.slice(i, at);
    let depth = 0;
    let j = CSS.indexOf("{", at);
    for (; j < CSS.length; j++) {
      if (CSS[j] === "{") depth++;
      else if (CSS[j] === "}" && --depth === 0) break;
    }
    i = j + 1;
  }
  return out;
}

/** Flat `{ selector, body }` pairs of the plain rules in `css`; at-rule blocks are skipped. */
function rules(css: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  let prelude = "";
  let i = 0;
  while (i < css.length) {
    const ch = css[i]!;
    if (ch === "{") {
      let depth = 1;
      let j = i + 1;
      for (; j < css.length && depth > 0; j++) {
        if (css[j] === "{") depth++;
        else if (css[j] === "}") depth--;
      }
      const selector = prelude.trim().replace(/\s+/g, " ");
      if (!selector.startsWith("@")) out.push({ selector, body: css.slice(i + 1, j - 1) });
      prelude = "";
      i = j;
      continue;
    }
    if (ch === "}" || ch === ";") prelude = "";
    else prelude += ch;
    i++;
  }
  return out;
}

/**
 * The declarations of the first rule in `css` whose selector list is EXACTLY `selector`
 * (whitespace-normalised). A string match, not a RegExp built from the selector.
 */
function rule(css: string, selector: string): string | null {
  return rules(css).find((r) => r.selector === selector)?.body ?? null;
}

describe("stat tiles", () => {
  it("a warn tile's label takes the secondary text step, not muted", () => {
    const body = rule(CSS, ".stat--warn .stat__label");
    expect(body).not.toBeNull();
    expect(body).toMatch(/color:\s*var\(--text-secondary\)/);
  });

  it("a wide (₹) value stays on one line at the 22px step at EVERY width", () => {
    // A money figure never breaks between digits, at any width — so this rule lives OUTSIDE
    // every media query. Absent values (a sentence) are excluded and keep wrapping.
    const body = rule(topLevel(), ".stat--wide .stat__value:not(.stat__value--absent)");
    expect(body).not.toBeNull();
    expect(body).toMatch(/white-space:\s*nowrap/);
    expect(body).toMatch(/font-size:\s*var\(--ui-kpi-sm-size\)/);
    // The `simulated` tag is its own flex item and may drop under the figure; with the whole
    // span nowrap it was pushed out of the tile and scrolled the page sideways at 768/1024px.
    expect(body).toMatch(/display:\s*flex/);
    expect(body).toMatch(/flex-wrap:\s*wrap/);
  });

  it("the phone tier spans a wide tile across the whole row", () => {
    const wide = phoneBlocks()
      .map((b) => rule(b, ".stat--wide"))
      .filter((b): b is string => b !== null);
    expect(wide).toHaveLength(1);
    expect(wide[0]).toMatch(/grid-column:\s*1\s*\/\s*-1/);
  });

  it("above phone width only a COMPACT grid spans a wide tile", () => {
    // In a page-level grid a wide tile keeps its track: spanning it there makes it occupy every
    // explicit track, so `auto-fit` stops collapsing the empty ones and the sibling count tiles
    // shrink until their own figures split ("1,23,456" at 1280px, measured). A compact grid's
    // 7.5rem track is too narrow for a rupee figure, so there it spans at every width.
    const outside = phoneBlocks().reduce((css, b) => css.replace(b, ""), CSS);
    const spanning = rules(outside)
      .filter((r) => r.selector.includes(".stat--wide") && r.body.includes("grid-column"))
      .map((r) => r.selector);
    expect(spanning).toEqual([".stats--compact .stat--wide"]);
    expect(rule(outside, ".stats--compact .stat--wide")).toMatch(/grid-column:\s*1\s*\/\s*-1/);
  });
});

describe("dense tables on a phone", () => {
  it("tighten only the inline cell padding, so rows keep their 44px height", () => {
    const cells = phoneBlocks()
      .map((b) => rule(b, ".table th, .table td"))
      .filter((b): b is string => b !== null);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatch(/padding-inline:\s*var\(--space-3\)/);
    expect(cells[0]).not.toMatch(/(^|[\s;])padding(-block)?(-top|-bottom)?\s*:/);
  });
});
