import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decl, parseRules, stripComments, tokenValue } from "../../test/css-rules";
import type { Rule } from "../../test/css-rules";

/**
 * #2588 (W8) — remaining polish: the stylesheet half (node env, no layout engine, so the DECLARED
 * geometry and motion are fenced; the behaviour half lives beside each component).
 *
 * The block is ONE marked block at the end of globals.css. Where it re-states an earlier rule it
 * wins by ORDER at equal specificity — so this suite pins that order too: a reorder would silently
 * undo the fix with every other gate green.
 */

const here = dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(join(here, "globals.css"), "utf8");
const MARKER = "W8 (#2588) — REMAINING POLISH";
const CSS = stripComments(RAW);
const RULES: Rule[] = parseRules(CSS);
/** The rules of the W8 block alone (from its marker to the end of the file). */
const W8: Rule[] = parseRules(stripComments(RAW.slice(RAW.lastIndexOf("/*", RAW.indexOf(MARKER)))));
const PHONE = "@media (max-width: 600px)";
const BELOW_DESKTOP = "@media (max-width: 1023px)";
const TOKENS = stripComments(
  readFileSync(join(here, "..", "..", "..", "..", "packages", "design-tokens", "tokens.css"), "utf8"),
);

/** A token's px value (px, or rem at the 16px root). */
function px(name: string): number {
  const v = tokenValue(TOKENS, name);
  const m = /^(\d+(?:\.\d+)?)(px|rem)\b/.exec(v ?? "");
  expect(m, `${name} = ${v}`).not.toBeNull();
  return m![2] === "rem" ? Number(m![1]) * 16 : Number(m![1]);
}
/** The FIRST rule for exactly `selector` under `at` — the base a W8 rule of the same name re-states. */
function base(selector: string, at = ""): Rule {
  const found = RULES.find((r) => r.selector === selector && r.at === at);
  expect(found, `${at} ${selector}`).toBeDefined();
  return found!;
}
/** Where `r` sits in the file — a later rule wins over an earlier one at equal specificity. */
const order = (r: Rule) => RULES.findIndex((x) => x.selector === r.selector && x.at === r.at && x.body === r.body);

/** The ONE rule for exactly `selector` under `at` ("" = top level), in `rules`. */
function rule(selector: string, at = "", rules: Rule[] = RULES): Rule {
  const found = rules.filter((r) => r.selector === selector && r.at === at);
  expect(found, `${at} ${selector}`).toHaveLength(1);
  return found[0]!;
}

describe("the W8 block", () => {
  it("is one marked block (vacuity: it holds rules)", () => {
    expect(RAW.split(MARKER)).toHaveLength(2);
    expect(W8.length).toBeGreaterThanOrEqual(15);
  });
});

describe("the Candidates pager — the rows on screen, then the links", () => {
  it("the range takes the row's free space on the left; the links keep their right edge", () => {
    const range = rule(".candidates-pager__range", "", W8);
    expect(decl(range, "margin-inline-end")).toBe("auto");
    expect(decl(range, "font-variant-numeric")).toBe("tabular-nums");
    expect(decl(range, "color")).toBe("var(--text-secondary)");
    expect(decl(rule(".candidates-pager"), "justify-content")).toBe("flex-end");
  });

  it("on a phone it is a line of its own above the two equal thumb targets", () => {
    expect(decl(rule(".candidates-pager__range", PHONE, W8), "flex")).toBe("1 1 100%");
    expect(decl(rule(".candidates-pager > .bb-btn", PHONE), "flex")).toBe("1 1 0");
  });
});

describe("the list heading — the line it replaced, findable and focusable", () => {
  const h = () => rule(".paged-list-heading", "", W8);

  it("reads as the count/range line, not as a display heading (it inherits the line's type)", () => {
    for (const prop of ["font-family", "font-size", "line-height", "letter-spacing"]) {
      expect(decl(h(), prop), prop).toBe("inherit");
    }
  });

  it("hugs its text (a focus ring hugs it too) and lands below the sticky header", () => {
    expect(decl(h(), "justify-self")).toBe("start");
    expect(decl(h(), "scroll-margin-top")).toBe(decl(rule(".anchor-target"), "scroll-margin-top"));
  });
});

