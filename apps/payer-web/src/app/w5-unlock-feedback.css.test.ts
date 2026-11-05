import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decl, parseRules, stripComments, tokenValue } from "../../test/css-rules";
import type { Rule } from "../../test/css-rules";

/**
 * #2585 (W5) — feedback after spending a credit: the stylesheet half (node env, no layout engine,
 * so the DECLARED motion is fenced). The behaviour half is the chip, feed and list suites.
 *
 * Acceptance: no animation loops forever. Each new motion plays ONCE, takes its duration from a
 * #2570 token (so it is 0 under reduced motion), and animates only opacity or transform:
 *  - the credits chip's tint fades out over 2/3 of --duration-count (400ms) — Safety Yellow 40%;
 *  - a fresh grant's band clears from blurred over --duration-slow (320ms) — a STATIC blur layer
 *    whose opacity fades, so no filter is animated;
 *  - the Unlocked seal stamps 0.6 → 1.08 → 1 over --duration-celebrate (520ms);
 *  - the Post-job CTA's shine sweeps once, and never on a disabled button.
 */

const here = dirname(fileURLToPath(import.meta.url));
const GLOBALS = stripComments(readFileSync(join(here, "globals.css"), "utf8"));
const TOKENS = stripComments(
  readFileSync(
    join(here, "..", "..", "..", "..", "packages", "design-tokens", "tokens.css"),
    "utf8",
  ),
);
const RULES: Rule[] = parseRules(GLOBALS);
const TOKEN_RULES: Rule[] = parseRules(TOKENS);
const REDUCED = "@media (prefers-reduced-motion: reduce)";

/** The rule for exactly `selector` at top level. */
function rule(selector: string): Rule {
  const found = RULES.filter((r) => r.selector === selector && r.at === "");
  expect(found, selector).toHaveLength(1);
  return found[0]!;
}
const keyframes = (name: string): string => {
  const found = RULES.filter((r) => r.selector === `@keyframes ${name}`);
  expect(found, name).toHaveLength(1);
  return found[0]!.body;
};
/** The properties a keyframes block sets. */
const keyframeProps = (body: string) =>
  [...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]!).filter((p, i, a) => a.indexOf(p) === i);
const ms = (token: string) => Number.parseFloat(tokenValue(TOKENS, token)!);
/** A shorthand's parts, split on whitespace outside parentheses. */
function parts(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    if (depth === 0 && /\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** [the rule that runs it, its keyframes, the duration token it names]. */
const W5_MOTION: ReadonlyArray<readonly [string, string, string]> = [
  [".pshell__balancetint", "balance-tint-out", "--duration-count"],
  [".applicant__granted--fresh::after", "unlock-clear", "--duration-slow"],
  [
    ".applicant__granted--fresh .applicant__unlocked > .ph-fill",
    "unlock-stamp",
    "--duration-celebrate",
  ],
];

describe("W5 #2585 — every new motion plays once, on a token, opacity/transform only", () => {
  it.each(W5_MOTION)(
    "%s runs %s on %s — once (no iteration count, never infinite)",
    (sel, name, token) => {
      const animation = decl(rule(sel), "animation")!;
      expect(animation.startsWith(`${name} `)).toBe(true);
      expect(animation).toContain(`var(${token})`);
      expect(animation).not.toMatch(/infinite/);
      // Exactly name, duration, easing, fill — no iteration count at all, so it runs once.
      const [n, duration, easing, fill, ...rest] = parts(animation);
      expect([n, fill, rest]).toEqual([name, "both", []]);
      expect(duration).toContain("--duration-");
      expect(easing).toMatch(/^var\(--ease-[\w-]+\)$/);
    },
  );

  it.each(W5_MOTION)("%s's keyframes (%s) animate only opacity or transform", (_sel, name) => {
    const props = keyframeProps(keyframes(name));
    expect(props.length).toBeGreaterThan(0);
    expect(props.filter((p) => p !== "opacity" && p !== "transform")).toEqual([]);
  });

  it("every duration and distance it uses is zeroed under reduced motion (the token layer)", () => {
    const reduced = TOKEN_RULES.find((r) => r.at === REDUCED && r.selector === ":root")!;
    for (const token of ["--duration-count", "--duration-slow", "--duration-celebrate"]) {
      expect(decl(reduced, token), token).toBe("0ms");
    }
    expect(decl(reduced, "--motion-rise")).toBe("0px");
  });
});

describe("W5 #2585 — the credits chip: a Safety Yellow tint fades out while the figure counts", () => {
  it("fades over two thirds of the 600ms count — 400ms — easing out as it exits", () => {
    expect(ms("--duration-count")).toBe(600);
    expect(decl(rule(".pshell__balancetint"), "animation")).toBe(
      "balance-tint-out calc(var(--duration-count) * 2 / 3) var(--ease-exit) both",
    );
    expect(keyframes("balance-tint-out").replace(/\s+/g, "")).toBe(
      "from{opacity:1;}to{opacity:0;}",
    );
  });

  it("is the brand's Safety Yellow 40% step — no new colour — and never takes a click", () => {
    const tint = rule(".pshell__balancetint");
    expect(decl(tint, "background")).toBe("var(--color-brand-accent-40)");
    expect(decl(tint, "pointer-events")).toBe("none");
    expect(decl(tint, "opacity")).toBe("0"); // at rest (and after its one run) it is invisible
  });

  it("sits under the icon and figure: the chip isolates only while a tint exists", () => {
    expect(decl(rule(".pshell__balance:has(> .pshell__balancetint)"), "isolation")).toBe("isolate");
    expect(decl(rule(".pshell__balancetint"), "z-index")).toBe("calc(var(--z-base) - 1)");
  });
});

describe("W5 #2585 — a card that unlocks: blurred → clear over 320ms, then the stamp", () => {
  it("the blur is a STATIC layer of --motion-rise over the band; only its opacity animates", () => {
    expect(ms("--duration-slow")).toBe(320);
    const layer = rule(".applicant__granted--fresh::after");
    expect(decl(layer, "backdrop-filter")).toBe("blur(var(--motion-rise))");
    expect(decl(layer, "pointer-events")).toBe("none"); // the band is clickable while it clears
    expect(keyframes("unlock-clear").replace(/\s+/g, "")).toBe("from{opacity:1;}to{opacity:0;}");
    expect(decl(rule(".applicant__granted--fresh"), "position")).toBe("relative");
  });

  it("the seal scales 0.6 → 1.08 → 1 over the 520ms celebrate token", () => {
    expect(ms("--duration-celebrate")).toBe(520);
    const scales = [...keyframes("unlock-stamp").matchAll(/scale\(([\d.]+)\)/g)].map((m) => m[1]);
    expect(scales).toEqual(["0.6", "1.08", "1"]);
  });
});

describe("W5 #2585 — the Post-job CTA shine plays once and never on a disabled button", () => {
  it("one sweep: no iteration count, never infinite", () => {
    const shine = decl(rule(".posting-cta::after"), "animation")!;
    expect(shine).toBe("cta-shine calc(var(--duration-shimmer) * 2) var(--ease-in-out)");
  });

  it("a disabled (or busy) CTA does not shine", () => {
    expect(
      decl(
        rule('.posting-cta:disabled::after, .posting-cta[aria-disabled="true"]::after'),
        "animation",
      ),
    ).toBe("none");
  });
});
