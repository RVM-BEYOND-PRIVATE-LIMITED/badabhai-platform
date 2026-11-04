import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decl, parseRules, stripComments, tokenValue } from "../../test/css-rules";
import type { Rule } from "../../test/css-rules";
import { ENTERING_ATTR, ENTRANCE_ANIMATIONS } from "./(portal)/route-content";
import {
  GLIDING_ATTR,
  ON_PLATE_ATTR,
  RAIL_ENTRANCE_ANIMATIONS,
  RAIL_MARKER_ATTR,
} from "./(portal)/rail-marker";

/**
 * #2586 (W6) — page transitions and list motion: the stylesheet half (node env, no layout engine,
 * so the DECLARED motion is fenced). The behaviour half is (portal)/route-content.test.tsx (the
 * path-keyed column, first-render-only lists) and (portal)/sidebar-nav.test.tsx (the marker moves
 * on the press).
 *
 * Acceptance: router-stall measurement unchanged (no boundary — app/no-suspense-above-a-page.test.ts
 * still scans every source) · nothing moves under reduced motion. The motion itself:
 *  - route change: the content fades in with a 6px rise over 200ms, no exit animation;
 *  - lists: the first 8 items rise in 30ms apart, on first render only;
 *  - the rail marker glides 320ms; the drawer scrim fades both ways in 220ms, no backdrop blur;
 *  - row arrows nudge 4px only on hover or focus (they looped forever).
 */

const here = dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(join(here, "globals.css"), "utf8");
const GLOBALS = stripComments(RAW);
const DS = stripComments(readFileSync(join(here, "..", "styles", "ds-components.css"), "utf8"));
const TOKENS = stripComments(
  readFileSync(
    join(here, "..", "..", "..", "..", "packages", "design-tokens", "tokens.css"),
    "utf8",
  ),
);
const G: Rule[] = parseRules(GLOBALS);
const ALL: Rule[] = [...parseRules(DS), ...G];
const TOKEN_RULES: Rule[] = parseRules(TOKENS);

const OPEN = "/* ===== W6 #2586 — page transitions + list motion ===== */";
const CLOSE = "/* ===== end W6 #2586 ===== */";
/** The rules of the W6 block alone, in source order. */
const W6: Rule[] = parseRules(stripComments(RAW.slice(RAW.indexOf(OPEN), RAW.indexOf(CLOSE))));

const REDUCED = "@media (prefers-reduced-motion: reduce)";
const HOVER = "@media (hover: hover)";
const DRAWER = "@media (max-width: 1023px)";
const LISTS =
  ":is(.attention__list, .dash-postings, .dash-candlist, .postings-list, .agency-jobs__list, .applicants-list)";
const ENTERING = `.pshell__content[${ENTERING_ATTR}]`;
const COLUMN = ".pshell__main > .pshell__content";

/** The rule for exactly `selector` under `at` in `rules` — there must be one. */
function rule(selector: string, at = "", rules: Rule[] = W6): Rule {
  const found = rules.filter((r) => r.selector === selector && r.at === at);
  expect(found, `${at || "top"} ${selector}`).toHaveLength(1);
  return found[0]!;
}
const keyframes = (name: string): string => {
  const found = G.filter((r) => r.selector === `@keyframes ${name}`);
  expect(found, name).toHaveLength(1);
  return found[0]!.body.replace(/\s+/g, "");
};
/** The properties a keyframes block sets. */
const keyframeProps = (name: string) =>
  [...keyframes(name).matchAll(/([a-z-]+):/g)]
    .map((m) => m[1]!)
    .filter((p, i, a) => a.indexOf(p) === i);
const ms = (token: string) => Number.parseFloat(tokenValue(TOKENS, token)!);

/** A colour value (`var(--token)` chains through payer-web's and the shared tokens) as #rrggbb. */
function hexOf(value: string, depth = 0): string {
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  const m = /^var\((--[\w-]+)\)$/.exec(v);
  expect(m, `not a hex or a var(): ${v}`).not.toBeNull();
  expect(depth, v).toBeLessThan(6);
  const next = tokenValue(GLOBALS, m![1]!) ?? tokenValue(TOKENS, m![1]!);
  expect(next, m![1]).not.toBeNull();
  return hexOf(next!, depth + 1);
}
/** WCAG 2 contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}
const selectors = (r: Rule) => r.selector.split(/,(?![^(]*\))/).map((s) => s.trim());

/** The last compound of a selector (what it styles), with every (…) folded so nothing inside splits it. */
function subject(selector: string): string {
  let flat = selector;
  while (/\([^()]*\)/.test(flat)) flat = flat.replace(/\([^()]*\)/g, "{}");
  return flat
    .trim()
    .split(/\s*[\s>+~]\s*/)
    .pop()!;
}