describe("/credits — the pack grid auto-fits on the shared tile floor (no 3 → 1 jump on a tablet)", () => {
  const grid = () => rule(".cred-pack-grid", "", W8);

  it("is the shared auto-fit track, never wider than its column", () => {
    expect(decl(grid(), "grid-template-columns")).toBe(
      "repeat(auto-fit, minmax(min(100%, var(--stat-min)), 1fr))",
    );
  });

  it("wins over the old three fixed tracks AND their ≤900px one-track rule — by coming later", () => {
    const fixed = base(".cred-pack-grid");
    expect(decl(fixed, "grid-template-columns")).toBe("repeat(3, minmax(0, 1fr))");
    const oneTrack = rule(".cred-pack-grid, .cred-grid", "@media (max-width: 900px)");
    expect(order(grid())).toBeGreaterThan(order(fixed));
    expect(order(grid())).toBeGreaterThan(order(oneTrack));
  });

  it("MEASURED: three packs across on a tablet, two on a large phone, one on a phone; none overflows at 320", () => {
    const floor = px("--stat-min");
    const gap = px("--space-4");
    expect(decl(base(".cred-pack-grid"), "gap")).toBe("var(--space-4)");
    // Below 1024px the shell is one column and the content's inline padding is --gutter.
    expect(decl(rule(".pshell__content", BELOW_DESKTOP), "padding")).toContain("var(--gutter)");
    const room = (vw: number) => vw - 2 * px("--gutter");
    const tracks = (vw: number) => {
      const min = Math.min(room(vw), floor);
      return Math.floor((room(vw) + gap) / (min + gap));
    };
    for (const vw of [768, 820, 900, 1000]) expect(tracks(vw), `${vw}px`).toBeGreaterThanOrEqual(3);
    expect(tracks(600)).toBe(2);
    for (const vw of [320, 360, 375, 414]) expect(tracks(vw), `${vw}px`).toBe(1);
    // `min(100%, …)`: the one track at 320 is the column, never the 216px floor past it.
    expect(Math.min(room(320), floor)).toBeLessThanOrEqual(room(320));
  });
});

describe("/plans — the quick packs and the posting plans take one track on a phone", () => {
  it("one zero-minimum track at ≤600px, after the base rules it overrides", () => {
    const phone = rule(".plans-quick, .plans-planlist", PHONE, W8);
    expect(decl(phone, "grid-template-columns")).toBe("minmax(0, 1fr)");
    expect(decl(rule(".plans-quick"), "grid-template-columns")).toBe("repeat(3, 1fr)");
    expect(decl(rule(".plans-planlist"), "grid-template-columns")).toBe("1fr 1fr");
    expect(order(phone)).toBeGreaterThan(order(rule(".plans-quick")));
    expect(order(phone)).toBeGreaterThan(order(rule(".plans-planlist")));
  });
});

describe("the table scroll box — only at ≥1024px (no scroll trap on a phone or tablet)", () => {
  it("below 1024px the box scrolls sideways only and grows to its table — no cap, no contained overscroll", () => {
    const small = rule(".tablewrap", BELOW_DESKTOP, W8);
    expect(decl(small, "overflow-x")).toBe("auto");
    expect(decl(small, "overflow-y")).toBe("hidden");
    expect(decl(small, "max-block-size")).toBe("none");
    expect(decl(small, "overscroll-behavior-y")).toBe("auto");
    expect(order(small)).toBeGreaterThan(order(rule(".tablewrap")));
  });

  it("at ≥1024px the base box keeps its cap and contained overscroll (the sticky header's scroller)", () => {
    const base = rule(".tablewrap");
    expect(decl(base, "overflow")).toBe("auto");
    expect(decl(base, "max-block-size")).toBe("calc(100dvh - 18rem)");
    expect(decl(base, "overscroll-behavior")).toBe("contain");
    // No other rule caps it at a narrower width.
    expect(
      RULES.filter((r) => r.selector === ".tablewrap" && decl(r, "max-block-size") !== null).map((r) => r.at),
    ).toEqual(["", BELOW_DESKTOP]);
  });
});

