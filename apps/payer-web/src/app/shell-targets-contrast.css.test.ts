import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decl, parseRules, stripComments, tokenValue } from "../../test/css-rules";
import type { Rule } from "../../test/css-rules";

/**
 * FINAL SWEEP C — the shell's targets, the shared tooltip's anchors, and three contrast fixes
 * (source-level fence; node env, no layout engine). Each finding was MEASURED in Chromium at
 * 375/768/1024/1280/1440px (touch and fine pointer, paper and ink) before the fix:
 *   F04  rail / drawer links drew and hit 36px (239x36 in the drawer, 52x36 on the icon rail);
 *   F07  two text links hit 21–22px (`.ai-chat-intro__alt`) and 20px (`.dash-posting__applicants`);
 *   F23  the theme switch's track boundary was 1.35:1 (paper) / 2.65:1 (ink) on the header;
 *   F24  ink "Unlocked" was 3.25:1 (14px bold text);
 *   F25  the brand avatar's initials were 4.42:1;
 *   F26  the icon-only header / dialog / toast controls had no shared tooltip to anchor.
 * The contrast checks resolve the real tokens (both themes) and compute the WCAG ratio.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]) => stripComments(readFileSync(join(here, ...p), "utf8"));
const G = parseRules(read("globals.css"));
const D = parseRules(read("..", "styles", "ds-components.css"));
const TOKENS = read("..", "..", "..", "..", "packages", "design-tokens", "tokens.css");

const TOUCH = "@media (max-width: 600px), (pointer: coarse)";
const RAIL_TOUCH = "@media (max-width: 1279px), (pointer: coarse)";

/** The ONE rule whose selector list is exactly `selector` in context `at` ("" = top level). */
function one(rules: Rule[], selector: string, at = ""): Rule {
  const norm = (s: string) => s.replace(/,\s*/g, ",");
  const hits = rules.filter((r) => norm(r.selector) === norm(selector) && r.at === at);
  expect(hits, `exactly one rule for \`${selector}\` in "${at || "top level"}"`).toHaveLength(1);
  return hits[0]!;
}

/** A token's px value (the light `:root` declaration). */
function tokenPx(name: string): number {
  const v = tokenValue(TOKENS, name);
  expect(v, `token ${name}`).toMatch(/^\d+px$/);
  return Number(v!.replace("px", ""));
}

/** A token resolved through its var() chain — paper (`:root`) or ink (`[data-theme="ink"]`). */
const INK = parseRules(TOKENS).filter((r) => r.selector === '[data-theme="ink"]' && r.at === "");
function themed(name: string, theme: "paper" | "ink"): string {
  let v: string | null = null;
  if (theme === "ink") for (const r of INK) v = decl(r, name) ?? v;
  v = v ?? tokenValue(TOKENS, name);
  expect(v, `token ${name} must be declared`).not.toBeNull();
  const chained = v!.match(/^var\((--[\w-]+)\)$/);
  return chained ? themed(chained[1]!, theme) : v!;
}
/** The `var(--x)` a declaration spends (its last term), e.g. a border's colour. */
const colourVar = (value: string) => {
  const m = value.match(/var\((--[\w-]+)\)\s*$/);
  expect(m, `expected a trailing var() colour in "${value}"`).not.toBeNull();
  return m![1]!;
};

/** WCAG 2.x contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    expect(hex, "expected a #rrggbb literal (an alpha colour has no fixed ratio)").toMatch(
      /^#[0-9a-fA-F]{6}$/,
    );
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const f = (x: number) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(bl!);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe("the contrast probe can fail (so a pass below means something)", () => {
  it("reproduces the measured failures from the tokens", () => {
    const card = (t: "paper" | "ink") => themed("--surface-card", t);
    // Measured in Chromium: 1.35:1, 3.25:1 and 4.42:1.
    expect(contrast(themed("--border-default", "paper"), card("paper"))).toBeLessThan(3);
    expect(contrast(themed("--success", "ink"), card("ink"))).toBeLessThan(4.5);
    expect(
      contrast(themed("--vermilion-800", "paper"), themed("--saffron-200", "paper")),
    ).toBeLessThan(4.5);
    // The ink "on" border was a 42% accent: no fixed ratio, so the probe refuses it outright.
    expect(themed("--brand-border", "ink")).not.toMatch(/^#/);
  });
});

/* ================================================================== *
 * F04 — the rail's targets.
 * ================================================================== */