describe("W6 · one marked block", () => {
  it("the block is there once, holds the W6 rules, and its keyframes are defined once in the file", () => {
    expect(RAW.split(OPEN)).toHaveLength(2);
    expect(RAW.split(CLOSE)).toHaveLength(2);
    expect(RAW.indexOf(CLOSE)).toBeGreaterThan(RAW.indexOf(OPEN));
    expect(W6.length).toBeGreaterThanOrEqual(15);
    for (const name of ["page-enter", "list-enter"]) {
      expect(
        W6.some((r) => r.selector === `@keyframes ${name}`),
        name,
      ).toBe(true);
    }
  });

  it("the keyframes the column waits for are exactly the two entrances this block runs", () => {
    expect([...ENTRANCE_ANIMATIONS].sort()).toEqual(["list-enter", "page-enter"]);
  });
});

describe("W6 · 1 — a route change fades the content in with a 6px rise over 200ms", () => {
  it("the path-keyed column runs page-enter on --duration-page, easing in", () => {
    expect(ms("--duration-page")).toBe(200);
    expect(tokenValue(TOKENS, "--motion-rise")).toMatch(/^6px\b/);
    expect(decl(rule(COLUMN), "animation")).toBe(
      "page-enter var(--duration-page) var(--ease-enter)",
    );
  });

  it("page-enter starts transparent and --motion-rise low — opacity and transform only, once", () => {
    expect(keyframes("page-enter")).toBe(
      "from{opacity:0;transform:translateY(var(--motion-rise));}",
    );
    expect(keyframeProps("page-enter")).toEqual(["opacity", "transform"]);
    expect(decl(rule(COLUMN), "animation")).not.toMatch(/infinite|\d+\s*$/);
  });

  it("no exit animation: nothing else animates the column (the old 4px portal-fade is gone)", () => {
    expect(GLOBALS).not.toContain("portal-fade");
    const onColumn = ALL.filter((r) =>
      selectors(r).some((s) => subject(s) === ".pshell__content" && !s.includes("[")),
    ).filter((r) => decl(r, "animation") !== null);
    for (const r of onColumn) {
      expect(decl(r, "animation"), `${r.at} ${r.selector}`).toMatch(
        /^(page-enter var\(--duration-page\) var\(--ease-enter\)|none( !important)?)$/,
      );
    }
  });
});

describe("W6 · 5 — lists: the first 8 items rise in 30ms apart, on first render only", () => {
  /** The rule every list item runs (looked up per test, so a missing one fails as a test). */
  const items = () => rule(`${ENTERING} ${LISTS} > *`);

  it("each item rises over --duration-page, held at its start only while it waits (backwards), once", () => {
    expect(decl(items(), "animation")).toBe(
      "list-enter var(--duration-page) var(--ease-enter) backwards",
    );
    expect(keyframes("list-enter")).toBe(
      "from{opacity:0;transform:translateY(var(--motion-rise));}",
    );
    expect(keyframeProps("list-enter")).toEqual(["opacity", "transform"]);
  });

  it("every rule that runs or times it is keyed on the entering column — never on a later render", () => {
    // Anywhere in the file: the one rule that runs it…
    const runs = G.filter((r) => (decl(r, "animation") ?? "").startsWith("list-enter"));
    expect(runs).toHaveLength(1);
    // …and the block's steps (the rail groups' own entrance staggers outside it, on its own rules).
    const steps = W6.filter((r) => (decl(r, "animation-delay") ?? "").includes("--stagger-"));
    expect(steps).toHaveLength(7);
    for (const r of [...runs, ...steps]) {
      for (const s of selectors(r)) expect(s.startsWith(`${ENTERING} `), s).toBe(true);
    }
  });

  /** The stagger step (in units of --stagger-step) the CSS gives the i-th item of a list. */
  function stepOf(i: number): number {
    const nth = W6.filter(
      (r) => r.at === "" && r.selector.startsWith(`${ENTERING} ${LISTS} > :nth-child(`),
    );
    const matches = nth.filter((r) => {
      const arg = /:nth-child\(([^)]*)\)$/.exec(r.selector)![1]!.replace(/\s+/g, "");
      if (/^\d+$/.test(arg)) return Number(arg) === i;
      const from = /^n\+(\d+)$/.exec(arg);
      expect(from, `unexpected :nth-child(${arg})`).not.toBeNull();
      return i >= Number(from![1]);
    });
    expect(matches.length, `item ${i}`).toBeLessThanOrEqual(1);
    const delay = matches[0] ? decl(matches[0], "animation-delay")! : "0s";
    if (delay === "0s") return 0;
    if (delay === "var(--stagger-step)") return 1;
    const k = /^calc\(var\(--stagger-step\) \* (\d+)\)$/.exec(delay);
    if (k) return Number(k[1]);
    expect(delay).toBe("calc(var(--stagger-step) * (var(--stagger-max) - 1))");
    return Number(tokenValue(TOKENS, "--stagger-max")) - 1;
  }

  it("the delays climb one --stagger-step (30ms) per item and stop at the 8th — the rest enter with it", () => {
    expect(ms("--stagger-step")).toBe(30);
    expect(Number(tokenValue(TOKENS, "--stagger-max"))).toBe(8);
    const steps = Array.from({ length: 20 }, (_, i) => stepOf(i + 1));
    expect(steps).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7]);
    // So the last item starts 210ms in and the whole list is in by 410ms.
    expect(Math.max(...steps) * ms("--stagger-step") + ms("--duration-page")).toBe(410);
  });

  it("every list it staggers is a real list container in the portal's markup", () => {
    const src = join(here, "..");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      );
    const markup = walk(src)
      .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    for (const cls of LISTS.slice(4, -1)
      .split(", ")
      .map((c) => c.slice(1))) {
      expect(markup, cls).toContain(`className="${cls}"`);
    }
  });
});

