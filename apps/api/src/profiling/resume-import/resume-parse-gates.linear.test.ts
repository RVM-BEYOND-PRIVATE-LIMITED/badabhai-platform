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
 * UNFOLDED is each shipped rule with the connector written main's way put back and nothing else
 * touched, so the differential isolates the folding. The Python half
 * (`test_pseudonymize_cued_id_linear.py`) runs the same comparison over the repo corpus; this file
 * covers the V8 engine.
 *
 * SINCE #1950 (R56) THE ORACLE CARRIES `-?`. #1950 added `-?` after the separator, so a ":-" reads,
 * and the unfolded connector carries that token too. #1950's other tokens (the `\.?` after the cue
 * word, the "regn" cue) sit outside the connector, so the swap keeps them. What #1950 itself
 * changed is pinned below in "a dot after the cue and a ':-' separator", and measured in the
 * Python half (`test_pseudonymize_cued_id_dot.py`).
 *
 * SINCE #2091 (R56) THE ORACLE CARRIES THE LABEL WORDS. #2091 put up to two label words in
 * front of the "no" word ("id", then "card" or "code"), each folded with its own `\s*`, and
 * took "id" out of the "no"-word group. They never existed unfolded, so the oracle carries them
 * exactly as shipped and still isolates #1933's folding. What #2091 changed is pinned below in
 * "a two-word label", and measured in the Python half (`test_pseudonymize_cued_id_two_word.py`).
 */