describe("F04 · rail and drawer links are 44px wherever a finger may use them", () => {
  it("below the full rail and on any coarse pointer, each row (and the collapse button) is DRAWN ≥44px", () => {
    const r = one(G, ".pnav__link, .pshell__collapse", RAIL_TOUCH);
    expect(decl(r, "min-height")).toBe("var(--control-md)");
    expect(tokenPx("--control-md")).toBeGreaterThanOrEqual(44);
    expect(r.body.split(";").filter((p) => p.includes(":"))).toHaveLength(1);
  });

  it("the ≥1280px fine-pointer rail keeps its density (36px rows)", () => {
    expect(decl(one(G, ".pnav__link"), "min-height")).toBe("var(--control-sm)");
    expect(decl(one(G, ".pshell__collapse"), "min-height")).toBe("var(--control-sm)");
    expect(tokenPx("--control-sm")).toBeLessThan(44);
    // The lift comes AFTER both bases, so at equal specificity it wins where it applies.
    const at = (sel: string, ctx = "") => G.findIndex((r) => r.selector === sel && r.at === ctx);
    const lift = G.findIndex((r) => r.at === RAIL_TOUCH && r.selector.includes(".pnav__link"));
    expect(lift).toBeGreaterThan(at(".pnav__link"));
    expect(lift).toBeGreaterThan(at(".pshell__collapse"));
  });

  it("no pseudo strip on a rail row: the rows sit 2px apart and clip their own overflow", () => {
    expect(decl(one(G, ".pnav__link"), "overflow")).toBe("hidden");
    const strips = G.filter((r) => /\.pnav__link[^,]*::?before/.test(r.selector));
    expect(strips.map((r) => r.selector)).toEqual([]);
  });

  it("no other rule re-sizes a rail row", () => {
    const sizing = G.filter(
      (r) =>
        /\.pnav__link(?![\w-])/.test(r.selector) &&
        ["min-height", "height", "max-height"].some((p) => decl(r, p) !== null),
    ).map((r) => `${r.selector} (${r.at || "top"})`);
    expect(sizing).toEqual([".pnav__link (top)", `.pnav__link, .pshell__collapse (${RAIL_TOUCH})`]);
  });
});

/* ================================================================== *
 * F05 — the collapse toggle leaves the tab order only through CSS.
 * ================================================================== */
describe("F05 · the collapse toggle is hidden by `display: none` wherever it is not drawn", () => {
  it("below 1280px it is display:none — which is what takes it out of the tab order", () => {
    expect(
      decl(
        one(G, ".pshell__collapse", "@media (max-width: 1279px) and (min-width: 1024px)"),
        "display",
      ),
    ).toBe("none");
    expect(decl(one(G, ".pshell__collapse", "@media (max-width: 1023px)"), "display")).toBe("none");
  });
});

/* ================================================================== *
 * F07 — two text links take the text-link hit strip.
 * ================================================================== */
