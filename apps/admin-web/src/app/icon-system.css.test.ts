import { describe, expect, it } from "vitest";
import { decl, globalsCss, rule, rules } from "../../test/css-rules";

/**
 * The icon system in the admin stylesheet: the shared sheet is imported, button icons size from
 * the shared tokens and inherit colour, and the IconButton SKIN holds its half of the contract
 * (brand colours, the ≥44px coarse-pointer hit area, a positioned anchor). The tooltip itself is
 * shared — `.bb-icon-tip`, tested in @badabhai/icons (icons-css.test.ts). Declared rules only —
 * the layout itself was measured in Chromium.
 */
const CSS = globalsCss();
const ALL = rules(CSS, true);
const TOP = rules(CSS);
const TOUCH = "@media (max-width: 600px), (pointer: coarse)";

function body(selector: string): string {
  const b = rule(CSS, selector);
  expect(b, `${selector} must be declared at top level`).not.toBeNull();
  return b!;
}
const topIndex = (selector: string) => TOP.findIndex((r) => r.selector === selector);

describe("the shared icon sheet", () => {
  it("is imported FIRST — library rules precede the app's, so an app rule wins a tie", () => {
    const tokens = CSS.indexOf('@import "@badabhai/design-tokens/tokens.css";');
    const icons = CSS.indexOf('@import "@badabhai/icons/icons.css";');
    expect(icons).toBeGreaterThanOrEqual(0);
    expect(tokens).toBeGreaterThan(icons);
    // Both before the first style rule — an @import after a rule is ignored by the browser.
    expect(tokens).toBeLessThan(CSS.indexOf("{"));
  });
});