describe("W6 · 2 — the rail marker glides 320ms, and only once it is placed", () => {
  /** The placed marker's rule (looked up per test, so a missing one fails as a test). */
  const marker = () => rule(`.pnav[${RAIL_MARKER_ATTR}] .pnav__marker`);

  it("glides on transform only, over --duration-slow with --ease-glide", () => {
    expect(ms("--duration-slow")).toBe(320);
    expect(decl(marker(), "transition")).toBe("transform var(--duration-slow) var(--ease-glide)");
    expect(decl(marker(), "transform")).toBe(
      "translate(var(--pnav-marker-x), var(--pnav-marker-y))",
    );
    expect(decl(marker(), "pointer-events")).toBe("none");
  });

  it("is not drawn until a script places it — the static plate paints first load in place (W2)", () => {
    expect(decl(rule(".pnav__marker"), "display")).toBe("none");
    expect(decl(marker(), "display")).toBe("block");
    // It is the static plate's twin: the same fill and corner as the active row it covers.
    const plate = rule(".pnav__link--active, .pnav__link--active:hover", "", G);
    expect(decl(marker(), "background")).toBe(decl(plate, "background"));
    expect(decl(marker(), "border-radius")).toBe(decl(rule(".pnav__link", "", G), "border-radius"));
    expect(decl(rule(".pnav"), "position")).toBe("relative");
  });

  it("sits BEHIND every row, whatever positions it: the nav isolates, and the marker is one step below the base", () => {
    // Without this, rows painted over the marker only by accident: through the zero-specificity
    // `:where(a:has(> .nav-pending))` anchor, or the transform left by the groups' entrance. Under
    // reduced motion (no entrance) in a browser without :has(), the plate covered the row's label.
    expect(decl(rule(".pnav"), "isolation")).toBe("isolate");
    expect(decl(marker(), "position")).toBe("absolute");
    expect(decl(marker(), "z-index")).toBe("calc(var(--z-base) - 1)");
    expect(tokenValue(TOKENS, "--z-base")).toBe("0");
  });

  it("its first placement waits out the rail groups' own entrance: the keyframes rail-marker.ts names are the ones the groups run", () => {
    expect([...RAIL_ENTRANCE_ANIMATIONS]).toEqual(["mw-nav-in"]);
    expect(decl(rule(".pshell .pnav__group", "", G), "animation")).toMatch(/^mw-nav-in\s/);
    expect(keyframeProps("mw-nav-in")).toEqual(["opacity", "transform"]);
  });

  it("once placed, the active row hands its plate over — and only then", () => {
    expect(decl(rule(`.pnav[${RAIL_MARKER_ATTR}] .pnav__link--active`), "background")).toBe(
      "transparent",
    );
    const handOvers = G.filter(
      (r) => r.selector.includes(".pnav__link--active") && decl(r, "background") === "transparent",
    );
    expect(handOvers.map((r) => r.selector)).toEqual([
      `.pnav[${RAIL_MARKER_ATTR}] .pnav__link--active`,
    ]);
  });

  /*
   * THE INK FOLLOWS THE PLATE (review of W6). The class moves on the press, but the plate takes
   * its 320ms, landing on a long ease-out tail. A label inked on the press was navy on the navy
   * rail until the plate got there (~100–115ms on a long hop, modelled with these tokens), and
   * the row left behind was navy on the rail as soon as the plate slid off it. rail-marker.ts sets
   * `[data-on-plate]` on the rows the plate covers, frame by frame (sidebar-nav.test.tsx).
   */
  const M = `.pnav[${RAIL_MARKER_ATTR}]`;
  const ON = `[${ON_PLATE_ATTR}]`;
  /** A row on the plate: the active one, or any other the pointer is not on (hover covers the plate). */
  const ROW_ON = `${M} .pnav__link${ON}:not(:hover:not(.pnav__link--active))`;
  const onPlate = () => rule(`${ROW_ON}, ${ROW_ON} .pnav__icon`);
  const onItsWay = () =>
    rule(`${M} .pnav__link--active:not(${ON}), ${M} .pnav__link--active:not(${ON}) .pnav__icon`);

  it("once placed, a row wears the active navy while the plate is under it; the pressed row keeps the rail's on-ink text until then", () => {
    // The static active row's own ink (W2), so a row on the gliding plate reads as it does on its own.
    const plate = rule(".pnav__link--active, .pnav__link--active:hover", "", G);
    const plateIcon = rule(
      ".pnav__link--active .pnav__icon, .pnav__link--active:hover .pnav__icon",
      "",
      G,
    );
    expect(decl(onPlate(), "color")).toBe(decl(plate, "color"));
    expect(decl(onPlate(), "color")).toBe(decl(plateIcon, "color"));
    expect(decl(onItsWay(), "color")).toBe("var(--text-on-ink)");
    // The Soon badge on a parked row goes with its row: the static active badge on the plate…
    const plateSoon = rule(".pnav__link--active .pnav__soon", "", G);
    const soonOn = rule(`${ROW_ON} .pnav__soon`);
    expect(decl(soonOn, "color")).toBe(decl(plateSoon, "color"));
    expect(decl(soonOn, "border-color")).toBe(decl(plateSoon, "border-color"));
    // …and the rail's own badge before the plate gets there.
    const soonOff = rule(`${M} .pnav__link--active:not(${ON}) .pnav__soon`);
    const railSoon = rule(".pnav__soon", "", G);
    expect(decl(soonOff, "color")).toBe(decl(railSoon, "color"));
    expect(decl(railSoon, "border")).toContain("var(--border-on-ink)");
    expect(decl(soonOff, "border-color")).toBe("var(--border-on-ink)");
    // An inactive row under the pointer keeps its hover ink: its hover background is opaque and
    // hides the plate, so navy there would be navy on the rail's hover fill.
    const hover = rule(".pshell .pnav__link:not(.pnav__link--active):hover", "", G);
    expect(decl(hover, "background")).toBe("var(--surface-ink-hover)");
    expect(decl(hover, "color")).toBe("var(--text-on-ink)");
    expect(contrast(hexOf("var(--navy-900)"), hexOf("var(--surface-ink-hover)"))).toBeLessThan(1.5);
    // Only these rules ink a row by the plate, and only once it is placed.
    const byPlate = G.filter((r) => r.selector.includes(ON_PLATE_ATTR));
    expect(byPlate).toHaveLength(4);
    for (const r of byPlate) {
      for (const s of selectors(r)) expect(s.startsWith(`${M} `), s).toBe(true);
    }
  });

  it("each ink reads on what is under it: navy on the plate and the on-ink text on the rail clear 4.5:1 — the pairs a press used to show did not", () => {
    // The rail is Shift Blue in both themes: the ink theme names none of these differently.
    const ink = TOKEN_RULES.filter((r) => r.selector === '[data-theme="ink"]');
    expect(ink.length).toBeGreaterThan(0);
    for (const t of ["--navy-900", "--vermilion-500", "--paper-1", "--text-on-ink"]) {
      for (const r of ink) expect(decl(r, t), t).toBeNull();
    }
    for (const r of ink)
      expect(decl(r, "--surface-ink") ?? "var(--navy-900)").toBe("var(--navy-900)");
    const navy = hexOf(decl(onPlate(), "color")!);
    const onInk = hexOf(decl(onItsWay(), "color")!);
    const yellow = hexOf(decl(rule(`${M} .pnav__marker`), "background")!);
    const rail = hexOf(decl(rule(".pshell__rail", "", G), "background")!);
    expect(contrast(navy, yellow)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(onInk, rail)).toBeGreaterThanOrEqual(4.5);
    // The two a press used to show while the plate travelled: navy on the rail, light on the plate.
    expect(contrast(navy, rail)).toBeLessThan(1.1);
    expect(contrast(hexOf("var(--text-on-ink-muted)"), yellow)).toBeLessThan(1.1);
  });

  it("while the plate travels, the ink changes at once: the gliding rule only takes colour out of the rows' fades, with no motion of its own", () => {
    const gliding = rule(`.pnav[${GLIDING_ATTR}] :is(.pnav__link, .pnav__icon, .pnav__label)`);
    expect(decl(gliding, "transition-property")).toBe("background, transform");
    for (const p of [
      "transition",
      "transition-duration",
      "transition-delay",
      "transition-timing-function",
      "animation",
    ]) {
      expect(decl(gliding, p), p).toBeNull();
    }
    // What it narrows: the rows' own fades (sidebar polish), the colour among them, by position.
    const flat = (r: Rule) => decl(r, "transition")!.replace(/\s+/g, " ");
    expect(flat(rule(".pshell .pnav__link", "", G))).toBe(
      "background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out)",
    );
    expect(flat(rule(".pshell .pnav__icon, .pshell .pnav__label", "", G))).toBe(
      "color var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out)",
    );
  });
});