describe("F07 · the AI intro's manual-form link and the agency row's Applicants link are 44px on touch", () => {
  const dsStrip = D.find(
    (r) =>
      r.at.includes("max-width: 600px") &&
      r.selector
        .split(",")
        .map((s) => s.trim())
        .includes(".bb-btn--sm::before"),
  )!;

  it.each([".ai-chat-intro__alt", ".dash-posting__applicants"])(
    "%s: a 44px strip, centred, behind the text, never shrinking the link sideways",
    (link) => {
      const strip = one(G, `${link}::before`, TOUCH);
      expect(decl(strip, "content")).toBe('""');
      expect(decl(strip, "position")).toBe("absolute");
      expect(decl(strip, "inset-block")).toBe("calc((100% - var(--control-md)) / 2)");
      expect(decl(strip, "inset-inline")).toBe("min(0%, calc((100% - var(--control-md)) / 2))");
      // One idea, not two: the DS small button's reach and layer.
      expect(dsStrip, "the DS small-button strip must exist").toBeDefined();
      expect(decl(strip, "inset-block")).toBe(decl(dsStrip, "inset-block"));
      expect(decl(strip, "z-index")).toBe(decl(dsStrip, "z-index"));
    },
  );

  it("the AI link is the strip's positioned, isolated host", () => {
    const host = one(G, ".ai-chat-intro__alt", TOUCH);
    expect(decl(host, "position")).toBe("relative");
    expect(decl(host, "isolation")).toBe("isolate");
  });

  it("the Applicants link keeps its own stacking (above the card's stretched link) and its ≤560px hide", () => {
    const base = one(G, ".dash-posting__applicants");
    expect(decl(base, "position")).toBe("relative");
    expect(decl(base, "z-index")).toBe("calc(var(--z-base) + 2)");
    const host = one(G, ".dash-posting__applicants", TOUCH);
    expect(decl(host, "isolation")).toBe("isolate");
    // No display (or position) in the touch rule: it comes after the ≤560px `display: none`.
    expect(decl(host, "display")).toBeNull();
    expect(decl(host, "position")).toBeNull();
    expect(decl(one(G, ".dash-posting__applicants", "@media (max-width: 560px)"), "display")).toBe(
      "none",
    );
  });
});

/* ================================================================== *
 * F23 / F24 / F25 — contrast, from the tokens, in both themes.
 * ================================================================== */
describe("F23 · the theme switch's track boundary clears 3:1 against the header (SC 1.4.11)", () => {
  const track = one(G, ".theme-toggle__track");
  const on = one(G, '.theme-toggle__switch[aria-checked="true"] .theme-toggle__track');

  it("the header the switch sits on is the card surface", () => {
    expect(decl(one(G, ".pshell__header"), "background")).toBe("var(--surface-card)");
  });

  it.each(["paper", "ink"] as const)(
    "off: the track's border on the %s header and page",
    (theme) => {
      const border = themed(colourVar(decl(track, "border")!), theme);
      expect(contrast(border, themed("--surface-card", theme))).toBeGreaterThanOrEqual(3);
      // /login: the same toggle sits on the page surface.
      expect(contrast(border, themed("--surface-page", theme))).toBeGreaterThanOrEqual(3);
    },
  );

  it("on (the ink theme): the solid accent border on the ink header and page", () => {
    const border = themed(colourVar(decl(on, "border-color")!), "ink");
    expect(contrast(border, themed("--surface-card", "ink"))).toBeGreaterThanOrEqual(3);
    expect(contrast(border, themed("--surface-page", "ink"))).toBeGreaterThanOrEqual(3);
  });
});

describe('F24 · ink "Unlocked" clears AA on the ink card', () => {
  it("the ink rule re-points ONLY the colour, to a token that clears 4.5:1; paper keeps --success", () => {
    const ink = one(D, '[data-theme="ink"] .bb-candidate__unlocked');
    expect(ink.body.split(";").filter((p) => p.includes(":"))).toHaveLength(1);
    const colour = colourVar(decl(ink, "color")!);
    expect(contrast(themed(colour, "ink"), themed("--surface-card", "ink"))).toBeGreaterThanOrEqual(
      4.5,
    );
    const base = one(D, ".bb-candidate__unlocked");
    expect(decl(base, "color")).toBe("var(--success)");
    expect(
      contrast(themed("--success", "paper"), themed("--surface-card", "paper")),
    ).toBeGreaterThanOrEqual(4.5);
  });
});

