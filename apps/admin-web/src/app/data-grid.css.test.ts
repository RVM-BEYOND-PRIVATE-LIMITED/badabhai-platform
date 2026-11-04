import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decl, rules, stripComments, type Rule } from "../../test/css-rules";

/**
 * The data grid's stylesheet (A4, #2574) — the A4 block appended to globals.css. The node env has
 * no layout engine, so this pins the DECLARED rules the grid's behaviour rests on: one vertical
 * scroller per list page, a sticky header, widths by kind, two densities, the pending state, and
 * motion that only ever animates opacity and transform on the shared tokens.
 */
const RAW = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "globals.css"), "utf8");
const MARKER = "══ A4 (#2574) — DATA GRID";

/** The A4 block: from its marker to the next lane's "══" marker, or the end of the file. */
const BLOCK = (() => {
  const at = RAW.indexOf(MARKER);
  const next = RAW.indexOf("/* ══", at + MARKER.length);
  return stripComments(RAW.slice(RAW.lastIndexOf("/*", at), next < 0 ? undefined : next));
})();
const ALL = rules(BLOCK, true);
const FILL = "@media (min-width: 1024px) and (min-height: 860px)";
const TOUCH = "@media (max-width: 600px), (pointer: coarse)";
const REDUCED = "@media (prefers-reduced-motion: reduce)";

const top = (selector: string): Rule => {
  const r = ALL.find((x) => x.selector === selector && x.atRules.length === 0);
  expect(r, selector).toBeDefined();
  return r!;
};
const inMedia = (media: string, test: (selector: string) => boolean): Rule[] =>
  ALL.filter((r) => r.atRules.join() === media && test(r.selector));

describe("the A4 block is ONE clearly marked block, and every grid rule is in it", () => {
  it("is marked, and comes after every older rule of the file", () => {
    expect(RAW.indexOf(MARKER)).toBeGreaterThan(0);
    expect(RAW.indexOf(MARKER)).toBeGreaterThan(RAW.indexOf("A2 (#2572)"));
  });

  it("no grid, chooser or numbered-pager selector appears before it", () => {
    const before = rules(stripComments(RAW.slice(0, RAW.indexOf(MARKER))), true);
    const stray = before.filter((r) => /\.(grid|grid-menu|pager__|pager--numbered)\b/.test(r.selector));
    expect(stray.map((r) => r.selector)).toEqual([]);
  });
});

describe("ONE vertical scroller per list page", () => {
  it("FLOW (the default): the grid never scrolls vertically and never caps its height — the page is the scroller", () => {
    const scroll = top(".grid__scroll");
    expect(decl(scroll.body, "overflow-y")).toBe("hidden");
    expect(decl(scroll.body, "overflow-x")).toBe("auto");
    const caps = ALL.filter(
      (r) =>
        r.selector.includes(".grid__scroll") &&
        ["max-block-size", "max-height", "height", "block-size"].some((p) => decl(r.body, p) !== null),
    );
    expect(caps.map((r) => r.selector)).toEqual([]);
  });

  it("FILL (a list page on a tall desktop): the shell is the window's height, and the grid's body is the one scroller", () => {
    const shell = inMedia(FILL, (s) => s.endsWith(":not(:has(.about[open]))"));
    expect(shell).toHaveLength(1);
    expect(shell[0]!.selector).toBe(".shell__main:has(> .content > .page--list):not(:has(.about[open]))");
    expect(decl(shell[0]!.body, "block-size")).toBe("100dvh");
    const scroll = inMedia(FILL, (s) => s.endsWith(".grid__scroll"));
    expect(scroll).toHaveLength(1);
    expect(decl(scroll[0]!.body, "overflow")).toBe("auto");
    expect(decl(scroll[0]!.body, "flex")).toBe("1 1 0");
    expect(decl(scroll[0]!.body, "min-block-size")).toBe("0");
  });

  it("FILL hands the page back to FLOW while its About section is open — small print never adds a second scroller", () => {
    for (const r of inMedia(FILL, () => true)) {
      expect(r.selector, r.selector).toContain(":not(:has(.about[open]))");
    }
  });
});

