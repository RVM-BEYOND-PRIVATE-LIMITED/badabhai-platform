import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decl, parseRules, stripComments, tokenValue, type Rule } from "../../../test/css-rules";
import { shakeClass } from "./shake";

/**
 * #2587 — the password sign-in motion and layout, as DECLARED (node env, no layout engine): each
 * duration resolved against the real #2570 token values, with and without reduced motion.
 *
 *   - the eye morphs in 120ms; the set-new-password step cross-fades in 160ms; a refused sign-in
 *     shakes the form once, 6px over 200ms;
 *   - enter = --ease-enter; opacity and transform only; travel ≤ 6px; nothing loops;
 *   - under prefers-reduced-motion every one of them is 0 (the tokens) AND `animation: none`;
 *   - the eye sits beside the input row (not the label, not the error).
 */
const here = dirname(fileURLToPath(import.meta.url));
const GLOBALS = stripComments(readFileSync(join(here, "..", "globals.css"), "utf8"));
const TOKENS = stripComments(
  readFileSync(join(here, "..", "..", "..", "..", "..", "packages", "design-tokens", "tokens.css"), "utf8"),
);
const RULES = parseRules(GLOBALS);
const REDUCED_AT = "@media (prefers-reduced-motion: reduce)";
const REDUCED_TOKENS = parseRules(TOKENS).find((r) => r.at === REDUCED_AT && r.selector === ":root")!;

function rule(selector: string, at = ""): Rule {
  const found = RULES.filter((r) => r.selector === selector && r.at === at);
  expect(found, `${at} ${selector}`).toHaveLength(1);
  return found[0]!;
}
/** The keyframe stops of `@keyframes name`, as rules ("from", "20%", …). */
function keyframes(name: string): Rule[] {
  return parseRules(rule(`@keyframes ${name}`).body);
}

