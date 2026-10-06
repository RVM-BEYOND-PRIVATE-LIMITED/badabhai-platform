import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decl, parseRules, stripComments, tokenValue } from "../../test/css-rules";
import type { Rule } from "../../test/css-rules";

/**
 * PR-D2 — /login, /dashboard, /credits PHONE LAYOUT FENCE (source-level, measured where possible).
 *
 * Node env, no layout engine (see agency-b5-layout.css.test.ts for the same approach). What each
 * fix below depends on is DECLARED geometry, so this suite pins it:
 *   · ARITHMETIC — the login code row: resolves the six OTP cells against the real token values
 *     of the chrome around them at real phone widths (it used to wrap 4 + 2 on every phone);
 *   · STRUCTURE  — the phone reflows (KPI ledger rows, 2-up quick actions, posting rows, no-wrap
 *     ledgers) and the opt-in boundary that keeps other `.stat-row` consumers unchanged;
 *   · ORDER      — the phone rules win over their bases at EQUAL specificity, i.e. only by coming
 *     later in the file. A reorder would silently undo them with every other gate green.
 * The layouts themselves were measured in a real browser at 320/360/375/480/1280px when built.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CSS = stripComments(readFileSync(join(here, "globals.css"), "utf8"));
const TOKENS = stripComments(
  readFileSync(
    join(here, "..", "..", "..", "..", "packages", "design-tokens", "tokens.css"),
    "utf8",
  ),
);
const RULES = parseRules(CSS);

const PHONE = "max-width: 480px";
const NARROW = "max-width: 600px";
const SMALL = "max-width: 375px";

/** `atNeedle === ""` means TOP LEVEL (not inside any at-rule). */
const inContext = (r: Rule, atNeedle: string) =>
  atNeedle === "" ? r.at === "" : r.at.includes(atNeedle);

/** Index of the rule whose selector list is EXACTLY `selector` in the given context. */
function ruleIndex(selector: string, atNeedle = ""): number {
  const norm = (s: string) => s.replace(/,\s*/g, ",");
  const hits = RULES.map((r, i) => ({ r, i })).filter(
    ({ r }) => norm(r.selector) === norm(selector) && inContext(r, atNeedle),
  );
  expect(
    hits,
    `expected exactly one rule for \`${selector}\`${atNeedle ? ` in ${atNeedle}` : ""}`,
  ).toHaveLength(1);
  return hits[0]!.i;
}
const rule = (selector: string, atNeedle = ""): Rule => RULES[ruleIndex(selector, atNeedle)]!;

/** A custom property's value as declared in tokens.css `:root` (light ramp). */
function token(name: string): string {
  const v = tokenValue(TOKENS, name);
  expect(v, `token ${name} must be declared in tokens.css`).not.toBeNull();
  return v!;
}

/** The first whitespace-separated term of a shorthand, respecting parentheses. */
function firstTerm(value: string): string {
  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]!;
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (/\s/.test(ch) && depth === 0) return value.slice(0, i);
  }
  return value;
}

/** Resolve `var(--x)` (through a var chain) or a `calc(a + b + …)` of them to px. */
function px(expr: string): number {
  const e = expr.trim();
  const v = e.match(/^var\((--[\w-]+)\)$/);
  if (v) return px(token(v[1]!));
  const lit = e.match(/^(-?[\d.]+)px$/);
  if (lit) return Number(lit[1]);
  const calc = e.match(/^calc\(([\s\S]+)\)$/);
  if (calc) {
    const terms = calc[1]!.split(/\s\+\s/);
    expect(terms.length, `only a sum is supported here: ${e}`).toBeGreaterThan(1);
    return terms.reduce((sum, t) => sum + px(t), 0);
  }
  throw new Error(`not resolvable to px: "${e}"`);
}

/* ================================================================== *
 * /login — the six-digit code is ONE row on every phone.
 * ================================================================== */