const RULES = {
  credential: {
    shipped: CREDENTIAL_ID_RE,
    unfolded: String.raw`\s*(?:id\s*)?(?:(?:card|code)\s*)?(?:no\.?|number|num|#)?\s*(?:[:-]-?)?\s*`,
    linear: String.raw`\s*(?:id\s*)?(?:(?:card|code)\s*)?(?:(?:no\.?|number|num|#)\s*)?(?:[:-]-?\s*)?`,
    value: String.raw`(?=[A-Za-z0-9/-]{0,64}\d)`,
  },
  resume: {
    shipped: RESUME_CUED_ID_RE,
    unfolded: String.raw`\s*(?:id\s*)?(?:(?:card|code)\s*)?(?:no\.?|number|num|#)?\s*(?:[:-]-?)?\s*`,
    linear: String.raw`\s*(?:id\s*)?(?:(?:card|code)\s*)?(?:(?:no\.?|number|num|#)\s*)?(?:[:-]-?\s*)?`,
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
const LITERALS: Record<RuleName, { shipped: RegExp; unfolded: RegExp; loose: RegExp }> = {
  credential: {
    shipped:
      /\b(?:roll|reg|regd|regn|registration|certificate|cert|enrol(?:l)?ment|licence|license)\b\.?(?:\s+(?:ka|ki|ke|mera|meri))?\s*(?:id\s*)?(?:(?:card|code)\s*)?(?:(?:no\.?|number|num|#)\s*)?(?:[:-]-?\s*)?(?=[A-Za-z0-9/-]{0,64}\d)[A-Za-z0-9][A-Za-z0-9/-]{5,}/gi,
    unfolded:
      /\b(?:roll|reg|regd|regn|registration|certificate|cert|enrol(?:l)?ment|licence|license)\b\.?(?:\s+(?:ka|ki|ke|mera|meri))?\s*(?:id\s*)?(?:(?:card|code)\s*)?(?:no\.?|number|num|#)?\s*(?:[:-]-?)?\s*(?=[A-Za-z0-9/-]{0,64}\d)[A-Za-z0-9][A-Za-z0-9/-]{5,}/gi,
    loose:
      /\b(?:roll|reg|regd|regn|registration|certificate|cert|enrol(?:l)?ment|licence|license)\b\.?(?:\s+(?:ka|ki|ke|mera|meri))?\s*(?:id\s*)?(?:(?:card|code)\s*)?(?:(?:no\.?|number|num|#))?(?:[:-]-?\s*)?(?=[A-Za-z0-9/-]{0,64}\d)[A-Za-z0-9][A-Za-z0-9/-]{5,}/gi,
  },
  resume: {
    shipped:
      /\b(?:passport|voter|gstin|uan|esic|provident\s+fund|ifsc|a\/c|account|dob|date\s+of\s+birth)\b\.?\s*(?:id\s*)?(?:(?:card|code)\s*)?(?:(?:no\.?|number|num|#)\s*)?(?:[:-]-?\s*)?(?=[A-Za-z0-9/-]{0,24}\d)[A-Za-z0-9][A-Za-z0-9/-]{4,}/gi,
    unfolded:
      /\b(?:passport|voter|gstin|uan|esic|provident\s+fund|ifsc|a\/c|account|dob|date\s+of\s+birth)\b\.?\s*(?:id\s*)?(?:(?:card|code)\s*)?(?:no\.?|number|num|#)?\s*(?:[:-]-?)?\s*(?=[A-Za-z0-9/-]{0,24}\d)[A-Za-z0-9][A-Za-z0-9/-]{4,}/gi,
    loose:
      /\b(?:passport|voter|gstin|uan|esic|provident\s+fund|ifsc|a\/c|account|dob|date\s+of\s+birth)\b\.?\s*(?:id\s*)?(?:(?:card|code)\s*)?(?:(?:no\.?|number|num|#))?(?:[:-]-?\s*)?(?=[A-Za-z0-9/-]{0,24}\d)[A-Za-z0-9][A-Za-z0-9/-]{4,}/gi,
  },
};

const unfoldedOf = (name: RuleName): RegExp => LITERALS[name].unfolded;
const looseOf = (name: RuleName): RegExp => LITERALS[name].loose;

/** Every match as [index, length], the global way `test` would find each in turn. */
function spans(pattern: RegExp, text: string): [number, number][] {
  return [...text.matchAll(pattern)].map((m) => [m.index, m[0].length]);
}

function moved(text: string, against: (name: RuleName) => RegExp = (n) => LITERALS[n].shipped) {
  return NAMES.filter(
    (name) =>
      JSON.stringify(spans(unfoldedOf(name), text)) !== JSON.stringify(spans(against(name), text)),
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
  // #2091's label words, so the differential reads a whitespace run after each of them too.
  "id no",
  "ID  No.",
  "id number",
  "code",
  "Code:",
  "card no",
  "ID Card No.",
  "id\tcard",
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
      const { shipped, unfolded, linear, value } = RULES[name];
      expect(shipped.source).toContain(linear + value);
      expect(shipped.source).not.toContain(unfolded);
      expect(unfoldedOf(name).source).toContain(unfolded);
      expect(unfoldedOf(name).source).not.toBe(shipped.source);
    },
  );

  it.each(NAMES)(
    "%s: every frozen literal is the shipped rule with exactly one connector swapped",
    (name) => {
      const { shipped, unfolded, linear } = RULES[name];
      const lit = LITERALS[name];
      expect(lit.shipped.source).toBe(shipped.source);
      expect(lit.unfolded.source).toBe(shipped.source.replace(linear, unfolded));
      expect(lit.loose.source).toBe(shipped.source.replace(linear, looseConnector(name)));
      for (const variant of [lit.shipped, lit.unfolded, lit.loose]) {
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

  it("matches the unfolded rule span for span over the shared fixture, in four views of each case", () => {
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
  it(
    "matches the unfolded rule span for span over 20,000 seeded cue lines",
    { timeout: 30_000 },
    () => {
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
    },
  );

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

describe("a dot after the cue and a ':-' separator (issue #1950, R56)", () => {
  // The certificate spellings G1/G2 admitted before #1950: no connector token started with ".",
  // the separator was one character, and "regn" was no cue. The ai-service's copies read the same
  // shapes (`test_pseudonymize_cued_id_dot.py`).
  it.each([
    "Reg.No.:- 123456",
    "Regn. No. MH2019CN4471",
    "Roll.No-456789",
    "reg no:- 123456",
    "Passport.No: K123456",
    "A/c. No. 445566",
  ])("%s is a credential identifier", (text) => {
    expect(containsHardIdentifier(text)).toBe("credential_id");
  });

  it("a short roll number after a doubled separator is still too short to be one", () => {
    expect(containsHardIdentifier("roll no.:- 12345")).toBeNull();
  });

  it("KNOWN_RESIDUAL: a spaced dot is not read", () => {
    // Recorded in R56's resolution; the Python half pins the same shape through the gateway.
    expect(containsHardIdentifier("Reg . No . 123456")).toBeNull();
  });
});

describe("a two-word label (issue #2091, R56)", () => {
  // The connector read one number word, so these were admitted, and the credential rule had no
  // "id" word at all. It now reads "id", then "card" or "code", then the number word. The
  // ai-service's copies read the same shapes (`test_pseudonymize_cued_id_two_word.py`).
  it.each([
    "Voter ID No: XYZ9876543",
    "voter id no XYZ9876543",
    "Voter ID Number ABC1234567",
    "Voter Card No. ABC1234567",
    "Voter ID Card No. ABC1234567",
    "IFSC code HDFC0004321",
    "IFSC Code: SBIN0001234",
    "Passport ID No. M1234567",
    "Registration ID 123456",
    "Licence ID DL04201100",
    "Enrollment ID No: 2019AB12345",
    "Reg. Code: MH2019CN4471",
  ])("%s is a credential identifier", (text) => {
    expect(containsHardIdentifier(text)).toBe("credential_id");
  });

  it.each([
    "Voter ID card banwana hai",
    "IFSC code ke saath 25000 salary aati hai",
    "Account Code Manager",
    "registration id 2019",
  ])("a label with no identifier after it is still permitted: %s", (text) => {
    expect(containsHardIdentifier(text)).toBeNull();
  });

  it.each(["Voter Card ID No. ABC1234567", "EPIC No: XYZ9876543"])(
    "KNOWN_RESIDUAL: the words out of order, or a label with no cue, is not read: %s",
    (text) => {
      // Recorded in R56's resolution; the Python half pins the same shapes.
      expect(containsHardIdentifier(text)).toBeNull();
    },
  );
});
