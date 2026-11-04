import { describe, expect, it } from "vitest";
import { decl, globalsCss, resolveToken, rules, tokensCss } from "../../test/css-rules";

/**
 * A5 (#2575) — the overlays' motion and geometry as declared in globals.css.
 *
 *  - Dialog, Drawer and Toast enter over --duration-base on --ease-enter and leave over
 *    --duration-fast on --ease-exit (the token `usePresence` waits for);
 *  - their keyframes animate only opacity and transform, and travel at most 6px;
 *  - the tokens are 0 under prefers-reduced-motion, and the Undo bar (its duration set inline)
 *    stops too;
 *  - the drawer is min(960px, 62vw); the primary button sits on the #2570 press edge.
 * (That every duration here is a token is the global fence, motion-duration-tokens.css.test.ts.)
 */
const CSS = globalsCss();
const TOKENS = tokensCss();

/** Every top-level block for `selector`, in source order, joined — so the last declaration wins. */
function body(selector: string): string {
  const blocks = rules(CSS).filter((r) => r.selector === selector);
  expect(blocks.length, `${selector} must be declared`).toBeGreaterThan(0);
  return blocks.map((r) => r.body).join(";");
}

/** The declaration blocks of `@keyframes name` (its from / to steps). */
function keyframeSteps(name: string): string[] {
  const at = CSS.indexOf(`@keyframes ${name} {`);
  expect(at, `@keyframes ${name} must exist`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  let end = CSS.indexOf("{", at);
  for (let i = end; i < CSS.length; i++) {
    if (CSS[i] === "{") depth++;
    else if (CSS[i] === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  const inner = CSS.slice(CSS.indexOf("{", at) + 1, end);
  return rules(inner).map((r) => r.body);
}

const KEYFRAMES = [
  "overlay-fade-in",
  "overlay-fade-out",
  "dialog-in",
  "dialog-out",
  "drawer-in",
  "drawer-out",
  "toast-in",
  "toast-out",
  "toast-drain",
  "armed-pulse",
];

describe("enter and exit timing", () => {
  it.each([
    [".overlay__scrim", "overlay-fade-in var(--duration-base) var(--ease-enter) both"],
    [".overlay--dialog .overlay__panel", "dialog-in var(--duration-base) var(--ease-enter) both"],
    [".overlay--drawer .overlay__panel", "drawer-in var(--duration-base) var(--ease-enter) both"],
    [".toast", "toast-in var(--duration-base) var(--ease-enter) both"],
  ])("%s enters on the base token", (selector, animation) => {
    expect(decl(body(selector), "animation")).toBe(animation);
  });

  it.each([
    ['.overlay[data-state="closing"] .overlay__scrim', "overlay-fade-out"],
    ['.overlay--dialog[data-state="closing"] .overlay__panel', "dialog-out"],
    ['.overlay--drawer[data-state="closing"] .overlay__panel', "drawer-out"],
    ['.toast[data-state="closing"]', "toast-out"],
  ])("%s leaves over --duration-fast on the exit curve", (selector, name) => {
    expect(decl(body(selector), "animation")).toBe(
      `${name} var(--duration-fast) var(--ease-exit) both`,
    );
  });

  it("the armed pulse runs once, never repeatedly", () => {
    const animation = decl(body(".admin-action [data-armed]::after"), "animation")!;
    expect(animation).toMatch(/^armed-pulse var\(--duration-[a-z]+\) var\(--ease-out\) 1$/);
    expect(animation).not.toContain("infinite");
  });
});

describe("keyframes move only opacity and transform, by at most 6px", () => {
  it.each(KEYFRAMES)("@keyframes %s", (name) => {
    for (const step of keyframeSteps(name)) {
      for (const part of step.split(";")) {
        const prop = part.slice(0, part.indexOf(":")).trim();
        if (!prop) continue;
        expect(["opacity", "transform"]).toContain(prop);
      }
      for (const m of step.matchAll(/(-?\d+(?:\.\d+)?)px/g))
        expect(Math.abs(Number(m[1]))).toBeLessThanOrEqual(6);
    }
  });
});

describe("reduced motion", () => {
  it("zeroes both overlay durations in the token layer", () => {
    const reduced = rules(TOKENS, true).filter((r) =>
      r.atRules.some((a) => a.includes("prefers-reduced-motion: reduce")),
    );
    const all = reduced.map((r) => r.body).join(";");
    expect(decl(all, "--duration-base")).toBe("0ms");
    expect(decl(all, "--duration-fast")).toBe("0ms");
    expect(decl(all, "--duration-slow")).toBe("0ms");
    expect(decl(all, "--duration-press")).toBe("0ms");
  });

  it("stops the Undo bar, whose duration is set inline", () => {
    const timer = rules(CSS, true).find(
      (r) =>
        r.selector === ".toast__timer" &&
        r.atRules.some((a) => a.includes("prefers-reduced-motion: reduce")),
    );
    expect(timer?.body && decl(timer.body, "animation")).toBe("none");
  });
});

describe("geometry", () => {
  it("the drawer is min(960px, 62vw) on the right edge", () => {
    expect(decl(body(".overlay--drawer .overlay__panel"), "width")).toBe("min(960px, 62vw)");
    expect(decl(body(".overlay--drawer"), "justify-items")).toBe("end");
  });

  it("overlays sit on the modal layer and toasts above them", () => {
    expect(decl(body(".overlay"), "z-index")).toBe("var(--z-modal)");
    expect(decl(body(".toasts"), "z-index")).toBe("var(--z-toast)");
  });
});

describe("the primary button's press edge (#2570)", () => {
  it("rests on the 3px edge and collapses it on press over --duration-press", () => {
    expect(decl(body(".btn--primary"), "box-shadow")).toBe("var(--shadow-press-primary)");
    const active = body(".btn--primary:active:not(:disabled)");
    expect(decl(active, "box-shadow")).toBe("var(--shadow-press-primary-pressed)");
    expect(decl(active, "transform")).toBe("translateY(var(--press-depth))");
    expect(decl(active, "transition-duration")).toBe("var(--duration-press)");
  });

  it("the edge is the 3px press-depth token", () => {
    expect(resolveToken(TOKENS, "--press-depth")).toBe("3px");
  });

  it("a disabled primary has no edge to press", () => {
    expect(decl(body(".btn--primary:disabled"), "box-shadow")).toBe("none");
  });
});