describe("PR-D2 · /login — the code row fits one line at phone widths", () => {
  const otp = rule(".login-otp .bb-otp");
  const cell = rule(".login-otp .bb-otp__cell");

  it("the row is a grid of zero-minimum tracks capped at the DS cell width", () => {
    // The DS row is a WRAPPING inline-flex of fixed 44–52px cells; inside the card that split
    // the code 4 + 2. Zero-minimum tracks shrink instead of wrapping.
    expect(decl(otp, "display")).toBe("grid");
    expect(decl(otp, "grid-auto-flow")).toBe("column");
    expect(decl(otp, "grid-auto-columns")).toBe("minmax(0, var(--control-lg))");
    expect(decl(cell, "width")).toBe("100%");
    expect(decl(cell, "min-width")).toBe("0");
  });

  it("the chrome around the row is still built from the tokens this test measures", () => {
    expect(decl(rule(".login-card"), "--login-pad")).toBe("var(--space-7)");
    expect(decl(rule(".login-card"), "padding")).toBe("var(--login-pad)");
    expect(decl(rule(".login-card"), "max-width")).toBe("var(--app-max)");
    expect(decl(rule(".login-card", PHONE), "--login-pad")).toBe("var(--space-5)");
    expect(decl(rule(".login-card", SMALL), "--login-pad")).toBe("var(--space-4)");
    // ≤480: "<top> <inline> <bottom>" — the inline inset is the middle value.
    expect(decl(rule(".login-wrap--auth", PHONE), "padding")).toMatch(
      /\)\s+var\(--space-4\)\s+var\(--space-6\)$/,
    );
    expect(decl(rule(".login-wrap--auth", SMALL), "padding-inline")).toBe("var(--space-3)");
    // The neutral 404 reuses `.login-wrap` with no toggle: no phone rule may reach the bare class.
    expect(() => rule(".login-wrap", PHONE)).toThrow();
    expect(() => rule(".login-wrap", SMALL)).toThrow();
    expect(decl(otp, "gap")).toBe("var(--space-2)");
  });

  it("MEASURED: six cells + five gaps fit, each still ≥ 36px wide, at 320/360/375/414/480px", () => {
    const hairline = px("var(--border-hairline)");
    const gap = px(decl(otp, "gap")!);
    const capped = px("var(--control-lg)");
    for (const vw of [320, 360, 375, 414, 480]) {
      const wrapInline = vw <= 375 ? px("var(--space-3)") : px("var(--space-4)");
      const cardPad = vw <= 375 ? px("var(--space-4)") : px("var(--space-5)");
      const cardW = Math.min(vw - 2 * wrapInline, px("var(--app-max)"));
      const content = cardW - 2 * cardPad - 2 * hairline;
      const cellW = Math.min(capped, (content - 5 * gap) / 6);
      expect(6 * cellW + 5 * gap, `the row must fit the card at ${vw}px`).toBeLessThanOrEqual(
        content,
      );
      // Six 44px cells cannot fit the ~262px a 320px screen leaves, so the phone cell shrinks:
      // 37.3px at 320, 43.7px at 360, 46px at 375 (height stays 52px). 36px guards the real
      // floor and still clears WCAG 2.5.8's 24px minimum target size.
      expect(cellW, `a cell must stay tappable/legible at ${vw}px`).toBeGreaterThanOrEqual(36);
    }
  });

  it("on the desktop card the cells stay at the DS size (the cap binds, nothing grows)", () => {
    const content =
      px("var(--app-max)") - 2 * px("var(--space-7)") - 2 * px("var(--border-hairline)");
    const gap = px(decl(otp, "gap")!);
    expect((content - 5 * gap) / 6).toBeGreaterThanOrEqual(px("var(--control-lg)"));
  });

  it("the theme toggle scrolls away on phones, and the wrap reserves its row", () => {
    expect(decl(rule(".login-theme"), "position")).toBe("fixed");
    expect(decl(rule(".login-theme", PHONE), "position")).toBe("absolute");
    const top = px(decl(rule(".login-theme"), "top")!);
    const switchH =
      px(decl(rule(".theme-toggle__track"), "height")!) +
      2 * px(decl(rule(".theme-toggle__switch"), "padding")!);
    const reserved = px(firstTerm(decl(rule(".login-wrap--auth", PHONE), "padding")!));
    expect(reserved, "the card must start below the toggle").toBeGreaterThan(top + switchH);
  });

  it("the brand band bleeds by exactly the card inset (so a phone inset moves it too)", () => {
    const band = rule(".login-card__brand");
    expect(decl(band, "margin")).toBe(
      "calc(-1 * var(--login-pad)) calc(-1 * var(--login-pad)) var(--space-6)",
    );
    expect(decl(band, "background")).toBe("var(--surface-ink)");
    expect(decl(rule(".login-card"), "overflow")).toBe("hidden");
  });
});

