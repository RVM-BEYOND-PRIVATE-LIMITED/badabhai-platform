/**
 * The TypeScript half of the value-normalizer parity gate.
 *
 * `apps/ai-service/tests/test_lexicon_parity.py` asserts the SAME corpus against the Python
 * normalizers. A cue list, a gazetteer entry or a span calculation that changes on one side only
 * turns the other side red.
 *
 * Spans are asserted, not just values. The span is what the Phase 7 parse call's provenance gate
 * checks, so a normalizer that finds the right value at the wrong offset is a real defect that a
 * value-only assertion would wave through.
 */

import { describe, expect, it } from "vitest";

import { loadUtteranceFixtures } from "../internal/fixtures.js";
import { loadLexicon } from "../internal/regex.js";
import type { NormalizedValue } from "./types.js";
import { canonicalCity, canonicalRegion, canonicalState } from "./gazetteer.js";
import { parseExperienceYears } from "./experience.js";
import { applyNegation, isNegated } from "./negation.js";
import { detectSalaries, parseAmount, parseSalaryMonthly } from "./salary.js";

type AnyNormalizer = (text: string) => NormalizedValue<unknown> | null;

const NORMALIZER_BY_NAME: Readonly<Record<string, AnyNormalizer>> = {
  canonicalCity,
  canonicalState,
  canonicalRegion,
  parseExperienceYears,
  salaryExpected: (text) => detectSalaries(text).expected,
  salaryCurrent: (text) => detectSalaries(text).current,
  parseSalaryMonthly,
};

const fixtures = loadUtteranceFixtures();

interface ExpectedValue {
  value: unknown;
  span: [number, number];
  negationVetoed: boolean;
}

function expected(f: (typeof fixtures)[number]): Record<string, ExpectedValue> {
  return ((f as { values?: Record<string, ExpectedValue> }).values ?? {}) as Record<
    string,
    ExpectedValue
  >;
}

describe("value corpus shape", () => {
  it("carries enough cases with values to be meaningful", () => {
    const withValues = fixtures.filter((f) => Object.keys(expected(f)).length > 0);
    expect(withValues.length).toBeGreaterThanOrEqual(50);
  });

  it("exercises every normalizer, and exercises the negation veto", () => {
    // Guards against a vacuously green suite: a normalizer that returned null on all 408 cases
    // would satisfy every per-case assertion below.
    for (const name of Object.keys(NORMALIZER_BY_NAME)) {
      const hits = fixtures.filter((f) => expected(f)[name] !== undefined);
      expect(hits.length, `${name} never produces a value anywhere in the corpus`).toBeGreaterThan(
        0,
      );
    }
    const vetoed = fixtures
      .flatMap((f) => Object.values(expected(f)))
      .filter((v) => v.negationVetoed);
    expect(vetoed.length, "no fixture exercises the negation veto").toBeGreaterThan(0);
  });
});

describe("normalizers match the corpus", () => {
  it.each(fixtures.map((f) => [f.id, f] as const))("%s", (_id, fixture) => {
    const want = expected(fixture);
    const where = `${fixture.id} ${JSON.stringify(fixture.text)}${fixture.note ? ` — ${fixture.note}` : ""}`;

    for (const [name, normalizer] of Object.entries(NORMALIZER_BY_NAME)) {
      const got = normalizer(fixture.text);
      const wanted = want[name];

      if (wanted === undefined) {
        // An ABSENT key means the normalizer must return null. This is the assertion that
        // catches a detector which starts firing where it should not.
        expect(got, `${name} should not fire — ${where}`).toBeNull();
        continue;
      }

      expect(got, `${name} returned null — ${where}`).not.toBeNull();
      expect(got?.value, `${name} value — ${where}`).toEqual(wanted.value);
      expect([got?.span.start, got?.span.end], `${name} span — ${where}`).toEqual(wanted.span);
      expect(got?.negationVetoed, `${name} negationVetoed — ${where}`).toBe(wanted.negationVetoed);
    }
  });
});