describe("the OTP code input — motion, success, one row", () => {
  const REDUCED = "@media (prefers-reduced-motion: reduce)";
  const keyframes = (name: string) => {
    const r = W8.find((x) => x.selector === `@keyframes ${name}`);
    expect(r, name).toBeDefined();
    return r!.body;
  };

  it("a digit pops as it lands: scale 1.04 over --duration-press (90ms), easing out — transform only", () => {
    expect(decl(rule(".otp-code .bb-otp__cell--filled", "", W8), "animation")).toBe(
      "otp-code-pop var(--duration-press) var(--ease-out)",
    );
    expect(decl(rule(".otp-code", "", W8), "--otp-pop-scale")).toBe("1.04");
    const pop = keyframes("otp-code-pop");
    expect(pop).toContain("transform: scale(var(--otp-pop-scale))");
    expect(pop).not.toMatch(/opacity|width|height|margin|top|left/);
  });

  it("the check fades IN over --duration-base easing out, and OUT faster easing in — opacity only", () => {
    const check = rule(".otp-code__check", "", W8);
    expect(decl(check, "opacity")).toBe("0");
    expect(decl(check, "transition")).toBe("opacity var(--duration-fast) var(--ease-exit)");
    const shown = rule(".otp-code--success .otp-code__check", "", W8);
    expect(decl(shown, "opacity")).toBe("1");
    expect(decl(shown, "transition")).toBe("opacity var(--duration-base) var(--ease-enter)");
    expect(decl(check, "color")).toBe("var(--success)");
  });

  it("nothing moves under reduced motion: the durations are tokens (0 there) and the pop's scale is 1", () => {
    expect(decl(rule(".otp-code", REDUCED, W8), "--otp-pop-scale")).toBe("1");
    const reducedRoot = parseRules(TOKENS).find(
      (r) => r.at === REDUCED && r.selector === ":root",
    )!;
    for (const t of ["--duration-press", "--duration-base", "--duration-fast"]) {
      expect(decl(reducedRoot, t), t).toBe("0ms");
    }
  });

  it("success stays readable: success border and tint, the digits at full contrast — never faded", () => {
    const ok = rule(".otp-code--success .bb-otp__cell", "", W8);
    expect(decl(ok, "border-color")).toBe("var(--success)");
    expect(decl(ok, "background")).toBe("var(--success-tint)");
    expect(decl(ok, "color")).toBe("var(--text-primary)");
    expect(W8.filter((r) => r.selector.includes("otp-code") && decl(r, "opacity") !== null).map((r) => r.selector)).toEqual([
      ".otp-code__check",
      ".otp-code--success .otp-code__check",
    ]);
  });

  it("the boxes are ONE row at every width: zero-minimum tracks capped at the DS box width", () => {
    const row = rule(".otp-code__boxes", "", W8);
    expect(decl(row, "display")).toBe("grid");
    expect(decl(row, "grid-auto-flow")).toBe("column");
    expect(decl(row, "grid-auto-columns")).toBe("minmax(0, var(--control-lg))");
    expect(decl(row, "width")).toBe("100%");
    expect(decl(row, "overflow")).toBe("visible");
    const box = rule(".otp-code__boxes > .bb-otp__cell", "", W8);
    expect(decl(box, "width")).toBe("100%");
    expect(decl(box, "min-width")).toBe("0");
    // MEASURED at 320: the phone column (320 − 2 × --gutter) holds six boxes and five gaps with
    // every box still a 36px target, so the row neither wraps nor overflows.
    const column = 320 - 2 * px("--gutter");
    const cell = Math.min(px("--control-lg"), (column - 5 * px("--space-2")) / 6);
    expect(6 * cell + 5 * px("--space-2")).toBeLessThanOrEqual(column);
    expect(cell).toBeGreaterThanOrEqual(36);
  });
});