/* ================================================================== *
 * /dashboard — the phone reflows, and the opt-in boundary.
 * ================================================================== */
describe("PR-D2 · /dashboard — KPI band is opt-in and becomes ledger rows on phones", () => {
  it("the shared .stat-row primitive is UNCHANGED for its other consumers", () => {
    const base = rule(".stat-row");
    expect(decl(base, "display")).toBe("grid");
    expect(decl(base, "grid-template-columns")).toBe(
      "repeat(auto-fit, minmax(var(--stat-min), 1fr))",
    );
    // No phone rule targets the bare primitive.
    expect(RULES.filter((r) => r.selector === ".stat-row" && r.at !== "")).toEqual([]);
  });

  it("the KPI variant wraps and lets a lone last tile span the row (no hole beside it)", () => {
    expect(decl(rule(".stat-row--kpi"), "display")).toBe("flex");
    expect(decl(rule(".stat-row--kpi"), "flex-wrap")).toBe("wrap");
    expect(decl(rule(".stat-row--kpi > *"), "flex")).toBe("1 1 var(--stat-min)");
  });

  it("≤600px: each tile is a one-row ledger line (icon · label/caption · figure)", () => {
    const tile = rule(".stat-row--kpi .bb-stat", NARROW);
    expect(decl(tile, "display")).toBe("grid");
    expect(decl(tile, "grid-template-areas")).toMatch(/"icon label value"\s+"icon caption value"/);
    expect(decl(rule(".stat-row--kpi .bb-stat__head", NARROW), "display")).toBe("contents");
    expect(decl(rule(".stat-row--kpi > *", NARROW), "flex-basis")).toBe("100%");
  });

  it("W3-A ≤600px: the label/caption pair is CENTRED on the tile, with or without a caption", () => {
    // Two content rows alone left a caption-less label (referral funnel, earnings) at the bottom
    // of row 1 — 9.6px above the centre line the icon and figure sit on (measured at 375px).
    // Between two equal 1fr spacer rows the pair is centred, and an absent caption's row is 0.
    const tile = rule(".stat-row--kpi .bb-stat", NARROW);
    expect(decl(tile, "grid-template-rows")).toBe("1fr auto auto auto 1fr");
    const rows = decl(tile, "grid-template-areas")!.match(/"[^"]*"/g);
    expect(rows).toEqual([
      '"icon . value"',
      '"icon label value"',
      '"icon caption value"',
      '"icon delta value"',
      '"icon . value"',
    ]);
    // No row gap: three gaps between four rows would push a lone label off-centre by half one.
    expect(decl(tile, "gap")).toBeNull();
    expect(decl(tile, "row-gap")).toBeNull();
    expect(decl(tile, "align-items")).toBe("center");
    // The rows place the pair now; a self-alignment on either would fight the spacers.
    for (const sel of [".stat-row--kpi .bb-stat__label", ".stat-row--kpi .bb-stat__caption"]) {
      expect(decl(rule(sel, NARROW), "align-self"), sel).toBeNull();
    }
  });

  it("W3-A ≤600px: EVERY child StatTile can render has its own named area (the '.' cells stay empty)", () => {
    // The spacer cells are empty grid cells, and auto-placement FILLS empty cells: a child with
    // no area (the trend `delta`) landed in row 1 / column 2, above the label — measured at 375px
    // the text block sat 8.7px off the tile's centre. The children are read from the component,
    // so a new one cannot be added without a place in this grid.
    const display = readFileSync(join(here, "..", "components", "ds", "display.tsx"), "utf8");
    const start = display.indexOf("export function StatTile(");
    const body = display.slice(start, display.indexOf("\n}\n", start));
    const children = [
      ...new Set([...body.matchAll(/bb-stat__([a-z]+)(?![\w-])/g)].map((m) => m[1]!)),
    ];
    expect(children).toEqual(
      expect.arrayContaining(["head", "label", "icon", "value", "caption", "delta"]),
    );
    const tile = rule(".stat-row--kpi .bb-stat", NARROW);
    const areas = new Set(
      decl(tile, "grid-template-areas")!
        .replace(/"/g, " ")
        .split(/\s+/)
        .filter((a) => a && a !== "."),
    );
    const placed = new Map<string, string>();
    for (const child of children) {
      const own = `.stat-row--kpi .bb-stat__${child}`;
      if (child === "head") {
        // The head is not a box: its two children join the tile grid themselves.
        expect(decl(rule(own, NARROW), "display")).toBe("contents");
        continue;
      }
      const area = decl(rule(own, NARROW), "grid-area");
      expect(area, `${own} needs a grid-area`).not.toBeNull();
      expect(areas.has(area!), `${own} → "${area}" must be a named area of the tile`).toBe(true);
      expect(placed.get(area!), `${own} shares "${area}"`).toBeUndefined();
      placed.set(area!, child);
    }
    // The stretched link is the other possible child: it is out of flow, so it takes no cell.
    const ds = stripComments(readFileSync(join(here, "..", "styles", "ds-components.css"), "utf8"));
    const link = parseRules(ds).find((r) => r.selector === ".bb-stretched-link" && r.at === "");
    expect(link && decl(link, "position")).toBe("absolute");
    // A delta row sits under the caption and, like it, adds no margin of its own here.
    expect(decl(rule(".stat-row--kpi .bb-stat__delta", NARROW), "margin-top")).toBe("0");
  });

  it("ORDER: the KPI figure rule comes after the shared `.stat-row .bb-stat__value` role", () => {
    // Both are two classes deep; only source order decides which font-size/margin wins.
    expect(ruleIndex(".stat-row--kpi .bb-stat__value", NARROW)).toBeGreaterThan(
      ruleIndex(".stat-row .bb-stat__value, .panel .bb-stat__value"),
    );
  });
});

describe("PR-D2 · /dashboard — quick actions, postings and needs-you on phones", () => {
  it("≤600px: quick actions are a 2-up grid; an odd last tile spans; ≤340px is one column", () => {
    expect(decl(rule(".quick__grid", NARROW), "grid-template-columns")).toBe(
      "repeat(2, minmax(0, 1fr))",
    );
    expect(decl(rule(".quick__card:last-child:nth-child(odd)", NARROW), "grid-column")).toBe(
      "1 / -1",
    );
    expect(decl(rule(".quick__grid", "max-width: 340px"), "grid-template-columns")).toBe(
      "minmax(0, 1fr)",
    );
    expect(decl(rule(".quick__card", NARROW), "min-height")).toBe("var(--tap)");
  });

  it("the phone description is VISUALLY hidden, never removed from the link's accessible name", () => {
    const desc = rule(".quick__desc", NARROW);
    expect(decl(desc, "display")).toBeNull();
    expect(decl(desc, "visibility")).toBeNull();
    expect(decl(desc, "clip-path")).toBe("inset(50%)");
    expect(decl(desc, "position")).toBe("absolute");
    // …and positioned against its own card, not a far ancestor.
    expect(decl(rule(".quick__card", NARROW), "position")).toBe("relative");
  });

  it("the quick-action chip is the brand tile: Safety Yellow glyph on Shift Blue", () => {
    const icon = rule(".quick__icon");
    expect(decl(icon, "background")).toBe("var(--surface-ink)");
    expect(decl(icon, "color")).toBe("var(--brand)");
  });

  it("≤560px: a posting row puts the status under the text and keeps the arrow on the right", () => {
    const row = rule(".dash-posting", "max-width: 560px");
    expect(decl(row, "display")).toBe("grid");
    expect(decl(row, "grid-template-columns")).toBe("minmax(0, 1fr) auto");
    expect(decl(rule(".dash-posting__right", "max-width: 560px"), "display")).toBe("contents");
    expect(decl(rule(".dash-posting__right > .bb-badge", "max-width: 560px"), "grid-area")).toBe(
      "status",
    );
    expect(decl(rule(".dash-posting__cta", "max-width: 560px"), "grid-area")).toBe("cta");
  });

  it("an UNLINKED Recent-unlocks row has nothing that makes it look like a link (no hover of its own)", () => {
    // The row is a DS Card laid out as text | status. Only a row that names a posting is a
    // link, and that one takes the DS whole-card link's lift (`.bb-card--link`); the row's own
    // rules add no hover, pointer or lift, so a row that opens nothing never looks clickable.
    const row = rule(".dash-unlock");
    expect(decl(row, "display")).toBe("flex");
    expect(decl(row, "flex-wrap")).toBe("wrap");
    expect(decl(rule(".dash-unlock__main"), "min-width")).toBe("0");
    // A date wraps whole: at 375px "2026-08-15" broke at its hyphens onto two lines.
    expect(decl(rule(".dash-unlock__meta .bb-mono"), "white-space")).toBe("nowrap");
    const own = RULES.filter((r) => r.selector.split(",").some((s) => /\.dash-unlock\b/.test(s)));
    expect(own.length).toBeGreaterThan(0);
    expect(own.filter((r) => /:hover|:focus/.test(r.selector)).map((r) => r.selector)).toEqual([]);
    for (const r of own) {
      expect(decl(r, "cursor"), r.selector).toBeNull();
      expect(decl(r, "transform"), r.selector).toBeNull();
      expect(decl(r, "box-shadow"), r.selector).toBeNull();
    }
    // The old zeroed wrapper around a MaskedCandidate is gone with the primitive it wrapped.
    expect(RULES.filter((r) => r.selector.includes(".dash-unlock-link"))).toEqual([]);
  });

  it("≤375px: a needs-you action wraps under its text (the ≤600px wrap is the precondition)", () => {
    expect(decl(rule(".attention__item", NARROW), "flex-wrap")).toBe("wrap");
    expect(decl(rule(".attention__text", SMALL), "flex-basis")).toBe(
      "calc(100% - var(--text-lg) - var(--space-3))",
    );
  });
});

/* ================================================================== *
 * /credits — ledgers scroll INSIDE their region; the hero out-ranks the shared roles.
 * ================================================================== */
describe("PR-D2 · /credits — ledgers and the wallet hero", () => {
  it("a no-wrap ledger keeps every cell on one line", () => {
    expect(decl(rule(".table--nowrap th, .table--nowrap td"), "white-space")).toBe("nowrap");
  });

  it("the table scrolls inside .tablewrap; the page column cannot be widened by it", () => {
    expect(decl(rule(".tablewrap"), "overflow")).toBe("auto");
    expect(decl(rule(".pshell__main"), "min-width")).toBe("0");
    expect(decl(rule(".panel"), "overflow")).toBe("hidden");
    // A focusable scroller needs a visible focus that survives sticky headers, hovered rows and
    // forced-colors: a real negative-offset outline, with the ring lifted onto the panel.
    const focus = rule(".tablewrap:focus-visible");
    expect(decl(focus, "outline")).toMatch(/solid var\(--focus-ring\)$/);
    expect(decl(focus, "outline-offset")).toBe("calc(-1 * var(--border-bold))");
    expect(decl(focus, "box-shadow")).toBeNull();
    expect(decl(rule(".panel:has(.tablewrap:focus-visible)"), "box-shadow")).toBe(
      "var(--ring-focus)",
    );
  });

  it("the hero's selectors out-rank `.stat-row .bb-stat__*` by specificity, not by order", () => {
    for (const part of ["__value", "__label", "__caption", "__icon"]) {
      expect(() => rule(`.bb-stat.credits-balance .bb-stat${part}`)).not.toThrow();
    }
    expect(decl(rule(".bb-stat.credits-balance"), "background")).toBe("var(--surface-ink)");
    expect(decl(rule(".bb-stat.credits-balance .bb-stat__value"), "color")).toBe(
      "var(--text-on-ink)",
    );
    // Text on Safety Yellow is ALWAYS Shift Blue.
    expect(decl(rule(".bb-stat.credits-balance .bb-stat__icon"), "color")).toBe(
      "var(--text-on-brand)",
    );
  });
});

/* ================================================================== *
 * ORDER — the ≤375px step beats the ≤480px step only by coming later.
 * ================================================================== */
describe("PR-D2 · ≤375px step is declared after the rules it refines", () => {
  it.each([
    [".login-card", PHONE],
    [".bb-stat.credits-balance", PHONE],
    [".credit-pack__price", PHONE],
  ])("%s (≤375px) comes after its %s rule", (selector, from) => {
    expect(ruleIndex(selector, SMALL)).toBeGreaterThan(ruleIndex(selector, from));
  });

  it("the login title step comes after the base title rule", () => {
    expect(ruleIndex(".login-card__title", SMALL)).toBeGreaterThan(ruleIndex(".login-card__title"));
  });
});
