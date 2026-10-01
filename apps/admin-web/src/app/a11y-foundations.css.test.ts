import { describe, expect, it } from "vitest";
import {
  decl,
  declaredProperties,
  globalsCss,
  resolveToken,
  rule,
  rules,
  tokensCss,
  valueTokens,
  type Rule,
} from "../../test/css-rules";

/**
 * Accessibility foundations of the admin stylesheet (#1856, wave 2). The node env has no layout
 * engine, so these pin the DECLARED rules; each was measured in headless Chrome at
 * 320/375/768/1280 when it was written (forced colours via `emulateMedia`).
 *
 *  - Ink theme: the warn pill's text/tint pairing, computed from the tokens themselves.
 *  - The drawer toggle's glyph: a solid Phosphor fill in the brand's navigation colour.
 *  - Touch targets: 44px on a phone or any coarse pointer; desktop density untouched.
 *  - Forced colours: every focus indicator survives a mode that drops box-shadows.
 */
const CSS = globalsCss();
const TOKENS = tokensCss();
const ALL = rules(CSS, true);
const TOP = rules(CSS);

/** The declarations of the top-level rule whose selector list is exactly `selector`. */
function body(selector: string): string {
  const b = rule(CSS, selector);
  expect(b, `${selector} must be declared at top level`).not.toBeNull();
  return b!;
}

// ---- colour maths (WCAG 2.x relative luminance) ------------------------------------------

type Rgba = { r: number; g: number; b: number; a: number };

function parseColor(value: string): Rgba {
  const v = value.trim().toLowerCase();
  if (v.startsWith("#")) {
    const hex = v.slice(1);
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
    const n = (i: number) => parseInt(full.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: full.length === 8 ? n(6) / 255 : 1 };
  }
  if (v.startsWith("rgb")) {
    const parts = v
      .slice(v.indexOf("(") + 1, v.lastIndexOf(")"))
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    return { r: parts[0]!, g: parts[1]!, b: parts[2]!, a: parts[3] ?? 1 };
  }
  throw new Error(`unparsed colour: ${value}`);
}

/** `top` painted over `under` (source-over). */
function over(top: Rgba, under: Rgba): Rgba {
  const a = top.a + under.a * (1 - top.a);
  const mix = (t: number, u: number) => (t * top.a + u * under.a * (1 - top.a)) / a;
  return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b), a };
}