describe("negation engine semantics the corpus alone would not pin", () => {
  it("preserves length so downstream offsets still line up", () => {
    // The masker writes SPACES rather than deleting. Every offset-based reader depends on it.
    for (const text of ["setting nahi aati", "VMC nahi chalaya", "abhi kaam nahi mil raha"]) {
      expect(applyNegation(text).masked).toHaveLength(text.length);
    }
  });

  it("blanks the words BEFORE the negator, not after", () => {
    const { masked } = applyNegation("setting nahi aati");
    expect(masked.startsWith("       ")).toBe(true); // "setting" blanked
    expect(masked).toContain("aati"); // the trailing verb survives
  });

  it("treats clause-final 'na' as an affirmative tag, not a denial", () => {
    // "VMC chalata hu na" = "I DO run VMC, right?". Reading it as a denial would delete the very
    // machine the worker just claimed.
    expect(applyNegation("VMC chalata hu na").masked).toBe("VMC chalata hu na");
    // With more words following in the clause, the same token IS a negator.
    expect(applyNegation("na bhai aisa nahi hai").masked).not.toBe("na bhai aisa nahi hai");
  });

  it("stops a negation at a clause boundary", () => {
    // A spurious split only ever SHRINKS a negation scope, which is the safe direction.
    const { masked } = applyNegation("setting nahi aati, sirf chalata hu");
    expect(masked).toContain("sirf chalata hu");
  });

  it("tokenizes past trailing punctuation", () => {
    // Without Python's `str.strip(chars)` semantics, "nahi," never matches the negator list.
    expect(applyNegation("setting nahi, chalata hu").masked).not.toContain("setting");
  });

  it("does not treat bare English 'no' as a negator", () => {
    // "part no. 12" / "drawing no. 45" — as a negator it would blank the three words before it,
    // deleting "drawing" from a worker who reads drawings.
    expect(applyNegation("drawing no. 45 dekha").masked).toBe("drawing no. 45 dekha");
  });

  it("reports the topics a denial answers", () => {
    expect([...applyNegation("ITI nahi kiya").topics]).toContain("education");
    expect([...applyNegation("setting nahi aati").topics]).toContain("skills");
  });

  it("exposes overlap-based veto for chip answers", () => {
    const city = canonicalCity("pune nahi jaunga");
    expect(city?.value).toBe("Pune");
    expect(isNegated("pune nahi jaunga", city!.span)).toBe(true);
  });
});

describe("gazetteer semantics", () => {
  it("matches the longest city name first", () => {
    // Without longest-first ordering, "delhi" matches inside "new delhi" and the worker's city
    // silently becomes the wrong one.
    expect(canonicalCity("new delhi me hu")?.value).toBe("New Delhi");
    expect(canonicalCity("navi mumbai")?.value).toBe("Navi Mumbai");
    expect(canonicalCity("greater noida")?.value).toBe("Greater Noida");
  });

  it("resolves aliases into the closed canonical set", () => {
    expect(canonicalCity("dilli")?.value).toBe("Delhi");
    expect(canonicalCity("bombay")?.value).toBe("Mumbai");
    expect(canonicalCity("poona")?.value).toBe("Pune");
  });

  it("only accepts UPPERCASE state abbreviations", () => {
    // A case-insensitive "up" collides with "set up" / "setup" and would corrupt the profile.
    expect(canonicalState("UP se hu")?.value).toBe("Uttar Pradesh");
    expect(canonicalState("machine set up kiya")).toBeNull();
    expect(canonicalState("setup karta hu")).toBeNull();
  });

  it("prefers a full state name over an abbreviation", () => {
    expect(canonicalState("uttar pradesh me MP nahi")?.value).toBe("Uttar Pradesh");
  });

  it("requires a whole phrase for a region", () => {
    expect(canonicalRegion("south india me kaam")?.value).toBe("South India");
    expect(canonicalRegion("south side me rehta hu")).toBeNull();
    expect(canonicalRegion("made in india")).toBeNull();
  });
});

