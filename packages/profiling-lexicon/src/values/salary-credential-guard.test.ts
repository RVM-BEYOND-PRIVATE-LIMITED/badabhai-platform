/**
 * Issue #1933 (risks-register R54): the salary detector's credential guard is linear on a
 * whitespace run, and matches exactly what it matched before.
 *
 * `credentialBefore` read the gap between a credential cue and the identifier as
 * `\s*(?:no\.?|number|num|#)?\s*[:-]?\s*`: three whitespace quantifiers with only optional tokens
 * between them. A cue followed by a whitespace run that then failed to match tried every split of
 * the run, O(k^3) in V8 as in Python (the ai-service extractor took 2.6-7.9 s on "reg" + 800
 * spaces + "!5000"). Each quantifier is now folded into the optional token it follows.
 *
 * UNFOLDED is the shipped source with the connector written main's way put back and nothing else
 * touched, so the differential below isolates the folding. The Python half
 * (`test_pseudonymize_cued_id_linear`) runs the same comparison over the repo corpus; this side
 * covers the TypeScript engine.
 *
 * SINCE #1950 (R56) THE ORACLE CARRIES `-?`. #1950 added `-?` after the separator, so a ":-"
 * reads, and the unfolded connector carries that token too: `\s*(?:no\.?|number|num|#)?\s*
 * (?:[:-]-?)?\s*`. #1950's other tokens (the `\.?` after the cue word, the "regn" cue) sit
 * outside the connector, so the swap keeps them. What #1950 itself changed is pinned below in
 * "a dot after the cue and a ':-' separator", and measured in the Python half
 * (`test_pseudonymize_cued_id_dot`).
 */

import { describe, expect, it } from "vitest";

import { loadUtteranceFixtures } from "../internal/fixtures.js";
import { compilePattern, loadLexicon, type PatternSpec } from "../internal/regex.js";
import { detectSalaries } from "./salary.js";

// The "id" word since #2043 ("Voter ID ABC1234567"), as in the G1/G2 résumé rule's connector.
const UNFOLDED_CONNECTOR = String.raw`\s*(?:no\.?|number|num|id|#)?\s*(?:[:-]-?)?\s*`;
const LINEAR_CONNECTOR = String.raw`\s*(?:(?:no\.?|number|num|id|#)\s*)?(?:[:-]-?\s*)?`;
const VALUE_TAIL = String.raw`[A-Za-z0-9/-]{0,20}$`;

const SPEC = loadLexicon<{ credentialBefore: PatternSpec }>("salary").credentialBefore;
const SHIPPED = compilePattern(SPEC);

/** The shipped guard with `connector` in place of the linear one. Throws when the shipped source
 * no longer holds the linear text, so an edited connector can never compare the guard with itself. */
function withConnector(connector: string): RegExp {
  if (!SPEC.source.includes(LINEAR_CONNECTOR)) {
    throw new Error("credentialBefore no longer holds the linear connector");
  }
  return compilePattern({ ...SPEC, source: SPEC.source.replace(LINEAR_CONNECTOR, connector) });
}

let unfoldedGuard: RegExp | undefined;
/** The unfolded guard, compiled on first use so an edited connector fails the tests, not the
 * import. */
const unfolded = (): RegExp => (unfoldedGuard ??= withConnector(UNFOLDED_CONNECTOR));

/** What `detectSalaries` reads: the guard's hit, as [index, length], or null. */
function hit(pattern: RegExp, slice: string): [number, number] | null {
  const m = pattern.exec(slice);
  return m === null ? null : [m.index, m[0].length];
}

/** The slices `detectSalaries` hands the guard: the lowered line up to each digit-run start. */
function guardSlices(text: string): string[] {
  const lower = text.toLowerCase();
  const slices: string[] = [];
  for (const digit of lower.matchAll(/(?<!\d)\d/g)) {
    const at = digit.index;
    slices.push(lower.slice(lower.lastIndexOf("\n", at - 1) + 1, at));
  }
  return slices;
}