function luminance({ r, g, b }: Rgba): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(fg: Rgba, bg: Rgba): number {
  const text = over(fg, bg);
  const [hi, lo] = [luminance(text), luminance(bg)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** A declared colour value (`var(--x)` or a literal) resolved through the token layer. */
const color = (value: string, theme?: string) =>
  parseColor(value.startsWith("var(") ? resolveToken(TOKENS, value.slice(4, -1).trim(), theme) : value);

/**
 * The warn pill's text contrast in `theme`, on its own tint over the card, and — the
 * `simulated` tag's usual home — on a warn tile's tint over the card. `textOverride` lets the
 * fence prove it can FAIL: it reproduces the pairing that shipped before the fix.
 */
function warnPillContrast(theme: string | undefined, textOverride?: string) {
  const pill = body(".pill--warn");
  const inkRule = rule(CSS, '[data-theme="ink"] .pill--warn');
  const text =
    textOverride ?? (theme === "ink" && inkRule ? decl(inkRule, "color") : null) ?? decl(pill, "color")!;
  const card = color("var(--surface-card)", theme);
  const tint = color(decl(pill, "background")!, theme);
  const tileTint = color(decl(body(".stat--warn"), "background")!, theme);
  const onCard = over(tint, card);
  const onWarnTile = over(tint, over(tileTint, card));
  return {
    onCard: contrast(color(text, theme), onCard),
    onWarnTile: contrast(color(text, theme), onWarnTile),
  };
}

describe("ink theme — the warn pill stays legible", () => {
  it("the fence reproduces the shipped failure (--ink-800 on the ink tint is under 3:1)", () => {
    // Measured in Chrome before the fix: 1.13:1 on the card, 1.40:1 on a warn tile. If this
    // stops failing, the maths below is not measuring the pairing it claims to.
    const before = warnPillContrast("ink", "var(--ink-800)");
    expect(before.onCard).toBeLessThan(3);
    expect(before.onWarnTile).toBeLessThan(3);
  });

  it("clears 4.5:1 on the pill's own tint over the ink card", () => {
    expect(warnPillContrast("ink").onCard).toBeGreaterThanOrEqual(4.5);
  });

  it("clears 4.5:1 on a warn tile — the simulated tag's home on /transactions", () => {
    expect(warnPillContrast("ink").onWarnTile).toBeGreaterThanOrEqual(4.5);
  });

  it("is a token, not a literal (a raw colour would not follow the palette)", () => {
    const ink = rule(CSS, '[data-theme="ink"] .pill--warn');
    expect(ink).not.toBeNull();
    expect(decl(ink!, "color")).toMatch(/^var\(--[\w-]+\)$/);
  });

  it("leaves the light pairing as it was, and legible", () => {
    expect(decl(body(".pill--warn"), "color")).toBe("var(--ink-800)");
    const light = warnPillContrast(undefined);
    expect(light.onCard).toBeGreaterThanOrEqual(4.5);
    expect(light.onWarnTile).toBeGreaterThanOrEqual(4.5);
  });
});

describe("the drawer toggle's glyph (an IconButton drawing the self-hosted Phosphor fill)", () => {
  it("the inline-SVG `.ph-icon` copy is gone — the glyph is the shared icon font", () => {
    expect(rule(CSS, ".ph-icon")).toBeNull();
    expect(CSS).toContain('@import "@badabhai/icons/icons.css";');
  });

  it("is sized like payer-web's hamburger and coloured as structural navigation", () => {
    const btn = body(".iconbtn");
    // --icon-size-md aliases --text-lg (20px): payer-web's hamburger size.
    expect(decl(btn, "font-size")).toBe("var(--icon-size-md)");
    // Shift Blue on light surfaces, paper on ink — never the raw brand colour, which would
    // vanish on the ink card.
    expect(decl(btn, "color")).toBe("var(--text-heading)");
    // The menu itself sets neither, so nothing overrides the IconButton's.
    expect(decl(body(".topbar__menu"), "font-size")).toBeNull();
    expect(decl(body(".topbar__menu"), "color")).toBeNull();
  });

  it("keeps its 44px target wherever it is shown — the IconButton is a 44×44 square", () => {
    const btn = body(".iconbtn");
    expect(decl(btn, "inline-size")).toBe("var(--control-md)");
    expect(decl(btn, "block-size")).toBe("var(--control-md)");
    const tier = ALL.find(
      (r) => r.selector === ".topbar__menu" && r.atRules.join() === "@media (max-width: 1023px)",
    );
    expect(tier).toBeDefined();
    expect(decl(tier!.body, "display")).toBe("inline-flex");
  });

  it("stays hidden above 1024px: `.topbar__menu` hides it AFTER every `.iconbtn` rule shows it", () => {
    // Equal single-class specificity — source order is the whole guarantee. ANY top-level rule
    // for one of the toggle's IconButton classes that sets `display` must come before the hide.
    const hide = TOP.findIndex(
      (r) => r.selector === ".topbar__menu" && decl(r.body, "display") === "none",
    );
    expect(hide).toBeGreaterThanOrEqual(0);
    const shows = TOP.flatMap((r, i) =>
      r.selector.split(",").some((p) => [".iconbtn", ".iconbtn--outline"].includes(p.trim())) &&
      decl(r.body, "display") !== null
        ? [i]
        : [],
    );
    expect(shows.length).toBeGreaterThan(0);
    expect(shows.filter((i) => i > hide)).toEqual([]);
  });
});

// ---- touch targets ------------------------------------------------------------------------

const TOUCH = "@media (max-width: 600px), (pointer: coarse)";
const touchRule = (selector: string) =>
  ALL.find((r) => r.selector === selector && r.atRules.join() === TOUCH);

/** The last top-level (every-width) declaration of `prop` on exactly `selector`. */
function lastTopLevel(selector: string, prop: string): string | null {
  let value: string | null = null;
  for (const r of TOP) if (r.selector === selector) value = decl(r.body, prop) ?? value;
  return value;
}

describe("touch targets — 44px on a phone or any coarse pointer", () => {
  it("drawer links take the height itself (a strip would overlap the next 40px-pitch row)", () => {
    const link = touchRule(".sidebar__link");
    expect(link).toBeDefined();
    expect(decl(link!.body, "min-height")).toBe("var(--control-md)");
  });

  it("a small button grows its HIT area with a strip behind its label", () => {
    const host = touchRule(".btn--sm");
    expect(host).toBeDefined();
    expect(decl(host!.body, "position")).toBe("relative");
    // Its own stacking context, so the strip's negative z-index stays inside the button.
    expect(decl(host!.body, "isolation")).toBe("isolate");
    const strip = touchRule(".btn--sm::before");
    expect(strip).toBeDefined();
    expect(decl(strip!.body, "content")).toBe('""');
    expect(decl(strip!.body, "position")).toBe("absolute");
    expect(decl(strip!.body, "z-index")).toBe("calc(var(--z-base) - 1)");
    expect(decl(strip!.body, "inset-block")).toBe("calc((100% - var(--control-md)) / 2)");
    // Never NARROWER than the button: the inline inset is 0 unless the button is under 44px.
    expect(decl(strip!.body, "inset-inline")).toBe("min(0px, calc((100% - var(--control-md)) / 2))");
  });

  it("the drawn desktop density is untouched — both stay --control-sm at every width", () => {
    expect(lastTopLevel(".sidebar__link", "min-height")).toBe("var(--control-sm)");
    expect(lastTopLevel(".btn--sm", "min-height")).toBe("var(--control-sm)");
    // And nothing outside the touch query reaches either element's size or hit area.
    const leaks = ALL.filter(
      (r) =>
        r.atRules.join() !== TOUCH &&
        (r.selector === ".btn--sm::before" ||
          (r.selector === ".sidebar__link" && decl(r.body, "min-height") === "var(--control-md)")),
    );
    expect(leaks.map((r) => r.selector)).toEqual([]);
  });

  it("the touch rules come AFTER every single-class rule they override", () => {
    // Equal specificity, so source order decides: declared first, they would silently lose.
    const lastBase = (sel: string) =>
      ALL.map((r) => r.selector === sel && r.atRules.length === 0).lastIndexOf(true);
    const touchAt = (sel: string) => ALL.findIndex((r) => r === touchRule(sel));
    expect(lastBase(".sidebar__link")).toBeGreaterThanOrEqual(0);
    expect(touchAt(".sidebar__link")).toBeGreaterThan(lastBase(".sidebar__link"));
    expect(touchAt(".btn--sm")).toBeGreaterThan(lastBase(".btn--sm"));
  });

  it("nothing declared AFTER the touch rules takes back what they set, in any at-rule", () => {
    // Same specificity again, so a LATER rule wins wherever it sits — and the PR-D1 phone tier
    // is declared after this block. A phone-tier `.sidebar__link { min-height: var(--control-sm) }`
    // would undo the 44px drawer rows on every phone with every check above still green.
    // Conservative on purpose: a later rule in ANY at-rule counts (a string fence cannot prove
    // two media queries disjoint), unless it repeats the touch value exactly.
    const insets = (axis: "block" | "inline", start: string, end: string) => [
      `inset-${axis}`,
      "inset",
      start,
      end,
      `inset-${axis}-start`,
      `inset-${axis}-end`,
    ];
    const overriddenBy: Record<string, string[]> = {
      "min-height": ["min-height", "min-block-size"],
      "inset-block": insets("block", "top", "bottom"),
      "inset-inline": insets("inline", "left", "right"),
    };
    const undone: string[] = [];
    for (const sel of [".sidebar__link", ".btn--sm", ".btn--sm::before"]) {
      const touch = touchRule(sel)!;
      expect(touch, sel).toBeDefined();
      for (const later of ALL.slice(ALL.indexOf(touch) + 1)) {
        if (!later.selector.split(",").some((part) => part.trim() === sel)) continue;
        for (const prop of declaredProperties(touch.body)) {
          for (const rival of overriddenBy[prop] ?? [prop]) {
            const value = decl(later.body, rival);
            if (value !== null && !(rival === prop && value === decl(touch.body, prop))) {
              undone.push(`${[...later.atRules, later.selector].join(" > ")} { ${rival} }`);
            }
          }
        }
      }
    }
    expect(undone).toEqual([]);
  });
});

// ---- forced colours -----------------------------------------------------------------------

const ADMIN_RING = ":where(a, button, input, select, textarea, summary, [tabindex]):focus-visible";

/**
 * A zero length in any unit — `0`, `0px`, `0.0em`, `calc(0px)` — but never `0.5px` or a
 * `calc(0px + …)`.
 */
const isZeroLength = (token: string) => {
  const t = token.startsWith("calc(") && token.endsWith(")") ? token.slice(5, -1).trim() : token;
  return /^[+-]?(\d+\.?\d*|\.\d+)([a-z%]+)?$/i.test(t) && parseFloat(t) === 0;
};

/** The outline-style keywords that draw something — every one but `none` / `hidden`. */
const DRAWN_STYLES = new Set([
  "auto",
  "solid",
  "dashed",
  "dotted",
  "double",
  "groove",
  "ridge",
  "inset",
  "outset",
]);

/** A declared value, case-folded and without `!important` — `NONE !important` is still none. */
const declared = (body: string, property: string) =>
  decl(body, property)
    ?.replace(/!\s*important\s*$/i, "")
    .trim()
    .toLowerCase() ?? null;

/**
 * Does a rule's own outline draw nothing? No outline declared at all; one whose style is `none`
 * or whose width is zero in any unit — anywhere in the shorthand (it is order-free: `solid 0px`
 * is as lost as `0`) or in an `outline-style` / `outline-width` longhand; or a shorthand that
 * names no style at all, which resets the style to `none` (`outline: 2px var(--focus-ring)`,
 * `outline: transparent`).
 */
function outlineLost(body: string): boolean {
  const shorthand = declared(body, "outline");
  const style = declared(body, "outline-style");
  if (shorthand === null && style === null) return true;
  const zeroed = [shorthand, style, declared(body, "outline-width")]
    .filter((v): v is string => v !== null)
    .flatMap(valueTokens)
    .some((t) => t === "none" || t === "hidden" || isZeroLength(t));
  if (zeroed) return true;
  return style === null && !valueTokens(shorthand ?? "").some((t) => DRAWN_STYLES.has(t));
}

/**
 * Rules that draw a focus ring with a box-shadow — on the focused element or on a host keyed off
 * a focused descendant (`:focus-within`, `:has(… :focus-visible)`) — and declare no outline to
 * survive forced colours, which drop every box-shadow.
 */
function ringsLostInForcedColors(rs: Rule[]): string[] {
  return rs
    .filter((r) => r.selector.includes(":focus"))
    .filter((r) => {
      const shadow = decl(r.body, "box-shadow");
      return shadow !== null && shadow !== "none";
    })
    .filter((r) => outlineLost(r.body))
    .map((r) => r.selector);
}

describe("focus in forced colours", () => {
  it("a transparent outline backs the token layer's shadow-only ring", () => {
    // tokens.css: `:focus-visible { outline: none; box-shadow: var(--ring-focus) }`. A focusable
    // scroller (the roles matrix) matched only that, and showed nothing in forced colours.
    const fallback = body(":focus-visible");
    expect(decl(fallback, "outline")).toBe("var(--border-bold) solid transparent");
    expect(decl(fallback, "outline-offset")).toBe("var(--border-bold)");
  });

  it("sits BEFORE the admin ring, so the visible ring still wins where both apply", () => {
    // Both are (0,1,0). Moved after it, the fallback would make every admin ring transparent.
    const fallback = TOP.findIndex((r) => r.selector === ":focus-visible");
    const ring = TOP.findIndex((r) => r.selector === ADMIN_RING);
    expect(fallback).toBeGreaterThanOrEqual(0);
    expect(ring).toBeGreaterThan(fallback);
    expect(decl(TOP[ring]!.body, "outline")).toBe("2px solid var(--focus-ring)");
  });

  it("draws OUTSIDE the element, so no pinned table cell can cover a scroller's ring", () => {
    expect(decl(body(":focus-visible"), "outline-offset")).not.toMatch(/^-|^calc\(-/);
    const scrollerOverrides = ALL.filter(
      (r) =>
        r.selector.includes(".tablewrap") &&
        (decl(r.body, "outline") !== null || decl(r.body, "outline-offset") !== null),
    );
    expect(scrollerOverrides.map((r) => r.selector)).toEqual([]);
  });

  it("the guard catches a shadow-only ring on the element or on a :focus-within / :has host", () => {
    const fixture = rules(
      ".a:focus-visible { outline: none; box-shadow: var(--ring-focus); }" +
        ".b:focus-within { box-shadow: var(--ring-focus); }" +
        ".c:has(> input:focus-visible) { outline: 0; box-shadow: var(--ring-focus); }" +
        ".d:focus-visible { outline: var(--border-bold) solid transparent; box-shadow: var(--ring-focus); }" +
        ".e:focus-visible { box-shadow: none; }" +
        // A zero width in any unit, in any position of the shorthand, or in a longhand.
        ".f:focus-visible { outline: 0px; box-shadow: var(--ring-focus); }" +
        ".g:focus-visible { outline: solid 0.0em var(--focus-ring); box-shadow: var(--ring-focus); }" +
        ".h:focus-visible { outline: var(--border-bold) solid; outline-width: 0; box-shadow: var(--ring-focus); }" +
        ".i:focus-visible { outline: var(--border-bold) solid; outline-style: none; box-shadow: var(--ring-focus); }" +
        // A shorthand naming no style resets it to `none`; case and `!important` change nothing.
        ".m:focus-visible { outline: 2px var(--focus-ring); box-shadow: var(--ring-focus); }" +
        ".n:focus-visible { outline: transparent; box-shadow: var(--ring-focus); }" +
        ".o:focus-visible { outline: NONE !important; box-shadow: var(--ring-focus); }" +
        ".p:focus-visible { outline: calc(0px) solid var(--focus-ring); box-shadow: var(--ring-focus); }" +
        // What it must PERMIT: a width that merely starts with 0, and zeros inside a function.
        ".j:focus-visible { outline: 0.5px solid var(--focus-ring); box-shadow: var(--ring-focus); }" +
        ".k:focus-visible { outline: calc(0px + var(--border-bold)) solid var(--focus-ring); box-shadow: var(--ring-focus); }" +
        ".l:focus-visible { outline: var(--border-bold) solid color(srgb 0 0 0); box-shadow: var(--ring-focus); }" +
        // …an upper-case style keyword, and a style set by its own longhand.
        ".q:focus-visible { outline: var(--border-bold) SOLID var(--focus-ring); box-shadow: var(--ring-focus); }" +
        ".r:focus-visible { outline: var(--border-bold) var(--focus-ring); outline-style: solid; box-shadow: var(--ring-focus); }",
      true,
    );
    expect(ringsLostInForcedColors(fixture)).toEqual([
      ".a:focus-visible",
      ".b:focus-within",
      ".c:has(> input:focus-visible)",
      ".f:focus-visible",
      ".g:focus-visible",
      ".h:focus-visible",
      ".i:focus-visible",
      ".m:focus-visible",
      ".n:focus-visible",
      ".o:focus-visible",
      ".p:focus-visible",
    ]);
  });

  it("no ring in the admin stylesheet is shadow-only (every at-rule walked)", () => {
    // Not vacuous: the admin ring itself draws a box-shadow band and is checked here.
    const shadowRings = ALL.filter((r) => {
      const shadow = decl(r.body, "box-shadow");
      return r.selector.includes(":focus") && shadow !== null && shadow !== "none";
    });
    expect(shadowRings.map((r) => r.selector)).toContain(ADMIN_RING);
    expect(ringsLostInForcedColors(ALL)).toEqual([]);
  });
});
