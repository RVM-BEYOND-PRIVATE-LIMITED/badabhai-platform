/**
 * Issue #1935 (risks-register R55): the experience and salary matchers are linear on a whitespace
 * run, and match exactly what they matched before.
 *
 * experience `\s*\+?\s*` split a plus-less run between two quantifiers; it is now
 * `\s*(?:\+\s*)?`. The salary lead `(?:₹|rs\.?|inr)?\s*` let every position of a run start a match
 * that scanned to its end; it is now `(?:(?:₹|rs\.?|inr)\s*|(?<!\s)\s+)?`, so a bare run is read
 * only from its first character. A scan from the start of the text (`exec`, `matchAll`) already
 * began each match there, so no span moves.
 *
 * MAIN is the shipped source with main's connector put back and nothing else touched. The Python
 * half (`test_profile_matchers_linear.py`) runs the same comparison over the repo corpus and end
 * to end; this side covers the V8 engine, whose `\s` is not Python's.
 */

import { describe, expect, it } from "vitest";

import { loadUtteranceFixtures } from "../internal/fixtures.js";
import { compilePattern, loadLexicon, type PatternSpec } from "../internal/regex.js";
import { parseExperienceYears } from "./experience.js";
import { detectSalaries } from "./salary.js";

interface Matcher {
  readonly shipped: string;
  readonly main: string;
  readonly spec: PatternSpec;
}

const MATCHERS: Readonly<Record<"experience" | "salary", Matcher>> = {
  experience: {
    shipped: String.raw`\s*(?:\+\s*)?(?:years`,
    main: String.raw`\s*\+?\s*(?:years`,
    spec: loadLexicon<{ matcher: PatternSpec }>("experience").matcher,
  },
  salary: {
    shipped: String.raw`(?:(?:₹|rs\.?|inr)\s*|(?<!\s)\s+)?([`,
    main: String.raw`(?:₹|rs\.?|inr)?\s*([`,
    spec: loadLexicon<{ matcher: PatternSpec }>("salary").matcher,
  },
};
type Name = keyof typeof MATCHERS;
const NAMES = Object.keys(MATCHERS) as Name[];

/** `re` made global and with indices, for `matchAll` spans; `salary.ts` builds its matcher the same way. */
function withIndices(re: RegExp): RegExp {
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- the pattern is a reviewed lexicon pattern from this repo, never worker or request text.
  return new RegExp(re.source, `${re.flags}gd`);
}

/** The matcher, global and with indices, as shipped or with main's connector put back. */
function compiled(name: Name, which: "shipped" | "main"): RegExp {
  const { shipped, main, spec } = MATCHERS[name];
  let source = spec.source;
  if (which === "main") {
    // Throws when the shipped source no longer holds the linear text, so an edited connector can
    // never compare the matcher with itself.
    if (source.split(shipped).length !== 2) {
      throw new Error(`${name}.matcher no longer holds the linear connector exactly once`);
    }
    source = source.replace(shipped, main);
  }
  return withIndices(compilePattern({ ...spec, source }));
}

const SHIPPED = {
  experience: compiled("experience", "shipped"),
  salary: compiled("salary", "shipped"),
};
let mainCache: Record<Name, RegExp> | undefined;
/** Main's matchers, compiled on first use so an edited connector fails the tests, not the import. */
const main = (): Record<Name, RegExp> =>
  (mainCache ??= {
    experience: compiled("experience", "main"),
    salary: compiled("salary", "main"),
  });

/** Every match: the whole span and each group's span (undefined when the group did not take part). */
function spans(pattern: RegExp, text: string): string {
  return JSON.stringify([...text.matchAll(pattern)].map((m) => m.indices));
}

function moved(text: string): Name[] {
  return NAMES.filter((name) => spans(main()[name], text) !== spans(SHIPPED[name], text));
}