/** Each whitespace run three characters longer: the shape main's connector split many ways. */
function stretched(text: string): string {
  return text.replace(/\s+/g, (run) => `${run} \t\u00a0`);
}

/** A space on each side of every ":", "-" and "#": whitespace between two optional tokens. */
function spaced(text: string): string {
  return text.replace(/([:#-])/g, " $1 ");
}

/** The guard slices of `text` on which `against` and main disagree. */
function moved(text: string, against: RegExp = SHIPPED): string[] {
  return guardSlices(text).filter(
    (slice) => JSON.stringify(hit(unfolded(), slice)) !== JSON.stringify(hit(against, slice)),
  );
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
  "roll",
  "reg",
  "regd",
  "registration",
  "certificate",
  "cert",
  "enrolment",
  "enrollment",
  "licence",
  "license",
  "ncvt",
  "scvt",
  "nsqf",
  "nsdc",
  "certificates",
  "xreg",
  "registered",
];
const POSSESSIVES = ["", "", "", " ka", " ki", " ke", " mera", " meri", "  ka", " kaa", "ka"];
const NUMBER_WORDS = ["", "", "", "no", "no.", "No.", "number", "NUM", "#", "nO", "n", "numb"];
const SEPARATORS = ["", "", "", ":", "-", "::", "--", ":-", ".", ";"];
const SPACES = [" ", " ", " ", "\t", "\u00a0", "\u3000", "\r"];
const VALUES = [
  "R/2019/",
  "MH2019CN",
  "NAPS/2020/",
  "",
  "x",
  "ab-",
  "/",
  "-",
  "a".repeat(21),
  "!",
  "hai ",
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
    pick(["4471", "123456", "25000", " 25000", "\n25000"]),
  ].join("");
}

describe("the salary credential guard's connector (issue #1933, R54)", () => {
  it("folds each whitespace run into the token it follows, and nothing else changed", () => {
    expect(SPEC.source).toContain(LINEAR_CONNECTOR + VALUE_TAIL);
    expect(SPEC.source).not.toContain(UNFOLDED_CONNECTOR);
    expect(unfolded().source).toContain(UNFOLDED_CONNECTOR);
    expect(unfolded().source).not.toBe(SHIPPED.source);
    expect(unfolded().flags).toBe(SHIPPED.flags);
  });

  it("is linear on a whitespace run after a cue", () => {
    // Main took 2.6 s on this input (2026-10-03); the whole detector now takes a few ms. The
    // ceiling is generous; the structural test above is the real guard.
    const text = `reg${" ".repeat(2_000)}!5000`;
    const started = performance.now();
    const reading = detectSalaries(text);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(500);
    // Whitespace and "!" are no identifier, so 5000 is still money.
    expect(reading.current?.value).toBe(5000);
  });

  it("gives the unfolded verdict on every slice of the parity corpus, in three views of each text", () => {
    const texts = loadUtteranceFixtures().map((fixture) => fixture.text);
    expect(texts.length).toBeGreaterThan(500);
    const differing = texts.flatMap((text) =>
      [text, stretched(text), spaced(text)].flatMap((view) => moved(view)),
    );
    expect(differing).toEqual([]);
    // The corpus does reach the guard: some of its numbers sit after a credential cue.
    const guarded = texts.filter((text) => guardSlices(text).some((s) => SHIPPED.test(s)));
    expect(guarded.length).toBeGreaterThan(0);
  });

  // A correctness sweep, not a timing test: ~0.5 s alone, but over the 5 s default on a shared CI
  // runner under turbo's parallel `test --coverage` (6.1 s / 5.2 s on #1990). The linear-time
  // guard is "is linear on a whitespace run after a cue" above, which keeps its own ceiling.
  it(
    "gives the unfolded verdict on every slice of 20,000 seeded cue lines",
    { timeout: 30_000 },
    () => {
      const next = seeded(1933);
      let hits = 0;
      let sliced = 0;
      for (let i = 0; i < 20_000; i += 1) {
        const text = `${next() < 0.3 ? "abhi 25000 milta hai, " : ""}${cueLine(next)}`;
        expect(moved(text), JSON.stringify(text)).toEqual([]);
        for (const slice of guardSlices(text)) {
          sliced += 1;
          if (SHIPPED.test(slice)) hits += 1;
        }
      }
      // Both verdicts were met many times: the comparison was not vacuous.
      expect(hits).toBeGreaterThan(4_000);
      expect(sliced - hits).toBeGreaterThan(4_000);
    },
  );

  it("still drops a roll number and keeps a wage", () => {
    expect(detectSalaries("NCVT hai, roll number R/2019/123456").current).toBeNull();
    expect(detectSalaries("certificate number   :  4471 hai").current).toBeNull();
    const both = detectSalaries("abhi 25000 milta hai, 35000 chahiye, NCVT certificate hai");
    expect([both.current?.value, both.expected?.value]).toEqual([25000, 35000]);
  });

  it.each(["roll no 4471", "certificate number : 4471"])(
    "the comparison sees a connector that changes the verdict: %s",
    (text) => {
      // The sensitivity variant drops the `\s*` after the "no" word. If the comparison reported
      // no difference here, its empty lists above would mean nothing.
      const loose = withConnector(LINEAR_CONNECTOR.replace(String.raw`|#)\s*)?`, "|#))?"));
      expect(moved(text, loose)).not.toEqual([]);
      expect(moved(text)).toEqual([]);
    },
  );
});

describe("a dot after the cue and a ':-' separator (issue #1950, R56)", () => {
  // The certificate spellings whose identifier digits were recorded as pay before #1950: no
  // connector token started with ".", the separator was one character, and "regn" was no cue.
  it.each(["Reg.No.:- 123456", "Regn. No. MH2019CN4471", "Roll.No-4567890", "reg no:- 123456"])(
    "an identifier after %s is not pay",
    (text) => {
      expect(detectSalaries(text).current).toBeNull();
    },
  );

  it("a short roll number after a doubled separator is not pay either, as without the dot", () => {
    expect(detectSalaries("roll no.:- 12345").current).toBeNull();
    expect(detectSalaries("roll no 12345").current).toBeNull();
  });

  it("a wage beside a dotted cue is kept", () => {
    const both = detectSalaries("abhi 25000 milta hai, 35000 chahiye, NCVT certificate. hai");
    expect([both.current?.value, both.expected?.value]).toEqual([25000, 35000]);
  });

  it("KNOWN_RESIDUAL: a spaced dot is not read, so its digits are still pay", () => {
    // Recorded in R56's resolution; the Python half pins the same shape through the gateway.
    expect(detectSalaries("Reg . No . 123456").current?.value).toBe(123456);
  });
});

describe("the identifier-only résumé cues and a leading word boundary (issue #2043)", () => {
  // The Python half (`test_salary_guard_resume_cues.py`) pins the same cases and the measurement.
  it.each([
    "Passport No. M123456",
    "Passport.No. M123456",
    "Voter ID ABC1234567",
    "Provident Fund no MH/BAN/12345/678",
    "GSTIN 27ABCDE1234F1Z5",
    "IFSC SBIN0001234",
  ])("an identifier after a résumé cue is not pay: %s", (text) => {
    expect(detectSalaries(text).current).toBeNull();
  });

  it("a birth year is not the salary", () => {
    expect(detectSalaries("dob 1995, salary 18000").current?.value).toBe(18000);
  });

  it.each([
    ["salary account 25000 aata hai", 25000],
    ["a/c: 18000 credit hota hai", 18000],
    ["ESIC 15000 milta hai", 15000],
    ["PF ESIC ke saath 18000 milta hai", 18000],
    ["dobara 18000 milega", 18000],
    ["payroll: 18000", 18000],
    ["Company payroll. 18000 milta hai", 18000],
  ])("a real wage is kept: %s", (text, value) => {
    expect(detectSalaries(text).current?.value).toBe(value);
  });

  it("KNOWN_RESIDUAL (#2091): a two-word connector ('ID No') is not read, so its digits are pay", () => {
    expect(detectSalaries("Voter ID No: XYZ9876543").current?.value).toBe(9876543);
  });
});