describe("F25 · the brand avatar's initials clear AA on its plate (both themes)", () => {
  it.each(["paper", "ink"] as const)("%s", (theme) => {
    const r = one(D, ".bb-avatar--brand");
    const fg = themed(colourVar(decl(r, "color")!), theme);
    const bg = themed(colourVar(decl(r, "background")!), theme);
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
});

/* ================================================================== *
 * F26 — every control that renders the shared tooltip is its positioned anchor.
 * ================================================================== */
describe("F26 · the shared tooltip's anchors are positioned at every width", () => {
  it.each([
    [".pshell__menu", "globals.css"],
    [".theme-toggle__switch", "globals.css"],
    [".bb-toast__close", "ds-components.css"],
    [".bb-iconbtn", "ds-components.css"],
  ] as const)("%s (%s) is position: relative at the top level", (sel, file) => {
    expect(decl(one(file === "globals.css" ? G : D, sel), "position")).toBe("relative");
  });
});

/* ================================================================== *
 * Review — the CLOSED drawer is out of the Tab order (and the accessibility tree).
 * ================================================================== */
describe("review · below 1024px the closed drawer is hidden, not just off-screen", () => {
  const DRAWER = "@media (max-width: 1023px)";

  it("closed: visibility hidden — after the slide-out (a delay of the slide's duration)", () => {
    // Measured before: translateX(-100%) alone kept its 7 links as Tab stops 1–7 at 375 / 900px.
    const closed = one(G, ".pshell__rail", DRAWER);
    expect(decl(closed, "transform")).toBe("translateX(-100%)");
    expect(decl(closed, "visibility")).toBe("hidden");
    expect(decl(closed, "transition")!.replace(/\s+/g, " ")).toBe(
      "transform var(--duration-base) var(--ease-out), visibility 0s linear var(--duration-base)",
    );
  });

  it("open: visible at once (visibility is not transitioned on the way in)", () => {
    const open = one(G, ".pshell--drawer-open .pshell__rail", DRAWER);
    expect(decl(open, "transform")).toBe("translateX(0)");
    expect(decl(open, "visibility")).toBe("visible");
    expect(decl(open, "transition")).toBe("transform var(--duration-base) var(--ease-out)");
  });

  it("≥1024px the rail is untouched: no rule outside the drawer query hides it", () => {
    const hiding = G.filter(
      (r) => r.selector.includes("pshell__rail") && decl(r, "visibility") !== null,
    ).map((r) => `${r.selector} (${r.at || "top"})`);
    expect(hiding).toEqual([
      `.pshell__rail (${DRAWER})`,
      `.pshell--drawer-open .pshell__rail (${DRAWER})`,
    ]);
    expect(decl(one(G, ".pshell__rail"), "visibility")).toBeNull();
  });

  it("under reduced motion neither drawer state slides — the open rule is more specific", () => {
    // Measured before: the reset listed `.pshell__rail` alone, and the open drawer's own rule
    // (0,2,0) kept its transform transition under prefers-reduced-motion.
    const REDUCE = "@media (prefers-reduced-motion: reduce)";
    const reset = G.filter(
      (r) =>
        r.at === REDUCE && decl(r, "transition") === "none" && r.selector.includes("pshell__rail"),
    );
    expect(reset).toHaveLength(1);
    const covered = new Set(reset[0]!.selector.split(",").map((p) => p.trim()));
    // Every rule that gives the rail a transition — outside the motion-gated contexts — is reset.
    const moving = G.filter(
      (r) =>
        r.at !== REDUCE &&
        !r.at.includes("prefers-reduced-motion: no-preference") &&
        decl(r, "transition") !== null,
    )
      .flatMap((r) => r.selector.split(",").map((p) => p.trim()))
      .filter((p) => p.includes("pshell__rail"));
    expect(moving).toEqual([".pshell__rail", ".pshell--drawer-open .pshell__rail"]);
    for (const sel of moving) expect(covered.has(sel), sel).toBe(true);
  });

  it("nothing inside the hidden drawer opts back in (`visibility: visible` would leak a Tab stop)", () => {
    const visible = [...G, ...D]
      .filter((r) => decl(r, "visibility") === "visible")
      .map((r) => r.selector);
    expect(visible).toEqual([".pshell--drawer-open .pshell__rail"]);
  });
});