describe("W6 · 3 — the drawer scrim fades both ways in 220ms, with no backdrop blur", () => {
  const scrimRules = ALL.filter((r) =>
    selectors(r).some((s) => subject(s).includes(".pshell__scrim")),
  );

  it("no rule blurs (or filters) behind the scrim", () => {
    expect(scrimRules.length).toBeGreaterThan(0);
    for (const r of scrimRules) {
      for (const p of ["backdrop-filter", "-webkit-backdrop-filter", "filter"]) {
        expect(decl(r, p), `${r.at} ${r.selector}: ${p}`).toBeNull();
      }
    }
  });

  it("fades in over --duration-base easing in, and out over the same easing out — no keyframes", () => {
    expect(ms("--duration-base")).toBe(220);
    const closed = rule(".pshell__scrim", DRAWER);
    const open = rule(".pshell--drawer-open .pshell__scrim", DRAWER);
    expect(decl(closed, "opacity")).toBe("0");
    expect(decl(closed, "transition")).toBe("opacity var(--duration-base) var(--ease-exit)");
    expect(decl(open, "opacity")).toBe("1");
    expect(decl(open, "transition")).toBe("opacity var(--duration-base) var(--ease-enter)");
    for (const r of scrimRules) {
      const animation = decl(r, "animation");
      if (animation !== null) expect(animation, `${r.at} ${r.selector}`).toMatch(/^none/);
    }
  });

  it("closed, it stays laid out to fade out of, but never takes a click (input is never held)", () => {
    const closed = rule(".pshell__scrim", DRAWER);
    expect(decl(closed, "display")).toBe("block");
    expect(decl(closed, "position")).toBe("fixed");
    expect(decl(closed, "pointer-events")).toBe("none");
    expect(decl(rule(".pshell--drawer-open .pshell__scrim", DRAWER), "pointer-events")).toBe(
      "auto",
    );
  });

  it("from 1024px it is not drawn at all — the shell's 'is the rail a drawer' reading", () => {
    expect(decl(rule(".pshell__scrim", "", G), "display")).toBe("none");
    expect(scrimRules.filter((r) => decl(r, "display") === "block").map((r) => r.at)).toEqual(
      expect.arrayContaining([DRAWER]),
    );
    for (const r of scrimRules) {
      if (decl(r, "display") === "block") expect(r.at, r.selector).toBe(DRAWER);
    }
  });
});

