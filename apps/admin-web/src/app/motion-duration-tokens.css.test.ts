import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "../../test/css-rules";

/**
 * #2570 (F0) — DURATION-TOKEN FENCE. Every animation and transition in admin-web's stylesheets
 * takes its duration from a `--duration-*` motion token in @badabhai/design-tokens, so motion
 * feels the same on every surface and collapses to 0 under prefers-reduced-motion in one place.
 *
 * Rules, per comma-separated item of `transition`, `animation` and their `-duration` / `-delay`
 * longhands:
 *   - no non-zero hard-coded time (`160ms`, `0.45s`), bare or inside `calc()`; a literal 0
 *     (`visibility 0s …`, an instant `0s` reveal) is not motion and stays allowed;
 *   - the duration — the first time value of a shorthand, every value of a `-duration`
 *     longhand — names a `--duration-*` token (directly or in a `calc()`), or is 0.
 */
const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..");

const MOTION_PROPS = new Set([
  "transition",
  "transition-duration",
  "transition-delay",
  "animation",
  "animation-duration",
  "animation-delay",
]);
const TIME = /^-?(\d+\.?\d*|\.\d+)m?s$/;
const LITERAL_TIME_IN_FN = /(?<![\w-])(\d+\.?\d*|\.\d+)m?s\b/g;

/** Split on a separator at parenthesis depth 0. */
function splitTop(value: string, isSep: (ch: string) => boolean): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (depth === 0 && isSep(ch)) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const isZero = (t: string) => TIME.test(t) && Number.parseFloat(t) === 0;
const isTimeToken = (t: string) =>
  TIME.test(t) || (t.includes("(") && /--duration-|--stagger-|-delay\b/.test(t));

/** The problems with one motion declaration, or [] when it is token-driven. */
function motionViolations(prop: string, value: string): string[] {
  const problems: string[] = [];
  for (const item of splitTop(value, (c) => c === ",")) {
    const parts = splitTop(item, (c) => /\s/.test(c));
    for (const p of parts) {
      if (TIME.test(p) && !isZero(p)) problems.push(`hard-coded time ${p}`);
      if (p.includes("(")) {
        for (const m of p.matchAll(LITERAL_TIME_IN_FN))
          if (Number.parseFloat(m[1]!) !== 0) problems.push(`hard-coded time ${m[0]} in ${p}`);
      }
    }
    const times = parts.filter(isTimeToken);
    const duration = prop.endsWith("-delay")
      ? undefined
      : prop.endsWith("-duration")
        ? parts[0]
        : times[0];
    if (duration && !isZero(duration) && !duration.includes("--duration-"))
      problems.push(`duration ${duration} is not a --duration-* token`);
  }
  return problems;
}

/** Every .css file under src (recursive). */
function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return cssFiles(p);
    return e.name.endsWith(".css") ? [p] : [];
  });
}

/** Every motion declaration in a stylesheet as [property, value]. Custom properties are skipped. */
function motionDecls(css: string): [string, string][] {
  const out: [string, string][] = [];
  for (const m of css.matchAll(/(?:^|[;{])\s*([a-z-]+)\s*:\s*([^;{}]+)/g)) {
    const prop = m[1]!;
    if (MOTION_PROPS.has(prop)) out.push([prop, m[2]!.replace(/\s+/g, " ").trim()]);
  }
  return out;
}

const FILES = cssFiles(SRC);
const DECLS = FILES.flatMap((f) =>
  motionDecls(stripComments(readFileSync(f, "utf8"))).map(([p, v]) => ({
    file: relative(SRC, f),
    p,
    v,
  })),
);

describe("#2570 · every animation/transition in admin-web uses a duration token", () => {
  it("scans the stylesheets it is meant to guard (vacuity check)", () => {
    expect(FILES.map((f) => relative(SRC, f))).toEqual(
      expect.arrayContaining([join("app", "globals.css")]),
    );
    expect(DECLS.length).toBeGreaterThan(10);
    expect(DECLS.some((d) => d.v.includes("nav-pending-pulse var(--duration-slower)"))).toBe(true);
  });

  it("the checker flags hard-coded durations and curves-only items, and passes token ones", () => {
    expect(motionViolations("transition", "opacity 160ms ease-out")).not.toEqual([]);
    expect(
      motionViolations("animation", "mw-nav-in 0.45s cubic-bezier(0.2, 0.7, 0.2, 1) both"),
    ).not.toEqual([]);
    expect(motionViolations("animation-delay", "0.05s")).not.toEqual([]);
    expect(motionViolations("animation", "x calc(200ms * 2) linear")).not.toEqual([]);
    expect(
      motionViolations("transition", "transform var(--duration-slow) var(--ease-glide)"),
    ).toEqual([]);
    expect(motionViolations("transition", "visibility 0s linear var(--duration-base)")).toEqual([]);
    expect(
      motionViolations(
        "animation",
        "x calc(var(--duration-shimmer) * 2) var(--ease-in-out) infinite",
      ),
    ).toEqual([]);
    expect(motionViolations("animation-delay", "calc(var(--stagger-step) * 3)")).toEqual([]);
    expect(motionViolations("animation", "none")).toEqual([]);
  });

  it("no stylesheet hard-codes a duration", () => {
    const bad = DECLS.flatMap((d) =>
      motionViolations(d.p, d.v).map((why) => `${d.file} · ${d.p}: ${d.v} — ${why}`),
    );
    expect(bad).toEqual([]);
  });
});
