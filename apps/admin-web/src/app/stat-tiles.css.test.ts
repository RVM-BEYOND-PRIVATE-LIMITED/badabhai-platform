import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The stat-row and dense-table rules the PR-D1 review fixes depend on. The node env has no
 * layout engine, so these pin the declared rules; the layout itself was measured in headless
 * Chrome over every stat grid at 320/360/375/768/1024/1280/1440px when they were written.
 *
 *  - Stat tiles sit in wrapping FLEX rows: a tile grows to share its row and never shrinks
 *    below its unbroken figure. That is what keeps a ₹ figure (or a count) from splitting or
 *    overflowing, and a lone last tile from stranding beside empty tracks. No tile is placed
 *    with a grid span anywhere — every such attempt stranded a sibling or split a count.
 *  - `Stat wide` only emits a class; the wide-value rule is its whole effect: the ₹ figure is
 *    one unbroken line at the 22px step at every width. Deleting it leaves the render test green
 *    while ₹ tiles split mid-number again.
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

type Rule = { selector: string; body: string; atRules: string[] };

/**
 * Flat `{ selector, body }` pairs of the style rules in `css`. With `nested`, every at-rule body
 * (`@media`, `@container`, `@supports`, nested to any depth) is walked too, and each rule carries
 * the chain of at-rule preludes it sits in; without it, at-rule blocks are skipped.
 */
function rules(css: string, nested = false, atRules: string[] = []): Rule[] {
  const out: Rule[] = [];
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
      const body = css.slice(i + 1, j - 1);
      if (!selector.startsWith("@")) out.push({ selector, body, atRules });
      else if (nested) out.push(...rules(body, true, [...atRules, selector]));
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

/**
 * Does a selector target a stat TILE — `.stat`, `.stat--wide`, or any child of a stat row
 * (`.stats > *`, `.stats--compact > div`) — rather than the row itself or a `.stat__x` part?
 */
const targetsTile = (selector: string) =>
  /\.stat(--[\w-]+)?(?![\w-])/.test(selector) || /\.stats(--[\w-]+)?\s*>/.test(selector);

/**
 * Does any selector in the list target a stat ROW itself — `.stats`, `.stats--compact`, with any
 * pseudo-class or attribute on that last compound (`.stats:not(.x)`, `.stats[data-x]`)?
 */
const targetsRow = (selector: string) =>
  selector.split(",").some((part) => /\.stats(--[\w-]+)?(?![\w-])[^\s>+~]*$/.test(part.trim()));

/** Does a selector target a stat VALUE (`.stat__value`, with or without modifiers)? */
const targetsValue = (selector: string) => selector.includes(".stat__value");

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

  it("stat tiles sit in wrapping flex rows, growing to fill each row", () => {
    const row = rule(topLevel(), ".stats");
    expect(row).toMatch(/display:\s*flex/);
    expect(row).toMatch(/flex-wrap:\s*wrap/);
    // grow 1: a lone last tile takes its row instead of stranding half-width.
    expect(rule(topLevel(), ".stats > .stat")).toMatch(/flex:\s*1 1 11rem/);
    expect(rule(topLevel(), ".stats--compact > .stat")).toMatch(/flex-basis:\s*7\.5rem/);
    const phone = phoneBlocks()
      .map((b) => rule(b, ".stats > .stat"))
      .filter((b): b is string => b !== null);
    expect(phone).toHaveLength(1);
    expect(phone[0]).toMatch(/flex-basis:\s*9rem/);
  });

  it("nothing lets a tile shrink below its unbroken figure", () => {
    // A flex item's automatic minimum is its min-content — the whole nowrap ₹ figure, or a
    // count with no break opportunity in it. That minimum IS the no-split / no-overflow
    // guarantee. Each of these zeroes, caps or clamps it: an explicit minimum; any non-visible
    // overflow (a scroll container's automatic minimum is 0); a set or maximum width (caps it);
    // size containment or an inline-size container (content no longer sizes the tile).
    // A value rule counts too: a capped or contained value lets its tile shrink the same way.
    const loosening = rules(CSS, true).filter(
      (r) =>
        (targetsTile(r.selector) || targetsValue(r.selector)) &&
        /(^|[\s;])(min-width|min-inline-size|width|inline-size|max-width|max-inline-size|overflow(-x|-y|-inline|-block)?|container(-type)?|contain)\s*:/.test(
          r.body,
        ),
    );
    expect(loosening.map((r) => r.selector)).toEqual([]);
  });

  it("no value or tile may break anywhere — a count or a ₹ figure never splits", () => {
    // `overflow-wrap: anywhere` / `word-break: break-all` lower a value's min-content to one
    // character, so the tile shrinks and "1,23,456" splits. (A long identifier — the stuck
    // panel's question key — gets break points in MARKUP, `<wbr>` after each `_`, instead:
    // `anywhere` there wrapped even `salary_expected` mid-word at 375px, measured.)
    const breaking = rules(CSS, true)
      .filter(
        (r) =>
          // The row too: `word-break` and `line-break` inherit into every value below it.
          (targetsValue(r.selector) || targetsTile(r.selector) || targetsRow(r.selector)) &&
          /(overflow-wrap|word-wrap)\s*:\s*anywhere|word-break\s*:\s*break-(all|word)|line-break\s*:\s*anywhere/.test(
            r.body,
          ),
      )
      .map((r) => [...r.atRules, r.selector].join(" > "));
    expect(breaking).toEqual([]);
  });

  it("a stat row stays a flex row in every at-rule — never a grid again", () => {
    // The grid-placement ban below only has teeth while `.stats` is flex, and the phone
    // flex-basis still "passes" under a grid while doing nothing. So pin the row itself — and
    // pin it WRAPPING and horizontal: a `nowrap` row of tiles that cannot shrink below their
    // figures (five voice-attempt tiles) scrolls a phone page sideways, and a column row stops
    // being a row.
    const regressions = rules(CSS, true)
      .filter(
        (r) =>
          targetsRow(r.selector) &&
          (/(^|[\s;])display\s*:(?!\s*flex\b)/.test(r.body) ||
            /(^|[\s;])grid-template(-[\w-]+)?\s*:/.test(r.body) ||
            /(^|[\s;])flex-(wrap|flow)\s*:[^;]*\bnowrap\b/.test(r.body) ||
            /(^|[\s;])flex-(direction|flow)\s*:[^;]*\bcolumn\b/.test(r.body)),
      )
      .map((r) => [...r.atRules, r.selector].join(" > "));
    expect(regressions).toEqual([]);
  });

  it("no rule, in ANY at-rule, places a stat tile on grid tracks", () => {
    // Every grid placement tried for a ₹ tile — a full-row span, `span 2` behind a container
    // query — stranded a sibling tile or narrowed the counts until "1,23,456" split (measured).
    // Walks every @media / @container / @supports body, the phone tier included.
    const placed = rules(CSS, true)
      .filter(
        (r) =>
          targetsTile(r.selector) &&
          /(^|[\s;])grid-(column|row|area)(-start|-end)?\s*:/.test(r.body),
      )
      .map((r) => [...r.atRules, r.selector].join(" > "));
    expect(placed).toEqual([]);
  });
});

describe("dense tables on a phone", () => {
  it("tighten only the inline cell padding, so rows keep their 44px height", () => {
    const cells = phoneBlocks()
      .map((b) => rule(b, ".table th, .table td"))
      .filter((b): b is string => b !== null);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatch(/padding-inline:\s*var\(--space-3\)/);
    expect(cells[0]).not.toMatch(/(^|[\s;])padding(-block)?(-top|-bottom|-start|-end)?\s*:/);
  });
});
