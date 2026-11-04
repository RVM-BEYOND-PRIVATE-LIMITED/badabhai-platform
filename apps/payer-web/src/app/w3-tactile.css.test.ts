import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decl, parseRules, stripComments } from "../../test/css-rules";
import type { Rule } from "../../test/css-rules";

/**
 * #2583 (W3) — tactile buttons, dialogs and toasts: the stylesheet half (node env, no layout
 * engine, so the DECLARED geometry and motion are fenced). The behaviour half is
 * src/components/ds/w3-tactile.test.tsx.
 *
 * Acceptance: no dialog overflows at 320 or 375 · nothing moves under reduced motion. (Toasts
 * announced once is the live-region test in the behaviour half.)
 */

const here = dirname(fileURLToPath(import.meta.url));
const DS = stripComments(readFileSync(join(here, "..", "styles", "ds-components.css"), "utf8"));
const GLOBALS = stripComments(readFileSync(join(here, "globals.css"), "utf8"));
const RULES: Rule[] = parseRules(DS);
const PHONE = "@media (max-width: 600px)";
const REDUCED = "@media (prefers-reduced-motion: reduce)";

/** The rule for exactly `selector` under `at` ("" = top level). */
function rule(selector: string, at = ""): Rule {
  const found = RULES.filter((r) => r.selector === selector && r.at === at);
  expect(found, `${at} ${selector}`).toHaveLength(1);
  return found[0]!;
}
const keyframes = (name: string): string => {
  const r = RULES.find((x) => x.selector === `@keyframes ${name}`);
  expect(r, name).toBeDefined();
  return r!.body;
};

describe("buttons — press edge, busy, disabled", () => {
  it("primary and secondary stand on the #2570 press edge, which collapses on :active", () => {
    expect(decl(rule(".bb-btn--primary"), "box-shadow")).toBe("var(--shadow-press-primary)");
    expect(decl(rule(".bb-btn--primary:active"), "box-shadow")).toBe(
      "var(--shadow-press-primary-pressed)",
    );
    expect(decl(rule(".bb-btn--secondary"), "box-shadow")).toBe("var(--shadow-press-secondary)");
    expect(decl(rule(".bb-btn--secondary:active"), "box-shadow")).toBe(
      "var(--shadow-press-secondary-pressed)",
    );
  });

  it("a press sinks --press-depth over --duration-press (tokens: 0 under reduced motion)", () => {
    const press = rule(".bb-btn:active");
    expect(decl(press, "transform")).toBe(
      "translateY(var(--press-depth)) scale(var(--press-scale))",
    );
    expect(decl(press, "transition-duration")).toBe("var(--duration-press)");
    // No variant keeps a literal press scale of its own.
    expect(
      RULES.filter((r) => /scale\(0\.\d+\)/.test(r.body) && r.selector.includes("bb-btn")),
    ).toEqual([]);
  });

  it("disabled is the 40% step; busy stays at full opacity and shows progress", () => {
    expect(decl(rule('.bb-btn:disabled, .bb-btn[aria-disabled="true"]'), "opacity")).toBe("0.4");
    const busy = rule('.bb-btn[aria-busy="true"]');
    expect(decl(busy, "opacity")).toBe("1");
    expect(decl(busy, "cursor")).toBe("progress");
    // The label fades but keeps its box (width fixed); the spinner sits over it.
    expect(decl(rule('.bb-btn[aria-busy="true"] .bb-btn__label'), "opacity")).toBe("0");
    expect(decl(rule(".bb-btn__spinner"), "position")).toBe("absolute");
  });
});

describe("one spinner — it turns, and under reduced motion it only pulses", () => {
  it("the dead `.spinner` is gone; `.bb-spinner` is the one spinner", () => {
    expect(GLOBALS).not.toMatch(/(^|[\s,}])\.spinner\b/);
    expect(GLOBALS).not.toContain("spinner-rotate");
    expect(decl(rule(".bb-spinner"), "animation")).toBe(
      "bb-spin var(--duration-slower) linear infinite",
    );
  });

  it("reduced motion swaps the turn for an opacity-only pulse", () => {
    const r = rule(".bb-spinner, .bb-btn__spinner", REDUCED);
    expect(decl(r, "animation")).toMatch(/^bb-spin-pulse /);
    expect(keyframes("bb-spin-pulse")).not.toContain("transform");
    expect(keyframes("bb-spin-pulse")).toContain("opacity");
  });
});

