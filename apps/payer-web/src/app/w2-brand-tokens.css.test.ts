import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decl, parseRules, stripComments, tokenValue } from "../../test/css-rules";
import type { Rule } from "../../test/css-rules";

/**
 * W2 (#2582) — payer-web CSS token sweep, as a source-level lint fence (node env, no layout
 * engine; the repo carries no stylelint, so the rules are enforced here instead):
 *   - no raw px font size and nothing under 11px in app CSS;
 *   - no raw hex colour in app CSS (the job-card preview aside), and no payer-web override of
 *     the shared navy ramp: payer-web ships Shift Blue #05194C from tokens.css;
 *   - table headers never take the muted step; every header rule clears 4.5:1 on its own fill,
 *     light and ink;
 *   - ONE active-nav plate, painted by CSS from the server-rendered class (readable with JS
 *     disabled, never sliding in on load); W6 (#2586) hands it to a gliding marker only once a
 *     script has placed that marker (w6-transitions.css.test.ts);
 *   - no hover lift on static containers; every hover transform sits under `(hover: hover)`, the
 *     moved element transitions on the fast (140ms) token, and reduced motion zeroes the travel;
 *   - KPI values take the compact size on phones.
 */

const here = dirname(fileURLToPath(import.meta.url));
const raw = (...p: string[]) => readFileSync(join(here, ...p), "utf8");
const GLOBALS = stripComments(raw("globals.css"));
const DS = stripComments(raw("..", "styles", "ds-components.css"));
const TOKENS = stripComments(
  raw("..", "..", "..", "..", "packages", "design-tokens", "tokens.css"),
);
const SIDEBAR = raw("(portal)", "sidebar-nav.tsx");

const RULES: Rule[] = [...parseRules(GLOBALS), ...parseRules(DS)];

/** The job-card preview is a scaled replica of the worker app's card (pinned to the app's own
 *  values by job-card-preview.css.test.ts); its sizes are `calc(N * --jcp-u)` and its colours
 *  are the app's. It is the one component exempt from the token sweep. */
const isJcp = (r: Rule) => r.selector.split(",").every((s) => s.trim().startsWith(".jcp"));

const px = (value: string, root = 16): number | null => {
  const m = /^(\d+(?:\.\d+)?)(px|rem)$/.exec(value.trim());
  if (m === null) return null;
  return m[2] === "rem" ? Number(m[1]) * root : Number(m[1]);
};

/** Resolve `var(--token)` against tokens.css (and payer-web's own `:root`) to a px number. */
function resolvePx(value: string, depth = 0): number | null {
  const v = value.replace(/!important/, "").trim();
  const direct = px(v);
  if (direct !== null) return direct;
  const m = /^var\((--[\w-]+)\)$/.exec(v);
  if (m === null || depth > 4) return null;
  const t = tokenValue(GLOBALS, m[1]!) ?? tokenValue(TOKENS, m[1]!);
  if (t === null) return null;
  return resolvePx(t.replace(/\s*\/\*.*$/, ""), depth + 1);
}

type Theme = "light" | "ink";

/** The `[data-theme="ink"]` token overrides. The theme toggle sets the attribute on <html>, so
 *  payer-web's aliases (`--muted`, `--panel-2`) resolve through them on that same element. */
const INK = [...parseRules(TOKENS), ...parseRules(GLOBALS)]
  .filter((r) => r.at === "" && r.selector === '[data-theme="ink"]')
  .map((r) => r.body)
  .join(";");

function hexOf(name: string, theme: Theme = "light", depth = 0): string {
  const ink = theme === "ink" ? tokenValue(INK, name) : null;
  const v = (ink ?? tokenValue(GLOBALS, name) ?? tokenValue(TOKENS, name) ?? "").trim();
  const m = /^var\((--[\w-]+)\)$/.exec(v);
  if (m !== null && depth < 5) return hexOf(m[1]!, theme, depth + 1);
  return v;
}

const HEX = /^#(?:[0-9a-fA-F]{3}){1,2}$/;