describe("the sticky header", () => {
  it("sticks at --grid-head-top: under the topbar while the page scrolls a grid that fits, at the grid's own top otherwise", () => {
    expect(decl(top(".grid__table thead th").body, "top")).toBe("var(--grid-head-top)");
    expect(decl(top(".grid").body, "--grid-head-top")).toBe("0px");
    expect(decl(top('.grid[data-fit="true"]').body, "--grid-head-top")).toBe("var(--shell-header-h)");
    const fill = inMedia(FILL, (s) => s.endsWith(".panel > .grid"));
    expect(decl(fill[0]!.body, "--grid-head-top")).toBe("0px");
  });

  it("a grid that fits clips instead of scrolling — no scroll container stands between its header and the window", () => {
    const fit = top('.grid[data-fit="true"] .grid__scroll');
    expect(decl(fit.body, "overflow")).toBe("clip");
  });

  it("…on BOTH axes: WebKit draws a row's stretch down to the table's foot, and it must not leave the box", () => {
    // Measured in WebKitGTK 2.52: with the block axis open (`overflow-y: visible`), a click below
    // the grid — on whatever follows it — landed on the LAST row's link.
    const fit = top('.grid[data-fit="true"] .grid__scroll');
    expect(decl(fit.body, "overflow-x")).toBeNull();
    expect(decl(fit.body, "overflow-y")).toBeNull();
    expect(decl(top(".grid__scroll").body, "overflow-y")).toBe("hidden");
  });
});

