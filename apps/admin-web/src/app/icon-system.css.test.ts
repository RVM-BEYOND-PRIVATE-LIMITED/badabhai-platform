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
