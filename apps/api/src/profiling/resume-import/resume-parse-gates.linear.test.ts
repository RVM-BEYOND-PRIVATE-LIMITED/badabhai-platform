import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CREDENTIAL_ID_RE, RESUME_CUED_ID_RE, containsHardIdentifier } from "./resume-parse-gates";

/**
 * Issue #1933 (risks-register R54): the two cued-identifier rules are linear on a whitespace run,
 * and match exactly what they matched before.
 *
 * Both read the gap between the cue and the value as `\s*(?:no\.?|number|num|#)?\s*[:-]?\s*`:
 * three whitespace quantifiers with only optional tokens between them. A cue followed by a
 * whitespace run that then failed the digit lookahead tried every split of the run, O(k^3) in V8
 * (47 ms at 400 spaces, 388 ms at 800). Each quantifier is now folded into the optional token it
 * follows: the ai-service's exact connector (`_CREDENTIAL_ID_RE`, `_RESUME_CUED_ID_RE`).
 *
 * MAIN is each shipped rule with main's connector put back and nothing else touched, so the
 * differential isolates the connector. The Python half (`test_pseudonymize_cued_id_linear.py`)
 * runs the same comparison over the repo corpus; this file covers the V8 engine.
 */

const RULES = {
  credential: {
    shipped: CREDENTIAL_ID_RE,
    main: String.raw`\s*(?:no\.?|number|num|#)?\s*[:-]?\s*`,
    linear: String.raw`\s*(?:(?:no\.?|number|num|#)\s*)?(?:[:-]\s*)?`,
    value: String.raw`(?=[A-Za-z0-9/-]{0,64}\d)`,
  },
  resume: {
    shipped: RESUME_CUED_ID_RE,
    main: String.raw`\s*(?:no\.?|number|num|id|#)?\s*[:-]?\s*`,
    linear: String.raw`\s*(?:(?:no\.?|number|num|id|#)\s*)?(?:[:-]\s*)?`,
    value: String.raw`(?=[A-Za-z0-9/-]{0,24}\d)`,
  },
} as const;
type RuleName = keyof typeof RULES;
const NAMES = Object.keys(RULES) as RuleName[];

/** The linear connector without the `\s*` after the "no" word (the sensitivity variant). */
const looseConnector = (name: RuleName): string =>
  RULES[name].linear.replace(String.raw`|#)\s*)?`, "|#))?");

/**
 * Every variant as a FROZEN LITERAL, global for `matchAll`. semgrep's blocking
 * detect-non-literal-regexp rule forbids building a RegExp from a string, so nothing here is
 * compiled at runtime; the "literals" test below pins each one, by source text, to the shipped
 * rule with exactly one connector swapped, so a later edit to a rule cannot leave a stale copy.
 */
