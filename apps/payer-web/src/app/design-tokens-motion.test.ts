import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BREAKPOINTS } from "@badabhai/design-tokens/breakpoints";
import { decl, parseRules, stripComments, tokenValue } from "../../test/css-rules";

/**
 * #2570 (F0) — the motion, press, skeleton, radius and breakpoint tokens in
 * @badabhai/design-tokens: declared with the issue's values, zeroed under prefers-reduced-motion,
 * built from existing brand steps only (no new colour), and the breakpoint constant in step with
 * the `@custom-media` declarations.
 */
const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..", "..", "..", "..", "packages", "design-tokens");
const RAW = readFileSync(join(pkgDir, "tokens.css"), "utf8");
const TOKENS = stripComments(RAW);
const REDUCED = parseRules(TOKENS).find(
  (r) => r.at === "@media (prefers-reduced-motion: reduce)" && r.selector === ":root",
)!;

const DURATIONS: Record<string, string> = {
  "--duration-instant": "80ms",
  "--duration-fast": "140ms",
  "--duration-base": "220ms",
  "--duration-slow": "320ms",
  "--duration-slower": "480ms",
  "--duration-press": "90ms",
  "--duration-page": "200ms",
  "--duration-sheet": "300ms",
  "--duration-count": "600ms",
  "--duration-celebrate": "520ms",
  "--duration-shimmer": "1400ms",
};
const DISTANCES: Record<string, [string, string]> = {
  "--motion-rise": ["6px", "0px"],
  "--motion-enter-scale": ["0.98", "1"],
  "--press-depth": ["3px", "0px"],
  "--press-scale": ["0.97", "1"],
  "--stagger-step": ["30ms", "0ms"],
};

describe("#2570 · design-tokens motion and press tokens", () => {
  it.each(Object.entries(DURATIONS))("%s is %s and 0ms under reduced motion", (name, value) => {
    expect(tokenValue(TOKENS, name)).toBe(value);
    expect(decl(REDUCED, name)).toBe("0ms");
  });

  it.each(Object.entries(DISTANCES))("%s is %j (rest, reduced motion)", (name, [rest, reduced]) => {
    expect(tokenValue(TOKENS, name)).toBe(rest);
    expect(decl(REDUCED, name)).toBe(reduced);
  });

  it("stagger caps at 8 items; an opacity fade keeps at most 120ms under reduced motion", () => {
    expect(tokenValue(TOKENS, "--stagger-max")).toBe("8");
    expect(Number.parseInt(decl(REDUCED, "--duration-fade")!, 10)).toBeLessThanOrEqual(120);
  });

  it("enter, exit and glide easings exist beside the success-only stamp", () => {
    for (const name of ["--ease-enter", "--ease-exit", "--ease-glide", "--ease-stamp"])
      expect(tokenValue(TOKENS, name), name).not.toBeNull();
  });

  it("the press edge and skeleton tokens reuse existing brand steps — no new colour", () => {
    expect(tokenValue(TOKENS, "--press-edge-primary")).toBe("var(--brand-press)");
    expect(tokenValue(TOKENS, "--press-edge-secondary")).toBe("var(--navy-900)");
    expect(tokenValue(TOKENS, "--skeleton-base")).toBe("var(--surface-sunken)");
    expect(tokenValue(TOKENS, "--skeleton-sheen")).toBe("var(--surface-card)");
    // The edge sits at --press-depth and collapses to 0 on press.
    expect(tokenValue(TOKENS, "--shadow-press-primary")).toBe(
      "0 var(--press-depth) 0 0 var(--press-edge-primary)",
    );
    expect(tokenValue(TOKENS, "--shadow-press-primary-pressed")).toBe(
      "0 0 0 0 var(--press-edge-primary)",
    );
    expect(tokenValue(TOKENS, "--shadow-press-secondary")).toBe(
      "0 var(--press-depth) 0 0 var(--press-edge-secondary)",
    );
    expect(tokenValue(TOKENS, "--shadow-press-secondary-pressed")).toBe(
      "0 0 0 0 var(--press-edge-secondary)",
    );
    // Every motion/press/skeleton declaration is colour-free or a var() reference.
    const block = TOKENS.slice(
      TOKENS.indexOf("--ease-enter:"),
      TOKENS.indexOf("--transition-control:"),
    );
    expect(block).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });

  it("--radius-sm is a real step below --radius-md (8px < 10px)", () => {
    expect(tokenValue(TOKENS, "--radius-sm")).toBe("8px");
    expect(tokenValue(TOKENS, "--radius-md")).toBe("10px");
  });

  it("the BREAKPOINTS constant matches the @custom-media declarations", () => {
    expect(BREAKPOINTS).toEqual({ phone: 375, tablet: 600, desktop: 1024, wide: 1280 });
    for (const [name, px] of Object.entries(BREAKPOINTS))
      expect(TOKENS, `--bp-${name}`).toContain(`@custom-media --bp-${name} (min-width: ${px}px);`);
  });

  it("the package README documents the new tokens", () => {
    const readme = readFileSync(join(pkgDir, "README.md"), "utf8");
    for (const name of [
      ...Object.keys(DURATIONS),
      ...Object.keys(DISTANCES),
      "--duration-fade",
      "--stagger-max",
      "--ease-enter",
      "--ease-exit",
      "--ease-glide",
      "--press-edge-primary",
      "--shadow-press-primary",
      "--skeleton-base",
      "--skeleton-sheen",
      "--bp-tablet",
      "BREAKPOINTS",
    ])
      expect(readme, name).toContain(name);
  });
});