describe("dialogs — never overflow a 320 / 375 phone; a sheet on phones", () => {
  it("the box can shrink and wraps long words; it never outgrows 90dvh", () => {
    const box = rule(".bb-dialog");
    expect(decl(box, "width")).toBe("100%");
    expect(decl(box, "min-width")).toBe("0");
    expect(decl(box, "overflow-wrap")).toBe("anywhere");
    expect(decl(box, "max-height")).toBe("90dvh");
    expect(decl(box, "overflow")).toBe("auto");
  });

  it("≤ 600px: a full-width bottom sheet, 90dvh max, sliding over --duration-sheet", () => {
    const scrim = rule(".bb-scrim", PHONE);
    expect(decl(scrim, "align-items")).toBe("flex-end");
    expect(decl(scrim, "padding")).toBe("0");
    const sheet = rule(".bb-dialog", PHONE);
    expect(decl(sheet, "max-width")).toBe("none");
    expect(decl(sheet, "max-height")).toBe("90dvh");
    expect(decl(sheet, "animation")).toBe("bb-sheet-in var(--duration-sheet) var(--ease-enter)");
  });

  it("≤ 600px: actions stack full width (primary on top) and a long label wraps", () => {
    const foot = rule(".bb-dialog__foot", PHONE);
    expect(decl(foot, "flex-direction")).toBe("column-reverse");
    const btn = rule(".bb-dialog__foot .bb-btn", PHONE);
    expect(decl(btn, "width")).toBe("100%");
    expect(decl(btn, "white-space")).toBe("normal");
    expect(decl(btn, "height")).toBe("auto");
  });

  it("enters with rise + scale over --duration-base and leaves shorter, taking no input", () => {
    expect(decl(rule(".bb-dialog"), "animation")).toBe(
      "bb-dialog-in var(--duration-base) var(--ease-enter)",
    );
    expect(keyframes("bb-dialog-in")).toContain(
      "translateY(var(--motion-rise)) scale(var(--motion-enter-scale))",
    );
    const closing = rule('.bb-scrim[data-state="closing"]');
    expect(decl(closing, "pointer-events")).toBe("none");
    expect(decl(rule('.bb-scrim[data-state="closing"] .bb-dialog'), "animation")).toBe(
      "bb-dialog-out var(--duration-fast) var(--ease-exit) forwards",
    );
  });
});

describe("toasts — one stack; rise in, leave, nothing moves under reduced motion", () => {
  it("the stack is fixed above modals and spans the gutter on phones", () => {
    const vp = rule(".bb-toast-viewport");
    expect(decl(vp, "position")).toBe("fixed");
    expect(decl(vp, "z-index")).toBe("var(--z-toast)");
    expect(decl(rule(".bb-toast-viewport", PHONE), "left")).toBe("var(--space-4)");
  });

  it("rises --motion-rise over --duration-base and leaves over --duration-fast", () => {
    expect(decl(rule(".bb-toast"), "animation")).toBe(
      "bb-toast-in var(--duration-base) var(--ease-enter)",
    );
    expect(decl(rule(".bb-toast--leaving"), "animation")).toBe(
      "bb-toast-out var(--duration-fast) var(--ease-exit) forwards",
    );
    expect(keyframes("bb-toast-in")).toContain("translateY(var(--motion-rise))");
  });
});

describe("tabs — one sliding indicator", () => {
  it("glides on transform only over --duration-slow with --ease-glide", () => {
    const bar = rule(".bb-tabs[data-indicator] .bb-tabs__indicator");
    expect(decl(bar, "transition")).toBe("transform var(--duration-slow) var(--ease-glide)");
    expect(decl(bar, "transform")).toBe("translate(var(--bb-tabs-x), var(--bb-tabs-y))");
  });

  it("the active tab's static marker hands over only once the indicator is placed", () => {
    expect(decl(rule(".bb-tabs__indicator"), "display")).toBe("none");
    expect(
      decl(rule(".bb-tabs--underline[data-indicator] .bb-tab--active"), "border-bottom-color"),
    ).toBe("transparent");
    expect(decl(rule(".bb-tabs--segmented[data-indicator] .bb-tab--active"), "background")).toBe(
      "transparent",
    );
  });
});

describe("reduced motion — every new motion rides tokens that collapse to zero", () => {
  const NEW_KEYFRAMES = [
    "bb-dialog-in",
    "bb-dialog-out",
    "bb-toast-in",
    "bb-toast-out",
    "bb-sheet-in",
    "bb-sheet-out",
  ];

  it("each keyframe moves only by a token distance or a sheet's own height (duration → 0)", () => {
    for (const name of NEW_KEYFRAMES) {
      const body = keyframes(name);
      for (const m of body.matchAll(/translateY\(([^)]*\)?)\)/g)) {
        expect(["var(--motion-rise)", "100%"], name).toContain(m[1]);
      }
    }
  });

  it("every animation/transition that uses them names a --duration-* token", () => {
    const uses = RULES.filter((r) =>
      NEW_KEYFRAMES.some((k) => (decl(r, "animation") ?? "").startsWith(`${k} `)),
    );
    expect(uses.length).toBeGreaterThanOrEqual(NEW_KEYFRAMES.length);
    for (const r of uses) expect(decl(r, "animation"), r.selector).toMatch(/var\(--duration-/);
  });
});