const LITERALS: Record<RuleName, { shipped: RegExp; main: RegExp; loose: RegExp }> = {
  credential: {
    shipped:
      /\b(?:roll|reg|regd|registration|certificate|cert|enrol(?:l)?ment|licence|license)\b(?:\s+(?:ka|ki|ke|mera|meri))?\s*(?:(?:no\.?|number|num|#)\s*)?(?:[:-]\s*)?(?=[A-Za-z0-9/-]{0,64}\d)[A-Za-z0-9][A-Za-z0-9/-]{5,}/gi,
    main: /\b(?:roll|reg|regd|registration|certificate|cert|enrol(?:l)?ment|licence|license)\b(?:\s+(?:ka|ki|ke|mera|meri))?\s*(?:no\.?|number|num|#)?\s*[:-]?\s*(?=[A-Za-z0-9/-]{0,64}\d)[A-Za-z0-9][A-Za-z0-9/-]{5,}/gi,
    loose:
      /\b(?:roll|reg|regd|registration|certificate|cert|enrol(?:l)?ment|licence|license)\b(?:\s+(?:ka|ki|ke|mera|meri))?\s*(?:(?:no\.?|number|num|#))?(?:[:-]\s*)?(?=[A-Za-z0-9/-]{0,64}\d)[A-Za-z0-9][A-Za-z0-9/-]{5,}/gi,
  },
  resume: {
    shipped:
      /\b(?:passport|voter|gstin|uan|esic|provident\s+fund|ifsc|a\/c|account|dob|date\s+of\s+birth)\b\s*(?:(?:no\.?|number|num|id|#)\s*)?(?:[:-]\s*)?(?=[A-Za-z0-9/-]{0,24}\d)[A-Za-z0-9][A-Za-z0-9/-]{4,}/gi,
    main: /\b(?:passport|voter|gstin|uan|esic|provident\s+fund|ifsc|a\/c|account|dob|date\s+of\s+birth)\b\s*(?:no\.?|number|num|id|#)?\s*[:-]?\s*(?=[A-Za-z0-9/-]{0,24}\d)[A-Za-z0-9][A-Za-z0-9/-]{4,}/gi,
    loose:
      /\b(?:passport|voter|gstin|uan|esic|provident\s+fund|ifsc|a\/c|account|dob|date\s+of\s+birth)\b\s*(?:(?:no\.?|number|num|id|#))?(?:[:-]\s*)?(?=[A-Za-z0-9/-]{0,24}\d)[A-Za-z0-9][A-Za-z0-9/-]{4,}/gi,
  },
};

const mainOf = (name: RuleName): RegExp => LITERALS[name].main;
const looseOf = (name: RuleName): RegExp => LITERALS[name].loose;

/** Every match as [index, length], the global way `test` would find each in turn. */
function spans(pattern: RegExp, text: string): [number, number][] {
  return [...text.matchAll(pattern)].map((m) => [m.index, m[0].length]);
}

function moved(text: string, against: (name: RuleName) => RegExp = (n) => LITERALS[n].shipped) {
  return NAMES.filter(
    (name) =>
      JSON.stringify(spans(mainOf(name), text)) !== JSON.stringify(spans(against(name), text)),
  );
}

/** Each whitespace run three characters longer: the shape main's connector split many ways. */
function stretched(text: string): string {
  return text.replace(/\s+/g, (run) => `${run} \t\u00a0`);
}

/** A space on each side of every ":", "-" and "#": whitespace between two optional tokens. */
function spaced(text: string): string {
  return text.replace(/([:#-])/g, " $1 ");
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

const CUES = [
  ...["roll", "reg", "regd", "registration", "certificate", "cert", "enrolment", "enrollment"],
  ...["licence", "license", "passport", "voter", "gstin", "uan", "esic", "provident fund"],
  ...["ifsc", "a/c", "account", "dob", "date of birth", "certificates", "xreg", "registered"],
];
const POSSESSIVES = ["", "", "", " ka", " ki", " ke", " mera", " meri", "  ka", " kaa", "ka"];
const NUMBER_WORDS = [
  "",
  "",
  "",
  "no",
  "no.",
  "No.",
  "number",
  "NUM",
  "#",
  "id",
  "ID",
  "n",
  "numb",
];
const SEPARATORS = ["", "", "", ":", "-", "::", "--", ":-", ".", ";"];
const SPACES = [" ", " ", " ", "\t", "\n", "\u00a0", "\u3000", "\r"];
const VALUES = [
  ...["R/2019/123456", "MH2019CN4471", "123456", "ABCD1234EF", "M123456", "ABC123456"],
  ...["12/05/1988", "-123456", "12345", "ABCDE", "A1", "chahiye", "", "!", `${"x".repeat(70)}1`],
  ...[`${"ab".repeat(12)}9`, `${"ab".repeat(13)}9`],
];

function cueLine(next: () => number): string {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  const whitespace = (): string =>
    Array.from({ length: pick([0, 0, 1, 1, 2, 3, 5]) }, () => pick(SPACES)).join("");
  const cue = pick(CUES);
  return [
    next() < 0.5 ? cue : cue.toUpperCase(),
    pick(POSSESSIVES),
    whitespace(),
    pick(NUMBER_WORDS),
    whitespace(),
    pick(SEPARATORS),
    whitespace(),
    pick(VALUES),
    pick(["", " hai", ",", "/", "-x"]),
  ].join("");
}

describe("the cued-identifier connector (issue #1933, R54)", () => {
  it.each(NAMES)(
    "%s: folds each whitespace run into the token it follows, nothing else",
    (name) => {
      const { shipped, main, linear, value } = RULES[name];
      expect(shipped.source).toContain(linear + value);
      expect(shipped.source).not.toContain(main);
      expect(mainOf(name).source).toContain(main);
      expect(mainOf(name).source).not.toBe(shipped.source);
    },
  );

  it.each(NAMES)(
    "%s: every frozen literal is the shipped rule with exactly one connector swapped",
    (name) => {
      const { shipped, main, linear } = RULES[name];
      const lit = LITERALS[name];
      expect(lit.shipped.source).toBe(shipped.source);
      expect(lit.main.source).toBe(shipped.source.replace(linear, main));
      expect(lit.loose.source).toBe(shipped.source.replace(linear, looseConnector(name)));
      for (const variant of [lit.shipped, lit.main, lit.loose]) {
        expect(variant.flags).toBe(`g${shipped.flags}`);
      }
    },
  );

  // Main took 3.7-4.4 s on each cubic input below (2,000 spaces). After a "no" word main had only
  // two quantifiers left, O(k^2), so that input is longer: 553 ms at 20,000 spaces, about 2 s at
  // 40,000. The linear rules take well under a millisecond on all of them (2026-10-03). The
  // ceiling is generous; the structural test above is the real guard.
  it.each([
    ["reg", `reg${" ".repeat(2_000)}!`],
    ["possessive", `registration ka${" ".repeat(2_000)}!`],
    ["no-word", `roll no${" ".repeat(40_000)}!`],
    ["passport", `passport${" ".repeat(2_000)}!`],
    ["date of birth", `date of birth${" \t\n".repeat(700)}!`],
  ])("containsHardIdentifier is linear after a cue: %s", (_label, text) => {
    const started = performance.now();
    const verdict = containsHardIdentifier(text);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(250);
    expect(verdict).toBeNull();
  });

  it("matches main span for span over the shared fixture, in four views of each case", () => {
    const fixture = join(
      __dirname,
      "../../../../../packages/ai-contracts/src/__fixtures__/hard-identifiers.cases.json",
    );
    const cases = (JSON.parse(readFileSync(fixture, "utf8")) as { cases: { text: string }[] })
      .cases;
    expect(cases.length).toBeGreaterThan(20);
    const differing = cases
      .flatMap(({ text }) => [text, text.toUpperCase(), stretched(text), spaced(text)])
      .filter((text) => moved(text).length > 0);
    expect(differing).toEqual([]);
  });

  // A correctness sweep, not a timing test: well under 1 s alone, but over vitest's 5 s default on
  // a shared CI runner under turbo's parallel `test --coverage` (see #2023).
  it("matches main span for span over 20,000 seeded cue lines", { timeout: 30_000 }, () => {
    const next = seeded(1933);
    const seen = { credential: 0, resume: 0 };
    for (let i = 0; i < 20_000; i += 1) {
      const text = Array.from({ length: 1 + Math.floor(next() * 3) }, () => cueLine(next)).join(
        " ",
      );
      expect(moved(text), JSON.stringify(text)).toEqual([]);
      if (CREDENTIAL_ID_RE.test(text)) seen.credential += 1;
      if (RESUME_CUED_ID_RE.test(text)) seen.resume += 1;
    }
    // Both rules matched many times: the comparison was not vacuous.
    expect(seen.credential).toBeGreaterThan(2_000);
    expect(seen.resume).toBeGreaterThan(1_000);
  });

  it.each([
    ["roll number R/2019/123456 hai", "credential_id"],
    ["licence ka no   :   DL04201100", "credential_id"],
    ["reg\t#\t- AB/12/3456", "credential_id"],
    ["Passport No: M123456", "credential_id"],
    ["Voter ID - ABC123456", "credential_id"],
    ["NCVT certificate hai", null],
    ["certificate number chahiye", null],
    ["Account Manager", null],
  ])("%s -> %s, as on main", (text, expected) => {
    expect(containsHardIdentifier(text)).toBe(expected);
  });

  it.each(["reg no 123456", "passport no  M123456", "certificate number : AB4471"])(
    "the harness sees a connector that changes spans: %s",
    (text) => {
      // The sensitivity variant drops the `\s*` after the "no" word. If the comparison reported
      // no difference here, its empty lists above would mean nothing.
      expect(moved(text, looseOf)).not.toEqual([]);
      expect(moved(text)).toEqual([]);
    },
  );
});
