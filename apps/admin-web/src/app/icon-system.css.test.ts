import { describe, expect, it } from "vitest";
import { TOOLTIP_DISMISSED_ATTRIBUTE } from "@badabhai/icons";
import { decl, globalsCss, rule, rules } from "../../test/css-rules";

/**
 * The icon system in the admin stylesheet: the shared sheet is imported, button icons size from
 * the shared tokens and inherit colour, and the IconButton's tooltip + hit area hold the
 * contract (@badabhai/icons `IconOnlyControlProps`). Declared rules only — the layout itself was
 * measured in Chromium when this was written.
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
const allIndex = (selector: string, atRules: string[] = []) =>
  ALL.findIndex((r) => r.selector === selector && r.atRules.join() === atRules.join());

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

describe("IconButton — the tooltip shows on hover AND keyboard focus, and Escape wins", () => {
  it("is hidden by default and catches no clicks while hidden", () => {
    const tip = body(".iconbtn__tip");
    expect(decl(tip, "opacity")).toBe("0");
    expect(decl(tip, "visibility")).toBe("hidden");
    expect(decl(tip, "pointer-events")).toBe("none");
    expect(decl(tip, "z-index")).toBe("var(--z-tooltip)");
  });

  it("keyboard focus shows it at every width", () => {
    const focus = body(".iconbtn:focus-visible .iconbtn__tip");
    expect(decl(focus, "opacity")).toBe("1");
    expect(decl(focus, "visibility")).toBe("visible");
  });

  it("hover shows it only where hover exists (a tap must not leave a stuck bubble)", () => {
    expect(rule(CSS, ".iconbtn:hover .iconbtn__tip")).toBeNull();
    const hover = ALL.find(
      (r) =>
        r.selector === ".iconbtn:hover .iconbtn__tip" &&
        r.atRules.join() === "@media (hover: hover)",
    );
    expect(hover).toBeDefined();
    expect(decl(hover!.body, "visibility")).toBe("visible");
  });

  it("the Escape rule keys on the shared attribute and comes after both triggers", () => {
    const sel = `.iconbtn[${TOOLTIP_DISMISSED_ATTRIBUTE}] .iconbtn__tip`;
    const dismissed = body(sel);
    expect(decl(dismissed, "visibility")).toBe("hidden");
    expect(allIndex(sel)).toBeGreaterThan(allIndex(".iconbtn:focus-visible .iconbtn__tip"));
    expect(allIndex(sel)).toBeGreaterThan(
      allIndex(".iconbtn:hover .iconbtn__tip", ["@media (hover: hover)"]),
    );
  });

  it("every placement has a gap bridge so the pointer can move onto the tooltip", () => {
    for (const side of ["top", "bottom", "start", "end"]) {
      expect(rule(CSS, `.iconbtn__tip--${side}`), side).not.toBeNull();
      expect(rule(CSS, `.iconbtn__tip--${side}::before`), side).not.toBeNull();
    }
    expect(decl(body(".iconbtn__tip::before"), "content")).toBe('""');
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