/** A declared colour as a hex in `theme`: a literal hex or a `var(--token)` chain. Anything else
 *  (an rgb(), a gradient, `inherit`) comes back as written, so it fails the HEX check. */
function colourOf(value: string, theme: Theme): string {
  const m = /^var\((--[\w-]+)\)$/.exec(value.trim());
  return m === null ? value.trim() : hexOf(m[1]!, theme);
}

function luminance(hex: string): number {
  const n = hex.replace("#", "");
  const full = n.length === 3 ? [...n].map((c) => c + c).join("") : n;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe("W2 #2582 — font sizes", () => {
  const sized = RULES.filter((r) => !isJcp(r) && decl(r, "font-size") !== null);

  it("no raw px font size in app CSS — every size is a token", () => {
    const offenders = sized
      .filter((r) => /\d(px|pt)\b/.test(decl(r, "font-size")!))
      .map((r) => `${r.selector} → ${decl(r, "font-size")}`);
    expect(offenders).toEqual([]);
  });

  it("no font size under 11px", () => {
    const offenders = sized
      .map((r) => ({ r, size: resolvePx(decl(r, "font-size")!) }))
      .filter(({ size }) => size !== null && size > 0 && size < 11)
      .map(({ r, size }) => `${r.selector} → ${size}px`);
    expect(offenders).toEqual([]);
  });
});

describe("W2 #2582 — colours", () => {
  const headers = RULES.filter((r) => /(^|[\s,])(thead )?th(\s*,|$)|\bth$/.test(r.selector));

  it("no raw hex colour in app CSS outside the job-card preview", () => {
    const offenders = RULES.filter((r) => !isJcp(r))
      .filter((r) => /#[0-9a-fA-F]{3,8}\b/.test(r.body))
      .map((r) => r.selector);
    expect(offenders).toEqual([]);
  });

  it("payer-web ships the shared Shift Blue ramp — no `--navy-*` or `--brand-primary-rgb` override", () => {
    // Re-declaring either re-points every navy surface, alpha step, ring and shadow off-brand.
    const redeclared = [GLOBALS, DS].flatMap(
      (css) => css.match(/--(?:navy-\d+|brand-primary-rgb)\s*:/g) ?? [],
    );
    expect(redeclared).toEqual([]);
    expect(hexOf("--navy-900")).toBe("#05194c");
    expect(
      tokenValue(GLOBALS, "--brand-primary-rgb") ?? tokenValue(TOKENS, "--brand-primary-rgb"),
    ).toBe("5 25 76");
  });

  it("table headers never take the muted step — the old `.pshell__content .table thead th` override is gone", () => {
    expect(headers.length).toBeGreaterThan(0);
    for (const r of headers) {
      const color = decl(r, "color");
      if (color === null) continue;
      expect(color, r.selector).not.toMatch(/--text-(muted|faint)\b/);
    }
    expect(RULES.some((r) => r.selector === ".pshell__content .table thead th")).toBe(false);
  });

  it("every table-header rule clears 4.5:1 on its own fill, in the light and the ink theme", () => {
    // A header rule that leaves `color` or `background` unset takes it from a base rule. Which
    // base applies depends on the markup, so the unset value is checked against both.
    const base = (selector: string): Rule => {
      const r = RULES.find((x) => x.at === "" && x.selector === selector);
      expect(r, `the ${selector} base rule`).toBeDefined();
      return r!;
    };
    const bases = [base("th"), base(".table th")];
    const fill = (r: Rule) => decl(r, "background") ?? decl(r, "background-color");
    for (const theme of ["light", "ink"] as const) {
      for (const r of headers) {
        for (const b of bases) {
          const where = `${r.selector} [${theme}; unset values from ${b.selector}]`;
          const fg = colourOf(decl(r, "color") ?? decl(b, "color") ?? "", theme);
          const bg = colourOf(fill(r) ?? fill(b) ?? "", theme);
          expect(fg, where).toMatch(HEX);
          expect(bg, where).toMatch(HEX);
          expect(contrast(fg, bg), where).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });
});

describe("W2 #2582 — active nav", () => {
  const active = RULES.filter((r) =>
    /\.pnav__link--active(?![\w-])/.test(r.selector.replace(/:not\(\.pnav__link--active\)/g, "")),
  );

  it("exactly one rule paints the active row's plate, at top level, not behind .pshell", () => {
    const painters = active.filter((r) => decl(r, "background") !== null);
    const plates = painters.filter((r) => decl(r, "background") !== "transparent");
    expect(plates.map((r) => r.selector)).toEqual([
      ".pnav__link--active, .pnav__link--active:hover",
    ]);
    expect(plates[0]!.at).toBe("");
    // W6 (#2586): the one other background on an active row is the hand-over to the gliding
    // marker. It only CLEARS the plate, and only once a script has placed the marker
    // (`.pnav[data-marker]`, rail-marker.ts) — so before scripts, and with them off, the rule
    // above is the only one that applies.
    expect(
      painters.filter((r) => !plates.includes(r)).map((r) => `${r.selector} (${r.at || "top"})`),
    ).toEqual([".pnav[data-marker] .pnav__link--active (top)"]);
  });

  it("the active label is readable on its own plate (≥ 4.5:1) — no script needed", () => {
    const painter = active.find((r) => decl(r, "background") !== null)!;
    const bg = hexOf(decl(painter, "background")!.replace(/^var\((--[\w-]+)\)$/, "$1"));
    const fg = hexOf(decl(painter, "color")!.replace(/^var\((--[\w-]+)\)$/, "$1"));
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it("no plate measured before paint or sliding in on load, and no load-time icon pop", () => {
    // The old plate was measured in a layout effect and slid in from the top on every load. W6's
    // marker (rail-marker.ts) is not drawn until it is placed, and appears there without a
    // transition (w6-transitions.css.test.ts); the row's own plate stays the static one.
    expect(SIDEBAR).not.toContain("pnav__plate");
    expect(SIDEBAR).not.toMatch(/useLayoutEffect|getBoundingClientRect/);
    expect(RULES.some((r) => r.selector.includes("pnav__plate"))).toBe(false);
    expect(active.some((r) => decl(r, "animation") !== null)).toBe(false);
  });
});

describe("W2 #2582 — hover", () => {
  // Literal patterns (no dynamic RegExp): `.<class>` not followed by a
  // word/hyphen char, then `:hover` within the same compound selector.
  const STATIC: readonly RegExp[] = [
    /\.panel(?![\w-])[^ ]*:hover/,
    /\.posting-card(?![\w-])[^ ]*:hover/,
    /\.applicant(?![\w-])[^ ]*:hover/,
    /\.credit-pack(?![\w-])[^ ]*:hover/,
    /\.capacity-tier(?![\w-])[^ ]*:hover/,
    /\.agency-job(?![\w-])[^ ]*:hover/,
  ];

  it("static containers have no hover lift", () => {
    const offenders = RULES.filter((r) => r.selector.includes(":hover"))
      .filter((r) => STATIC.some((re) => re.test(r.selector)))
      .map((r) => r.selector);
    expect(offenders).toEqual([]);
  });

  /** True when a rule moves its element: it sets a transform other than `none`. */
  const moves = (r: Rule) => {
    const t = decl(r, "transform");
    return t !== null && t !== "none";
  };
  const selectorsOf = (r: Rule) => r.selector.split(",").map((s) => s.trim());

  /** Every hover lift: each `:hover` selector of a `(hover: hover)` rule that moves its element. */
  const LIFTS = RULES.filter((r) => r.at.includes("(hover: hover)") && moves(r))
    .flatMap(selectorsOf)
    .filter((s) => s.includes(":hover"));

  it("every hover transform sits under (hover: hover) — nothing stays lifted after a tap", () => {
    const offenders = RULES.filter((r) => r.selector.includes(":hover"))
      .filter((r) => !r.selector.includes("bb-tooltip")) // positions the tooltip, not a lift
      .filter(moves)
      .filter((r) => !r.at.includes("(hover: hover)"))
      .map((r) => r.selector);
    expect(offenders).toEqual([]);
  });

  /** A selector's descendant compounds, minus the state pseudo-classes (`:hover`, `:not(…)`):
   *  what is left names the element a hover rule moves. */
  const compounds = (selector: string) =>
    selector
      .replace(/:hover|:not\([^)]*\)/g, "")
      .trim()
      .split(/\s+/);

  /** True when base selector `b` selects the element that hover selector `h` moves: the same
   *  subject, with b's ancestors appearing in order among h's. */
  function selectsMoved(b: string, h: string): boolean {
    const [bc, hc] = [compounds(b), compounds(h)];
    if (bc[bc.length - 1] !== hc[hc.length - 1]) return false;
    const ancestors = bc.slice(0, -1);
    let i = 0;
    for (const c of hc.slice(0, -1)) if (c === ancestors[i]) i += 1;
    return i === ancestors.length;
  }

  /** The steps of a `transition` that move `transform`: its own step, `all`, or the control token. */
  const transformSteps = (transition: string | null) =>
    (transition ?? "")
      .split(/,(?![^(]*\))/)
      .map((s) => s.trim().replace(/\s+/g, " "))
      .filter((s) => /^(transform|all)(\s|$)/.test(s) || s === "var(--transition-control)");

  it("every hover lift runs on the fast (140ms) motion token, read from the moved element's transition", () => {
    // The control token counts as fast only because its own transform step is.
    expect(tokenValue(TOKENS, "--duration-fast")).toBe("140ms");
    expect(transformSteps(tokenValue(TOKENS, "--transition-control"))).toEqual([
      "transform var(--duration-fast) var(--ease-out)",
    ]);
    expect(LIFTS.length).toBeGreaterThan(0);
    const bases = RULES.filter((r) => !r.at.includes("prefers-reduced-motion"));
    for (const lift of LIFTS) {
      const steps = bases
        .filter((r) => r.selector.split(",").some((b) => selectsMoved(b.trim(), lift)))
        .flatMap((r) => transformSteps(decl(r, "transition")));
      expect(steps, `${lift}: the moved element has no transform transition`).not.toEqual([]);
      for (const step of steps) {
        expect(step, lift).toMatch(/var\(--duration-fast\)|^var\(--transition-control\)$/);
      }
    }
  });

  it("reduced motion zeroes every hover lift's travel — `transform: none` on the same selector, after the lift", () => {
    // The tokens only zero durations, so without this the element jumps instead of moving.
    // ds-components.css is @imported at the top of globals.css, so its rules come first in the
    // cascade; an equal-specificity override wins only when it comes after the lift.
    const cascade = [...parseRules(DS), ...parseRules(GLOBALS)];
    expect(LIFTS.length).toBeGreaterThan(0);
    for (const lift of LIFTS) {
      let last = -1;
      cascade.forEach((r, i) => {
        if (r.at.includes("(hover: hover)") && moves(r) && selectorsOf(r).includes(lift)) last = i;
      });
      const zeroed = cascade.some(
        (r, i) =>
          i > last &&
          r.at.includes("prefers-reduced-motion: reduce") &&
          decl(r, "transform") === "none" &&
          selectorsOf(r).includes(lift),
      );
      expect(zeroed, `${lift} keeps its travel under reduced motion`).toBe(true);
    }
  });
});

describe("W2 #2582 — KPI values on phones", () => {
  it("dashboard KPI values take the compact size at phone width", () => {
    const phone = RULES.find(
      (r) =>
        r.at === "@media (max-width: 600px)" &&
        r.selector === ".stat-row--kpi .dash-kpi .bb-stat__value",
    );
    expect(phone).toBeDefined();
    expect(decl(phone!, "font-size")).toBe("var(--ui-kpi-sm-size)");
  });
});