describe("button icons — one size per control size, colour inherited", () => {
  it("md and sm controls draw their icon from the shared tokens", () => {
    expect(decl(body(".btn .ph-fill"), "font-size")).toBe("var(--icon-size-md)");
    expect(decl(body(".btn--sm .ph-fill"), "font-size")).toBe("var(--icon-size-sm)");
    // Same specificity: the sm rule must come later to win.
    expect(topIndex(".btn--sm .ph-fill")).toBeGreaterThan(topIndex(".btn .ph-fill"));
  });

  it("the icon ↔ label gap is the shared token", () => {
    expect(decl(body(".btn"), "gap")).toBe("var(--icon-gap)");
  });

  it("no rule colours an icon inside a button, so hover / active / disabled recolour it", () => {
    const coloured = ALL.filter(
      (r) => /\.(btn|iconbtn)\b[^,{]*\.ph-fill/.test(r.selector) && decl(r.body, "color") !== null,
    );
    expect(coloured.map((r) => r.selector)).toEqual([]);
  });
});

describe("nothing re-shows a hidden tooltip", () => {
  // The shared `<span class="bb-icon-tip">` is hidden with `display: none` in icons.css, which
  // loads first; a rule reaching a NESTED span (descendant `span` type selector) that sets
  // `display` outranks it and leaves the tooltip visible (measured in payer-web). A child
  // combinator (`> span`) cannot reach it — the tooltip always sits inside its button.
  const reachesNestedSpan = (selector: string) =>
    selector
      .split(",")
      .map((part) => part.trim().replace(/\s*([>+~])\s*/g, "$1"))
      .some((part) => /(^|\s)span(?![\w-])/.test(part));

  it("no rule, in any at-rule, sets display on a descendant span", () => {
    const offenders = ALL.filter((r) => reachesNestedSpan(r.selector))
      .filter((r) => {
        const display = decl(r.body, "display");
        return display !== null && display !== "none";
      })
      .map((r) => [...r.atRules, r.selector].join(" > "));
    expect(offenders).toEqual([]);
  });

  it("the probe sees a descendant span and allows a child-combinator one", () => {
    expect(reachesNestedSpan(".row span")).toBe(true);
    expect(reachesNestedSpan(".row > span")).toBe(false);
  });
});

describe("IconButton — brand colours", () => {
  it("rests in structural Shift Blue (--text-heading flips to paper on ink)", () => {
    expect(decl(body(".iconbtn"), "color")).toBe("var(--text-heading)");
  });

  it("an active utility (pressed / expanded) takes the Safety Yellow fill with a navy glyph", () => {
    const active = body('.iconbtn[aria-pressed="true"], .iconbtn[aria-expanded="true"]');
    expect(decl(active, "background")).toBe("var(--brand)");
    expect(decl(active, "color")).toBe("var(--text-on-brand)");
  });

  it("disabled steps down to the 40% primary", () => {
    const disabled = body(".iconbtn:disabled");
    expect(decl(disabled, "color")).toBe("var(--text-disabled)");
  });
});

describe("IconButton — the tooltip is the shared one, not a local copy", () => {
  it("no `.iconbtn__tip` rules remain here (the tooltip is `.bb-icon-tip` in icons.css)", () => {
    expect(ALL.filter((r) => r.selector.includes("__tip")).map((r) => r.selector)).toEqual([]);
  });

  it("the skin is the tooltip's positioned anchor", () => {
    expect(decl(body(".iconbtn"), "position")).toBe("relative");
  });
});

describe("IconButton — 44px hit area on a phone or coarse pointer", () => {
  it("md is a 44×44 square at every width", () => {
    expect(decl(body(".iconbtn"), "inline-size")).toBe("var(--control-md)");
    expect(decl(body(".iconbtn"), "block-size")).toBe("var(--control-md)");
  });

  it("sm grows its HIT AREA to 44×44 under the touch query, not its drawn 36px", () => {
    expect(decl(body(".iconbtn--sm"), "inline-size")).toBe("var(--control-sm)");
    const strip = ALL.find(
      (r) => r.selector === ".iconbtn--sm::before" && r.atRules.join() === TOUCH,
    );
    expect(strip).toBeDefined();
    expect(decl(strip!.body, "position")).toBe("absolute");
    expect(decl(strip!.body, "inset")).toBe("calc((100% - var(--control-md)) / 2)");
    // …and only there: desktop density is untouched.
    expect(
      ALL.filter((r) => r.selector === ".iconbtn--sm::before" && r.atRules.join() !== TOUCH),
    ).toEqual([]);
    // The host is the containing block for the strip.
    expect(decl(body(".iconbtn"), "position")).toBe("relative");
  });
});

/**
 * Owner brief 2026-10-01 (item 6): glyphs in the nav, the matrix and the disclosures, aligned
 * from the shared size/gap tokens, and 44px targets on touch for the small text links.
 */
describe("nav, matrix and disclosure glyphs", () => {
  it("the nav glyph sizes from the shared scale and takes the row's colour", () => {
    const icon = body(".sidebar__icon");
    expect(decl(icon, "font-size")).toBe("var(--icon-size-sm)");
    expect(decl(icon, "color")).toBeNull();
    expect(decl(body(".sidebar__link"), "gap")).toBe("var(--icon-gap)");
  });

  it("the back link and an icon link set their glyph from the scale, at the shared gap", () => {
    expect(decl(body(".backlink"), "gap")).toBe("var(--icon-gap)");
    expect(decl(body(".backlink .ph-fill"), "font-size")).toBe("var(--icon-size-sm)");
    expect(decl(body(".link--icon"), "align-items")).toBe("center");
    expect(decl(body(".link--icon .ph-fill"), "font-size")).toBe("var(--icon-size-sm)");
  });

  it("a `not granted` mark is the 60% secondary step, not the near-invisible faint one", () => {
    expect(decl(body(".mark--no"), "color")).toBe("var(--icon-secondary)");
  });

  it("the browser's disclosure triangle is hidden wherever the brand caret replaces it", () => {
    for (const s of [".reviewgroup > summary", ".enroll__manual > summary"]) {
      expect(decl(body(s), "list-style"), s).toBe("none");
      expect(decl(body(`${s}::-webkit-details-marker`), "display"), s).toBe("none");
    }
  });

  it("the caret points along the line when closed and down when open", () => {
    expect(decl(body(".disclosure__caret"), "transform")).toBe("rotate(-90deg)");
    expect(decl(body("details[open] > summary > .disclosure__caret"), "transform")).toBe("none");
    expect(decl(body(".disclosure__caret"), "font-size")).toBe("var(--icon-size-sm)");
  });
});

describe("the header's title block shares its row with the actions when they fit", () => {
  it("grows into the row, with a floor that still lets a long action cluster wrap below", () => {
    const heading = body(".page__heading");
    expect(decl(heading, "flex")).toBe("1 1 18rem");
    expect(decl(heading, "min-inline-size")).toBe("0");
  });
});

describe("44px targets on a phone or coarse pointer (and only there)", () => {
  const touch = (selector: string) => {
    const r = ALL.find((x) => x.selector === selector && x.atRules.join() === TOUCH);
    expect(r, `${selector} must be declared under the touch query`).toBeDefined();
    return r!.body;
  };

  it("table links grow a row-high hit strip, the .btn--sm technique", () => {
    const host = touch(".table td > .link, .table th > .link");
    expect(decl(host, "position")).toBe("relative");
    const strip = touch(".table td > .link::before, .table th > .link::before");
    expect(decl(strip, "content")).toBe('""');
    expect(decl(strip, "position")).toBe("absolute");
    expect(decl(strip, "inset-block")).toBe("calc((100% - var(--control-md)) / 2)");
    // …and none on a mouse: desktop density is unchanged.
    expect(
      ALL.filter((r) => r.selector.includes(".link::before") && r.atRules.join() !== TOUCH),
    ).toEqual([]);
  });

  it("rows are taller than the strip on touch, so no strip reaches into the next row", () => {
    expect(decl(touch(".table tbody td, .table tbody th"), "height")).toBe(
      "calc(var(--control-md) + var(--space-1))",
    );
  });

  it("the table scroller contains row-level hidden labels, so they cannot widen the page", () => {
    expect(decl(body(".tablewrap"), "position")).toBe("relative");
  });

  it("two links stacked in one cell take the height themselves, so neither steals the other's taps", () => {
    const stacked = touch(".table :is(td, th) > br + .link, .table :is(td, th) > .link:has(+ br)");
    expect(decl(stacked, "min-block-size")).toBe("var(--control-md)");
    expect(
      decl(
        touch(".table :is(td, th) > br + .link::before, .table :is(td, th) > .link:has(+ br)::before"),
        "content",
      ),
    ).toBe("none");
  });

  it("a record row's link takes the height itself (no strip: rows sit 12px apart)", () => {
    const kv = touch(".kv__v > .link");
    expect(decl(kv, "display")).toBe("inline-flex");
    expect(decl(kv, "min-block-size")).toBe("var(--control-md)");
    expect(ALL.filter((r) => r.selector.includes(".kv__v > .link::before"))).toEqual([]);
  });

  it("back links, id chips, the crumb's section link and disclosure rows reach 44px", () => {
    expect(decl(touch(".backlink"), "min-block-size")).toBe("var(--control-md)");
    expect(decl(touch(".chip > .link"), "min-block-size")).toBe("var(--control-md)");
    expect(decl(touch(".crumb__link"), "line-height")).toBe("var(--control-md)");
    expect(decl(touch(".reviewgroup > summary, .enroll__manual > summary"), "min-block-size")).toBe(
      "var(--control-md)",
    );
  });
});