/** Split on whitespace outside parentheses. */
function splitTop(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (depth === 0 && /\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** A duration expression in ms, with `var(--duration-*)` read from the given token source. */
function ms(expr: string, reduced: boolean): number {
  const resolved = expr.replace(/var\((--[a-z-]+)\)/g, (_, name: string) => {
    const value = reduced ? decl(REDUCED_TOKENS, name) : tokenValue(TOKENS, name);
    expect(value, name).not.toBeNull();
    return value!;
  });
  const plain = /^(\d+(?:\.\d+)?)ms$/.exec(resolved);
  if (plain) return Number(plain[1]);
  const product = /^calc\((\d+(?:\.\d+)?)ms \* (\d+(?:\.\d+)?)\)$/.exec(resolved);
  expect(product, `cannot read ${resolved}`).not.toBeNull();
  return Number(product![1]) * Number(product![2]);
}

/** The pieces of a one-animation shorthand: name, duration, easing, the rest. */
function animation(r: Rule) {
  const value = decl(r, "animation");
  expect(value, r.selector).not.toBeNull();
  const [name, duration, easing, ...rest] = splitTop(value!);
  return { name: name!, duration: duration!, easing: easing!, rest };
}

/** Every property a keyframe animation touches. */
const animatedProps = (name: string) =>
  keyframes(name).flatMap((stop) =>
    stop.body
      .split(";")
      .map((d) => d.split(":")[0]!.trim())
      .filter(Boolean),
  );

const SPEC = [
  { what: "the eye morph (show)", selector: '.login-secret__toggle[data-morph="show"] .ph-fill', ms: 120 },
  { what: "the eye morph (hide)", selector: '.login-secret__toggle[data-morph="hide"] .ph-fill', ms: 120 },
  { what: "the step cross-fade", selector: ".login-step", ms: 160 },
  { what: "the shake (a)", selector: ".login-form--shake-a", ms: 200 },
  { what: "the shake (b)", selector: ".login-form--shake-b", ms: 200 },
] as const;

describe("#2587 · motion — the issue's durations, on the shared tokens", () => {
  it.each(SPEC)("$what runs $ms ms, and 0 under reduced motion", ({ selector, ms: expected }) => {
    const { duration, rest } = animation(rule(selector));
    expect(duration).toContain("--duration-");
    expect(ms(duration, false)).toBe(expected);
    expect(ms(duration, true)).toBe(0);
    expect(rest).not.toContain("infinite");
  });

  it("entering motion eases out (--ease-enter); the shake eases out too", () => {
    for (const s of SPEC.slice(0, 3)) expect(animation(rule(s.selector)).easing).toBe("var(--ease-enter)");
    for (const s of SPEC.slice(3)) expect(animation(rule(s.selector)).easing).toBe("var(--ease-out)");
  });

  it("each pair alternates two keyframe NAMES (so every toggle / refusal restarts it), identical stops", () => {
    for (const [a, b] of [
      [SPEC[0], SPEC[1]],
      [SPEC[3], SPEC[4]],
    ] as const) {
      const nameA = animation(rule(a.selector)).name;
      const nameB = animation(rule(b.selector)).name;
      expect(nameA).not.toBe(nameB);
      expect(keyframes(nameA)).toEqual(keyframes(nameB));
    }
  });

  it("opacity and transform only", () => {
    for (const s of SPEC) {
      for (const prop of animatedProps(animation(rule(s.selector)).name)) {
        expect(["opacity", "transform"], `${s.what}: ${prop}`).toContain(prop);
      }
    }
    // The cross-fade is a fade: no travel at all.
    expect(animatedProps("login-step-in")).toEqual(["opacity"]);
  });

  it("the shake travels at most --motion-rise (6px), which is 0 under reduced motion", () => {
    expect(tokenValue(TOKENS, "--motion-rise")).toBe("6px");
    expect(decl(REDUCED_TOKENS, "--motion-rise")).toBe("0px");
    const stops = keyframes("login-shake-a");
    expect(stops.length).toBeGreaterThan(0);
    for (const stop of stops) {
      const t = decl(stop, "transform")!;
      const coefficient = /calc\((-?\d*\.?\d+) \* var\(--motion-rise\)\)/.exec(t)?.[1];
      const factor = coefficient === undefined ? (t === "translateX(var(--motion-rise))" ? 1 : NaN) : Number(coefficient);
      expect(Math.abs(factor), `${stop.selector}: ${t}`).toBeLessThanOrEqual(1);
    }
  });

  it("reduced motion also switches every one of them off outright", () => {
    const reduced = RULES.filter((r) => r.at === REDUCED_AT && r.selector.includes(".login-step"));
    expect(reduced).toHaveLength(1);
    const selectors = reduced[0]!.selector.split(",").map((s) => s.trim());
    for (const s of [".login-step", ".login-form--shake-a", ".login-form--shake-b", ".login-secret__toggle[data-morph] .ph-fill"]) {
      expect(selectors).toContain(s);
    }
    expect(decl(reduced[0]!, "animation")).toBe("none");
  });

  it("shakeClass: nothing until a refusal, then the two names alternately", () => {
    expect(shakeClass(0)).toBe("");
    expect(shakeClass(1)).toBe(" login-form--shake-a");
    expect(shakeClass(2)).toBe(" login-form--shake-b");
    expect(shakeClass(3)).toBe(" login-form--shake-a");
  });
});

describe("#2587 · the password row — the eye beside the INPUT", () => {
  it("the DS field joins a two-column grid; label and feedback span it; the eye takes the input's row", () => {
    expect(decl(rule(".login-secret"), "display")).toBe("grid");
    expect(decl(rule(".login-secret"), "grid-template-columns")).toBe("minmax(0, 1fr) auto");
    expect(decl(rule(".login-secret > .bb-field"), "display")).toBe("contents");
    expect(decl(rule(".login-secret .bb-field__label, .login-secret .bb-field__hint, .login-secret .bb-field__error"), "grid-column")).toBe("1 / -1");
    expect(decl(rule(".login-secret .bb-input-wrap"), "grid-column")).toBe("1");
    const toggle = rule(".login-secret > .login-secret__toggle");
    expect(decl(toggle, "grid-column")).toBe("2");
    expect(decl(toggle, "grid-row")).toBe("2");
  });
});