describe("W6 · 4 — row arrows nudge 4px only on hover or focus; nothing loops", () => {
  it("no animation in payer-web loops forever except the progress indicators", () => {
    const looping = ALL.filter((r) =>
      ["animation", "animation-iteration-count"].some((p) => /\binfinite\b/.test(decl(r, p) ?? "")),
    ).flatMap(selectors);
    expect([...new Set(looping)].sort()).toEqual(
      [".bb-btn__spinner", ".bb-spinner", ".nav-pending--on"].sort(),
    );
    expect(GLOBALS).not.toContain("arrow-nudge");
  });

  it("the arrow has no animation at all — only a transition, on --duration-fast", () => {
    const arrow = ALL.filter((r) =>
      selectors(r).some((s) => subject(s).includes(".dash-view__arrow")),
    );
    expect(arrow.length).toBeGreaterThan(0);
    for (const r of arrow) {
      expect(decl(r, "animation") ?? "none", `${r.at} ${r.selector}`).toBe("none");
      expect(decl(r, "will-change"), r.selector).toBeNull();
    }
    expect(decl(rule(".bb-card--link .dash-view__arrow"), "transition")).toContain(
      "transform var(--duration-fast) var(--ease-out)",
    );
  });

  it("it moves only while its card is hovered (on a device that hovers) or keyboard-focused — 4px", () => {
    expect(decl(rule(".bb-card--link:hover .dash-view__arrow", HOVER), "transform")).toBe(
      "translateX(4px)",
    );
    expect(
      decl(
        rule(".bb-card--link:has(> .bb-stretched-link:focus-visible) .dash-view__arrow"),
        "transform",
      ),
    ).toBe("translateX(4px)");
    const moves = ALL.filter(
      (r) =>
        !r.at.includes("prefers-reduced-motion") &&
        selectors(r).some((s) => subject(s).includes(".dash-view__arrow")) &&
        (decl(r, "transform") ?? "none") !== "none",
    );
    for (const r of moves) {
      for (const s of selectors(r)) expect(s, r.at).toMatch(/:hover|:focus-visible/);
      if (r.selector.includes(":hover")) expect(r.at).toBe(HOVER);
    }
  });
});