/** mulberry32: a seeded PRNG, so the fuzz below is the same on every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KNOWN = [
  "5 saal ka experience hai",
  "5+ years",
  "5 + saal",
  "5\t+\nyears",
  "5 ++ years",
  "adhai saal",
  "paune do saal kaam kiya",
  "do saal se CNC chala raha hun",
  "२ saal",
  "1.5 yrs",
  "experience 3 +years in welding",
  "salary rs 15,000",
  "Rs.18000 per month",
  "₹ 25,000 chahiye",
  "INR 2.5 lakh saal ka",
  "inr   30k",
  "20 hazaar milta hai",
  "२५००० रुपये",
  "25000 rupaye",
  "abhi   25000\n35000 chahiye",
  "reg no 123456 salary 15000",
  "NSQF level 4 kiya hai",
  "rs.   ",
  "   5000",
  "hello     world",
];

const WORDS = loadLexicon<{ wordNumbers: { word: string }[] }>("experience").wordNumbers.map(
  (w) => w.word,
);
const NUMBERS = [
  "5",
  "10",
  "1.5",
  "०.५",
  "५",
  "15000",
  "15,000",
  "1,20,000",
  "२५०००",
  ".5",
  "2026",
];
const EXP_UNITS = ["years", "yrs", "yr", "saal", "sal", "SAAL", "salo", "yearly"];
const SAL_UNITS = ["", "", "k", "thousand", "hazaar", "hzr", "lakh", "lac", "l", "kiya"];
const CURRENCIES = ["", "", "", "₹", "rs", "Rs.", "INR", "rupaye", "₹."];
const PLUSES = ["", "", "", "+", "+", "++"];
const SPACES = [" ", " ", " ", "\t", "\n", " ", "　", "\r", "﻿"];
const LEADS = ["", "", "mera ", "experience ", "salary ", "abhi ", "x", "5", ".", "I have "];
const TAILS = ["", "", " ka experience hai", " milta hai", " chahiye", " mahina", "/-", "."];

function sample(rand: () => number): string {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T;
  const ws = (): string =>
    Array.from({ length: pick([0, 0, 1, 1, 2, 3, 6]) }, () => pick(SPACES)).join("");
  const parts = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => {
    const phrase =
      rand() < 0.5
        ? pick([...NUMBERS, ...WORDS]) + ws() + pick(PLUSES) + ws() + pick(EXP_UNITS)
        : pick(CURRENCIES) + ws() + pick(NUMBERS) + ws() + pick(SAL_UNITS);
    return pick(LEADS) + phrase + pick(TAILS);
  });
  return parts.join(rand() < 0.5 ? ws() : " ");
}

const VIEWS: Readonly<Record<string, (text: string) => string>> = {
  "as written": (text) => text,
  stretched: (text) => text.replace(/\s+/g, (run) => run.repeat(3)),
  "spaced plus": (text) => text.replaceAll("+", " + "),
  "upper-cased": (text) => text.toUpperCase(),
};

describe("#1935: the experience and salary matchers read the same spans as main", () => {
  it("compares against main's connector, not against itself", () => {
    for (const name of NAMES) {
      expect(main()[name].source).not.toBe(SHIPPED[name].source);
      expect(main()[name].source).toContain(MATCHERS[name].main);
    }
  });

  it("reads the known phrases the same", () => {
    expect(KNOWN.filter((text) => moved(text).length > 0)).toEqual([]);
  });

  it.each(Object.keys(VIEWS))("reads every parity-corpus utterance the same (%s)", (view) => {
    const transform = VIEWS[view] as (text: string) => string;
    const texts = loadUtteranceFixtures().map((f) => transform(f.text));
    expect(texts.length).toBeGreaterThan(100);
    expect(texts.filter((text) => moved(text).length > 0)).toEqual([]);
  });

  it("reads 20,000 seeded phrases the same", () => {
    const rand = seeded(1935);
    const texts = Array.from({ length: 20_000 }, () => sample(rand));
    expect(texts.filter((text) => moved(text).length > 0)).toEqual([]);
  });

  it("sees a connector that does move spans", () => {
    // The harness must be able to fail: the experience connector without its trailing space.
    const { spec, shipped } = MATCHERS.experience;
    const loose = compilePattern({
      ...spec,
      source: spec.source.replace(shipped, String.raw`\s*\+?(?:years`),
    });
    const global = withIndices(loose);
    expect(spans(global, "5 + saal")).not.toBe(spans(main().experience, "5 + saal"));
  });

  it("sees a salary lead that does move spans", () => {
    // The lead without its bare-run branch starts every match on the digits.
    const { spec, shipped } = MATCHERS.salary;
    const loose = compilePattern({
      ...spec,
      source: spec.source.replace(shipped, String.raw`(?:(?:₹|rs\.?|inr)\s*)?([`),
    });
    const global = withIndices(loose);
    expect(spans(global, "   5000")).not.toBe(spans(main().salary, "   5000"));
  });
});

describe("#1935: the experience and salary readers are linear on a whitespace run", () => {
  // Shipped: 0.6 ms or less on every input below. Main: 300-410 ms on each, except 48 ms for the
  // plus split and linear on the run a digit ends (2026-10-05). Those two pin correctness only;
  // the budget leaves room for a GC pause on a loaded runner and still fails main on the rest.
  const BUDGET_MS = 150;

  function bestOf3(fn: () => unknown): number {
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 3; i += 1) {
      const start = performance.now();
      fn();
      best = Math.min(best, performance.now() - start);
    }
    return best;
  }

  it.each([
    ["adhai + 20,000 spaces + 5", "adhai" + " ".repeat(20_000) + "5"],
    [
      "5 + 9,990 spaces + '+' + 9,990 spaces",
      "5" + " ".repeat(9_990) + "+" + " ".repeat(9_990) + "!",
    ],
    ["paune do + 19,000 newlines + saalo", "paune do" + "\n".repeat(19_000) + "saalo"],
  ])("parseExperienceYears: %s", (_label, text) => {
    expect(bestOf3(() => parseExperienceYears(text))).toBeLessThan(BUDGET_MS);
  });

  it.each([
    ["hello + 19,990 spaces + world", "hello" + " ".repeat(19_990) + "world"],
    ["rs + 20,000 spaces + !", "rs" + " ".repeat(20_000) + "!"],
    ["x + 19,990 spaces + 5000", "x" + " ".repeat(19_990) + "5000"],
  ])("detectSalaries: %s", (_label, text) => {
    expect(bestOf3(() => detectSalaries(text))).toBeLessThan(BUDGET_MS);
  });

  it("still reads a number across a long run", () => {
    expect(parseExperienceYears("5" + " ".repeat(5_000) + "+ saal")?.value).toBe(5);
    expect(
      [...("rs" + " ".repeat(5_000) + "25000").matchAll(SHIPPED.salary)].map((m) => m[1]),
    ).toEqual(["25000"]);
  });
});