describe("salary semantics the corpus alone would not pin", () => {
  it("keeps the matcher's inline units and the unit lists in step", () => {
    // The matcher spells its units inline while parseAmount reads them from two lists, and
    // nothing else connects the two. A unit added to one and not the other either never matches
    // (silently dropping every "25 <unit>") or matches and then multiplies by 1. Both silent.
    // Asserted from BOTH jobs: the node job always runs on a lexicon-only change, the
    // ai-service job only because ci.yml lists this package in its path filter.
    const salary = loadLexicon<{
      matcher: { source: string };
      thousandUnits: string[];
      lakhUnits: string[];
    }>("salary");
    const units = [...salary.thousandUnits, ...salary.lakhUnits].join("|");
    expect(salary.matcher.source).toContain(`(?:${units}){WE}`);
  });

  it("divides an annual figure down to a month, and never the reverse", () => {
    // The 12x error this whole file exists to prevent. Both directions are asserted, because
    // multiplying a monthly wage by twelve is just as wrong as storing an annual one raw.
    expect(parseSalaryMonthly("2.5 lakh saal ka")?.value).toBe(20833);
    expect(parseSalaryMonthly("2.5 lakh mahina")?.value).toBe(250000);
  });

  it("records nothing when the period cues conflict", () => {
    // "prefer no number over a wrong number" — an unrecorded salary is re-askable next turn.
    expect(parseSalaryMonthly("5 lakh saal ka mahina")).toBeNull();
  });

  it("reads a bare 'saal' BEFORE the amount as experience, not as a period", () => {
    // The asymmetry between annualCuesBefore and annualCuesAfter. Treating this as annual
    // would divide a correct monthly wage by twelve — one wrong number traded for another.
    expect(parseSalaryMonthly("6 saal se 28000 milta hai")?.value).toBe(28000);
    expect(parseSalaryMonthly("28000 saal ka")?.value).toBe(2333);
  });

  it("keeps a period cue on a neighbouring line from scaling the amount", () => {
    expect(parseSalaryMonthly("4 lakh\nsaal ka")?.value).toBe(400000);
  });

  it("splits the current and expected slots, first writer wins in each", () => {
    const both = detectSalaries("abhi 21000 milta hai, 31000 chahiye");
    expect(both.current?.value).toBe(21000);
    expect(both.expected?.value).toBe(31000);
    // A second expected figure does not overwrite the first: correction handling belongs to
    // the orchestrator, which needs to see them as two answers rather than one silent winner.
    expect(detectSalaries("31000 chahiye, 41000 chahiye").expected?.value).toBe(31000);
  });

  it("spans the number itself, not the whitespace the matcher consumed", () => {
    // The matcher's `\s*` eats spaces at both ends. A provenance gate quoting the match span
    // would quote " 27000 " and fail its own substring check against the transcript.
    const hit = parseSalaryMonthly("₹ 27000 milta hai");
    expect(hit?.span).toEqual({ start: 2, end: 7 });
    expect("₹ 27000 milta hai".slice(2, 7)).toBe("27000");
    const withUnit = parseSalaryMonthly("20k mahina milta hai");
    expect("20k mahina milta hai".slice(withUnit!.span.start, withUnit!.span.end)).toBe("20k");
  });

  it("rejects a calendar year unless the text says money", () => {
    expect(parseSalaryMonthly("2015 se kaam kar raha hu")).toBeNull();
    expect(parseSalaryMonthly("2015 rupaye milte hai")?.value).toBe(2015);
  });

  it("rejects a credential id sitting next to its cue, but not a later wage", () => {
    expect(parseSalaryMonthly("roll number 987654 hai")).toBeNull();
    // The false suppression a line scan shipped: a certificate mentioned LATER in the same
    // message must not delete a wage stated earlier. A chat message is a single line.
    expect(parseSalaryMonthly("abhi 25000 milta hai, NCVT certificate hai")?.value).toBe(25000);
  });

  it("requires the unit to end on a word boundary", () => {
    // Without it the bare `k` matched the first letter of "kiya" and recorded ₹4,000.
    expect(parseSalaryMonthly("NSQF level 4 kiya hai")).toBeNull();
    expect(parseSalaryMonthly("level 4 kaam karta hu")).toBeNull();
  });

  it("applies the plausibility ceiling to the MONTHLY figure", () => {
    // 100 lakh = 1 crore/month sits exactly ON the ceiling and is kept; 101 lakh is not.
    expect(parseAmount("100", "lakh")).toBe(10_000_000);
    expect(parseAmount("101", "lakh")).toBeNull();
    // The same annual figure passes, because the ceiling is checked after the division.
    expect(parseAmount("101", "lakh", 12)).toBe(841_666);
  });

  it("accepts Devanagari digits, because the shipped Python already did", () => {
    expect(parseSalaryMonthly("२८००० मिलता है")?.value).toBe(28000);
  });

  it("reports a negated amount rather than swallowing it", () => {
    // Reported, not vetoed: answer capture drops it, a diagnostic surface wants to know the
    // cue was seen AND why it did not count.
    const hit = parseSalaryMonthly("28000 nahi milta");
    expect(hit?.value).toBe(28000);
    expect(hit?.negationVetoed).toBe(true);
  });
});

describe("experience semantics", () => {
  it("prefers the longer compound number", () => {
    // "paune do" is 1.75 and "paune" alone is 0.75 — a different answer, not a rounding.
    expect(parseExperienceYears("paune do saal")?.value).toBe(1.75);
    expect(parseExperienceYears("sava do saal")?.value).toBe(2.25);
    expect(parseExperienceYears("paune saal")?.value).toBe(0.75);
  });

  it("takes the UPPER end of a range, because only that number touches the unit", () => {
    // MEASURED, not assumed. The matcher requires the quantity to sit adjacent to the unit
    // (`\s*\+?\s*` between them), so in "7-8 saal" only the 8 qualifies and the 7 is skipped.
    // A worker who says "7-8 saal" is therefore recorded as 8 — the optimistic end.
    //
    // This is shipped Python behaviour, preserved verbatim and pinned here so a future edit to
    // the matcher cannot change it silently. Whether it SHOULD read 7 is a product decision
    // about how to record an uncertain range, not something to fix inside a refactor.
    expect(parseExperienceYears("7-8 saal")?.value).toBe(8);
    expect(parseExperienceYears("7 se 8 saal")?.value).toBe(8);
    // A single figure with a "+" is unaffected — the "+" is consumed between number and unit.
    expect(parseExperienceYears("5+ years")?.value).toBe(5);
  });

  it("requires a unit", () => {
    expect(parseExperienceYears("part no 7 dekha")).toBeNull();
    expect(parseExperienceYears("7 mahine")).toBeNull();
  });

  it("accepts Devanagari digits", () => {
    expect(parseExperienceYears("५ saal")?.value).toBe(5);
  });
});
