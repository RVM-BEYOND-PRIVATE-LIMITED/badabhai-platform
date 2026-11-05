import { describe, expect, it } from "vitest";

import { parseExperienceTotal } from "./experience-total";

describe("parseExperienceTotal — the experience question's general-keyboard replies", () => {
  it("reads years as before (Hinglish, English, digits)", () => {
    expect(parseExperienceTotal("5 saal")?.value).toBe(5);
    expect(parseExperienceTotal("paanch saal ka experience")?.value).toBe(5);
    expect(parseExperienceTotal("3 years")?.value).toBe(3);
    expect(parseExperienceTotal("dedh saal")?.value).toBe(1.5);
  });

  it("keeps years and months like {x} years and {y} months, as fractional years", () => {
    expect(parseExperienceTotal("2 saal 6 mahine")?.value).toBe(2.5);
    expect(parseExperienceTotal("1 saal 6 mahine")?.value).toBe(1.5);
    expect(parseExperienceTotal("6 mahine")?.value).toBe(0.5);
    expect(parseExperienceTotal("8 mahine")?.value).toBeCloseTo(0.67, 2);
    expect(parseExperienceTotal("3 months")?.value).toBe(0.25);
  });

  it("reads days as a small fraction of a year", () => {
    expect(parseExperienceTotal("10 din")?.value).toBeCloseTo(0.03, 2);
    expect(parseExperienceTotal("1 saal 10 din")?.value).toBeCloseTo(1.03, 2);
  });

  it("returns null for rubbish, questions and fresher words (owned elsewhere)", () => {
    expect(parseExperienceTotal("bakwaas kar rahe ho")).toBeNull();
    expect(parseExperienceTotal("sir job milegi kya?")).toBeNull();
    expect(parseExperienceTotal("fresher")).toBeNull();
    expect(parseExperienceTotal("5")).toBeNull();
    expect(parseExperienceTotal("")).toBeNull();
  });

  it("covers the whole tenure in its span, so the negation veto applies", () => {
    const reading = parseExperienceTotal("2 saal 6 mahine");
    expect(reading?.span).toBeDefined();
    expect("2 saal 6 mahine".slice(reading!.span.start, reading!.span.end)).toContain("6 mahine");
  });
});