describe("W6 · reduced motion — nothing moves", () => {
  const reducedRules = W6.filter((r) => r.at === REDUCED);
  /** Is `selector` switched to `value` for `prop` by a reduced-motion rule AFTER rule index `after`? */
  const zeroedAfter = (selector: string, prop: string, value: string, after: number) =>
    W6.some(
      (r, i) =>
        i > after && r.at === REDUCED && decl(r, prop) === value && selectors(r).includes(selector),
    );

  it("every W6 animation, transition and travel has its own reduced-motion off switch, after it", () => {
    expect(reducedRules.length).toBeGreaterThan(0);
    let checked = 0;
    W6.forEach((r, i) => {
      if (r.at === REDUCED || r.selector.startsWith("@keyframes")) return;
      const switches: Array<[string, string]> = [];
      if ((decl(r, "animation") ?? "none") !== "none") switches.push(["animation", "none"]);
      if ((decl(r, "transition") ?? "none") !== "none") switches.push(["transition", "none"]);
      if (
        !/^(none|translate\(var\(--pnav-marker-x\), var\(--pnav-marker-y\)\))$/.test(
          decl(r, "transform") ?? "none",
        )
      ) {
        switches.push(["transform", "none"]);
      }
      for (const [prop, value] of switches) {
        for (const s of selectors(r)) {
          checked += 1;
          expect(zeroedAfter(s, prop, value, i), `${r.at || "top"} ${s}: ${prop}`).toBe(true);
        }
      }
    });
    // The column, the list items, the marker, both scrim states, the arrow and its two nudges.
    expect(checked).toBe(8);
  });

  it("and the tokens it names collapse to zero there (durations, the rise, the stagger)", () => {
    const reduced = TOKEN_RULES.find((r) => r.at === REDUCED && r.selector === ":root")!;
    for (const token of [
      "--duration-page",
      "--duration-base",
      "--duration-slow",
      "--duration-fast",
      "--stagger-step",
    ]) {
      expect(decl(reduced, token), token).toBe("0ms");
    }
    expect(decl(reduced, "--motion-rise")).toBe("0px");
  });

  it("the marker's placement transform is not motion: with its transition off it lands at once", () => {
    // `translate(--pnav-marker-x, --pnav-marker-y)` is WHERE the plate sits, not travel; under
    // reduced motion its transition is off, so a press moves it to the new row in one frame.
    expect(zeroedAfter(`.pnav[${RAIL_MARKER_ATTR}] .pnav__marker`, "transition", "none", -1)).toBe(
      true,
    );
  });
});