describe("widths by kind — ID 10ch, status 10ch, date 12ch", () => {
  it("a fixed-layout table, never narrower than its columns' minimum", () => {
    const table = top(".grid__table");
    expect(decl(table.body, "table-layout")).toBe("fixed");
    expect(decl(table.body, "min-inline-size")).toBe("var(--grid-min, 0)");
  });

  it("each kind's width starts from the brief's characters", () => {
    expect(decl(top(".grid__col--id").body, "width")).toMatch(/^calc\(10ch \+/);
    expect(decl(top(".grid__col--status").body, "width")).toMatch(/^calc\(10ch \+/);
    expect(decl(top(".grid__col--date").body, "width")).toMatch(/^calc\(12ch \+/);
  });

  it("a text column cuts with an ellipsis", () => {
    const cut = top(".grid__cell--truncate");
    expect(decl(cut.body, "text-overflow")).toBe("ellipsis");
    expect(decl(cut.body, "overflow")).toBe("hidden");
  });
});

describe("density — 44px or 36px rows", () => {
  it("rows take the token layer's two row rails", () => {
    expect(decl(top(".grid").body, "--grid-row-h")).toBe("var(--row-h)");
    expect(decl(top('.grid[data-density="compact"]').body, "--grid-row-h")).toBe("var(--row-h-compact)");
    expect(decl(top(".grid__table th, .grid__table td").body, "height")).toBe("var(--grid-row-h)");
  });

  it("on touch a row stays 44px whatever the density, so the toggle is not drawn there", () => {
    const compact = inMedia(TOUCH, (s) => s === '.grid[data-density="compact"]');
    expect(decl(compact[0]!.body, "--grid-row-h")).toBe("var(--row-h)");
    const toggle = inMedia(TOUCH, (s) => s === ".grid__density");
    expect(decl(toggle[0]!.body, "display")).toBe("none");
  });
});

describe("the row as one link", () => {
  it("its link stretches over the whole row, the row its containing block in every engine", () => {
    const after = top(".grid__link::after");
    expect(decl(after.body, "position")).toBe("absolute");
    expect(decl(after.body, "inset")).toBe("0");
    const row = top(".grid__table tbody tr");
    expect(decl(row.body, "position")).toBe("relative");
    // NOT droppable: WebKit takes no relative table row as a containing block (WebKitGTK 2.52 —
    // without it every row's stretch covered the whole grid, and every click opened the last row).
    expect(decl(row.body, "transform")).toBe("scale(1)");
  });

  it("every other control in the row sits above the stretch", () => {
    const lifted = top(".grid__table tbody :is(a, button, input, select, textarea, summary):not(.grid__link)");
    expect(decl(lifted.body, "position")).toBe("relative");
    expect(Number(decl(lifted.body, "z-index"))).toBeGreaterThan(
      Number(decl(top(".grid__link::after").body, "z-index")),
    );
  });

  it("so does a cell's title-bearing text — under the stretch no title could ever show on hover", () => {
    // Measured in Chrome before this rule: hovering Postings' Created, Published as and Location
    // hit the row's link, so the exact instant and the cut names never showed.
    const lifted = top(".grid__table tbody :is(.grid__cell-text, [title])");
    expect(decl(lifted.body, "position")).toBe("relative");
    expect(Number(decl(lifted.body, "z-index"))).toBeGreaterThan(
      Number(decl(top(".grid__link::after").body, "z-index")),
    );
    // A plain click on it still opens the row (DataGridView), so a linked row keeps its pointer.
    expect(decl(top(".grid__table tbody tr:has(.grid__link) :is(.grid__cell-text, [title])").body, "cursor")).toBe(
      "pointer",
    );
  });

  it("a row showing an overlay of its own rises above the rows and the header, its stretch out of the hit test", () => {
    const showing = ".grid__table tbody tr:has(.copy-id__toast--on, .iconbtn:is(:hover, :focus-visible), [aria-expanded=\"true\"])";
    // Above `.table th`'s z-index 1 (the sticky header) — the first row's toast showed under it.
    expect(Number(decl(top(showing).body, "z-index"))).toBeGreaterThan(1);
    // WebKit draws a row's stretch down over the rows below: raised, it would take their clicks.
    expect(decl(top(`${showing} .grid__link::after`).body, "pointer-events")).toBe("none");
    // …and the sticky footer bar still covers a raised row (same z, later in the page).
    expect(Number(decl(top(".grid__footer").body, "z-index"))).toBeGreaterThanOrEqual(
      Number(decl(top(showing).body, "z-index")),
    );
  });

  it("focus rings the whole row with an OUTLINE (it survives forced colours)", () => {
    expect(decl(top(".grid__link:focus-visible::after").body, "outline")).toBe(
      "var(--border-bold) solid var(--focus-ring)",
    );
  });
});

describe("the pending state", () => {
  it("rows dim to the 60% step over --duration-fast; the clicked row stays bright", () => {
    expect(decl(top('.grid__table[aria-busy="true"] tbody tr').body, "opacity")).toBe("0.6");
    expect(decl(top('.grid__table[aria-busy="true"] tbody tr:has(.nav-pending--on)').body, "opacity")).toBe("1");
    expect(decl(top(".grid__table tbody tr").body, "transition")).toContain(
      "opacity var(--duration-fast) var(--ease-out)",
    );
  });

  it("a 2px shimmer runs under the header — the one looping motion, a progress indicator", () => {
    const cell = top(".grid__table .grid__progress-row > .grid__progress-cell");
    expect(decl(cell.body, "height")).toBe("var(--border-bold)");
    expect(decl(cell.body, "padding")).toBe("0");
    expect(decl(cell.body, "position")).toBe("sticky");
    expect(decl(cell.body, "top")).toBe("calc(var(--grid-head-top) + var(--grid-row-h))");
    expect(decl(top('.grid__table[aria-busy="true"] .grid__progress').body, "animation")).toBe(
      "grid-shimmer var(--duration-shimmer) var(--ease-in-out) infinite",
    );
  });

  it("no body-cell rhythm reaches the 2px track: the prose padding is the body rows' only", () => {
    // It was `.grid--prose .grid__table td` (0,2,1), which outranked the track (0,2,0) and drew
    // a 24px band under Feedback's header (measured in Chrome).
    expect(ALL.some((r) => r.selector === ".grid--prose .grid__table td")).toBe(false);
    expect(decl(top(".grid--prose .grid__table tbody td").body, "padding-block")).toBe("var(--space-3)");
    const paddedCells = ALL.filter(
      (r) => /\btd\b/.test(r.selector) && !r.selector.includes("tbody") && decl(r.body, "padding-block") !== null,
    );
    // Only the compact density, which zeroes it — the track keeps no padding either way.
    expect(paddedCells.map((r) => r.selector)).toEqual([
      '.grid[data-density="compact"] .grid__table th, .grid[data-density="compact"] .grid__table td',
    ]);
  });

  it("under reduced motion the shimmer holds still as a solid bar", () => {
    const still = inMedia(REDUCED, (s) => s === '.grid__table[aria-busy="true"] .grid__progress');
    expect(decl(still[0]!.body, "animation")).toBe("none");
    expect(decl(still[0]!.body, "background")).toBe("var(--text-heading)");
  });
});

describe("motion: subtle, tokened, opacity and transform only", () => {
  it("new rows fade in on --duration-fast, staggered for the first eight only", () => {
    const row = top(".grid__table tbody tr");
    expect(decl(row.body, "animation")).toBe("grid-row-in var(--duration-fast) var(--ease-enter) backwards");
    for (let n = 2; n <= 7; n++) {
      const delay = decl(top(`.grid__table tbody tr:nth-child(${n})`).body, "animation-delay");
      expect(delay, `row ${n}`).toBe(n === 2 ? "var(--stagger-step)" : `calc(var(--stagger-step) * ${n - 1})`);
    }
    expect(decl(top(".grid__table tbody tr:nth-child(n + 8)").body, "animation-delay")).toBe(
      "calc(var(--stagger-step) * 7)",
    );
  });

  it("every keyframe of the block animates only opacity and transform", () => {
    const frames = [...BLOCK.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?\})\s*\}/g)];
    expect(frames.map((m) => m[1])).toEqual(["grid-row-in", "grid-shimmer"]);
    for (const [, name, body] of frames) {
      const props = [...body!.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
      expect(props.every((p) => p === "opacity" || p === "transform"), name).toBe(true);
    }
  });

  it("the column chooser fades in over --duration-fast (140ms) and out faster, from 0.98", () => {
    const closed = top(".grid-menu__panel");
    expect(decl(closed.body, "visibility")).toBe("hidden");
    expect(decl(closed.body, "transform")).toBe("scale(var(--motion-enter-scale))");
    expect(decl(top('.grid-menu__panel[data-open="true"]').body, "transition")).toContain(
      "opacity var(--duration-fast) var(--ease-enter)",
    );
  });

  it("the sort arrow turns 180° for ascending", () => {
    expect(decl(top('.grid__sort[data-direction="ascending"] > .grid__sort-icon').body, "transform")).toBe(
      "rotate(180deg)",
    );
    expect(decl(top(".grid__sort-icon").body, "transition")).toBe("transform var(--duration-page) var(--ease-out)");
  });
});

describe("brand only — no new colour", () => {
  it("every colour in the block is a token (or transparent / currentColor)", () => {
    const literal = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/i;
    const offenders = ALL.flatMap((r) =>
      r.body
        .split(";")
        .filter((d) => /(^|\s)(color|background|background-color|border|border-color|box-shadow|outline|accent-color)\s*:/.test(d))
        .filter((d) => literal.test(d))
        .map((d) => `${r.selector} { ${d.trim()} }`),
    );
    expect(offenders).toEqual([]);
  });
});
