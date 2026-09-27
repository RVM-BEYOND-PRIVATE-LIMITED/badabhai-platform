import { describe, expect, it } from "vitest";

import { GENERAL_FORM_BRIEF_MAX_CHARS } from "@badabhai/types";

import {
  composeFallbackBrief,
  FALLBACK_BRIEF_MAX_SKILLS,
  ownBriefUsable,
  vetOwnBrief,
  type FallbackBriefFacts,
} from "./resume-brief";

/**
 * ═══ THE BRIEF UNDER THE HEADLINE (ADR-0045 R6, §4.3) ═══
 *
 * Two pure rules. The fallback line is a CLOSED grammar over facts already on the page — every
 * sentence below is spelled out literally, so a word added to the grammar fails here before it
 * reaches a worker's sheet. The re-check decides whether the worker's own stored line may still
 * print, against his CURRENT name and the money wall.
 */

const SKILLS = ["Wiring", "Panel work", "MCB fitting", "Earthing"] as const;

function facts(over: Partial<FallbackBriefFacts> = {}): FallbackBriefFacts {
  return {
    role: "Electrician",
    years: null,
    fresher: false,
    employmentsReadable: true,
    skills: SKILLS,
    ...over,
  };
}

describe("composeFallbackBrief — the first sentence that applies", () => {
  it("years known, skills: {R} with {Y} of experience in {S}.", () => {
    // Y is written as the headline writes it: 4.2 years is "4 yrs 2 mo".
    expect(composeFallbackBrief(facts({ years: 4.2 }))).toBe(
      "Electrician with 4 yrs 2 mo of experience in Wiring, Panel work and MCB fitting.",
    );
    expect(composeFallbackBrief(facts({ years: 1 }))).toBe(
      "Electrician with 1 yr of experience in Wiring, Panel work and MCB fitting.",
    );
    expect(composeFallbackBrief(facts({ years: 0.5 }))).toBe(
      "Electrician with 6 mo of experience in Wiring, Panel work and MCB fitting.",
    );
  });

  it("years known, no skills: {R} with {Y} of experience.", () => {
    expect(composeFallbackBrief(facts({ years: 8, skills: [] }))).toBe(
      "Electrician with 8 yrs of experience.",
    );
  });

  it("fresher, skills: Fresher {R} with skills in {S}.", () => {
    expect(composeFallbackBrief(facts({ fresher: true }))).toBe(
      "Fresher Electrician with skills in Wiring, Panel work and MCB fitting.",
    );
  });

  it("jobs exist but some undated, skills: {R} with skills in {S}.", () => {
    expect(composeFallbackBrief(facts({ years: null, fresher: false }))).toBe(
      "Electrician with skills in Wiring, Panel work and MCB fitting.",
    );
  });

  it("names at most the first three skills, joined 'A, B and C' / 'A and B' / 'A'", () => {
    expect(FALLBACK_BRIEF_MAX_SKILLS).toBe(3);
    expect(composeFallbackBrief(facts({ fresher: true, skills: ["Wiring", "Panel work"] }))).toBe(
      "Fresher Electrician with skills in Wiring and Panel work.",
    );
    expect(composeFallbackBrief(facts({ fresher: true, skills: ["Wiring"] }))).toBe(
      "Fresher Electrician with skills in Wiring.",
    );
    // Blanks are not skills and do not take a slot.
    expect(composeFallbackBrief(facts({ fresher: true, skills: [" ", "Wiring", ""] }))).toBe(
      "Fresher Electrician with skills in Wiring.",
    );
  });

  it("otherwise null: a fresher or undated worker with no skills has no sentence", () => {
    expect(composeFallbackBrief(facts({ fresher: true, skills: [] }))).toBeNull();
    expect(composeFallbackBrief(facts({ skills: [] }))).toBeNull();
  });

  it("null when the employment read FAILED — the grammar is not widened to cover it", () => {
    // ADR-0045 §4.3 licenses "{R} with skills in {S}." for jobs that exist and are undated, never
    // for jobs nobody could read.
    expect(composeFallbackBrief(facts({ employmentsReadable: false }))).toBeNull();
    expect(composeFallbackBrief(facts({ employmentsReadable: false, years: 3 }))).toBeNull();
  });

  it("null with no role — a line about nobody is not a line", () => {
    expect(composeFallbackBrief(facts({ role: null, years: 3 }))).toBeNull();
    expect(composeFallbackBrief(facts({ role: "   ", fresher: true }))).toBeNull();
  });
});

describe("composeFallbackBrief — the 160 code-point cap", () => {
  const long = (n: number) => "S".repeat(n);

  it("drops skills FROM THE END until the sentence fits — never truncates a word", () => {
    // "Fresher Electrician with skills in " is 35 code points and "." is one more.
    const [a, b, c] = [long(40), long(40), long(40)];
    const out = composeFallbackBrief(facts({ fresher: true, skills: [a, b, c] }));
    expect(out).toBe(`Fresher Electrician with skills in ${a} and ${b}.`);
    expect([...out!].length).toBeLessThanOrEqual(GENERAL_FORM_BRIEF_MAX_CHARS);
  });

  it("a with-skills sentence left with no skill falls to the next that applies", () => {
    const huge = long(200);
    // Years: to the no-skill sentence.
    expect(composeFallbackBrief(facts({ years: 3, skills: [huge] }))).toBe(
      "Electrician with 3 yrs of experience.",
    );
    // Fresher and undated have no next sentence: null.
    expect(composeFallbackBrief(facts({ fresher: true, skills: [huge] }))).toBeNull();
    expect(composeFallbackBrief(facts({ skills: [huge] }))).toBeNull();
  });

  it("exactly 160 code points prints; 161 does not", () => {
    const prefix = "Fresher Electrician with skills in ";
    const fits = long(GENERAL_FORM_BRIEF_MAX_CHARS - prefix.length - 1);
    expect(composeFallbackBrief(facts({ fresher: true, skills: [fits] }))).toBe(
      `${prefix}${fits}.`,
    );
    expect(composeFallbackBrief(facts({ fresher: true, skills: [`${fits}S`] }))).toBeNull();
  });

  it("counts code points, not UTF-16 units — a Devanagari skill costs what it prints", () => {
    const hindi = "क".repeat(100);
    const out = composeFallbackBrief(facts({ fresher: true, skills: [hindi] }));
    expect(out).toBe(`Fresher Electrician with skills in ${hindi}.`);
  });

  it("a role too long for even the shortest sentence yields null", () => {
    expect(composeFallbackBrief(facts({ role: long(170), years: 3, skills: [] }))).toBeNull();
  });
});

describe("vetOwnBrief — may the worker's stored line still print?", () => {
  it("passes a clean line, with or without a stored name", () => {
    expect(vetOwnBrief("Ghar aur dukaan ki wiring karta hoon, 12 saal.", null)).toBe(true);
    expect(vetOwnBrief("Ghar aur dukaan ki wiring karta hoon.", "Ramesh Kumar")).toBe(true);
    expect(vetOwnBrief("मैं 5 साल से वेल्डिंग का काम कर रहा हूँ।", "रमेश यादव")).toBe(true);
  });

  it("fails a line that carries the worker's CURRENT name — any 3+ character token, any case", () => {
    expect(vetOwnBrief("Ramesh 8 saal se electrician", "Ramesh Kumar")).toBe(false);
    expect(vetOwnBrief("kumar ji, electrician", "Ramesh Kumar")).toBe(false);
    expect(vetOwnBrief("मैं रमेश हूँ, वेल्डर", "रमेश यादव")).toBe(false);
    // THE NAME CHANGE the write-time screen could not see: the line passed against "Ramesh", and
    // the worker is "Suresh" now.
    expect(vetOwnBrief("Suresh bhai ka kaam, wiring", "Ramesh Kumar")).toBe(true);
    expect(vetOwnBrief("Suresh bhai ka kaam, wiring", "Suresh Kumar")).toBe(false);
    // Word-anchored, as the redactor matches.
    expect(vetOwnBrief("Rampur mein wiring", "Ram Singh")).toBe(true);
  });

  it("fails money — the write wall's own predicate", () => {
    expect(vetOwnBrief("Wiring karta hoon, 15k chahiye", null)).toBe(false);
    expect(vetOwnBrief("Salary achhi ho", null)).toBe(false);
    expect(vetOwnBrief("₹20,000 per month", null)).toBe(false);
    expect(vetOwnBrief("10 saal ka experience hai", null)).toBe(true);
  });

  it("fails what cleanScalar would change or drop: padding, an email, a phone-shaped run", () => {
    expect(vetOwnBrief(" Wiring karta hoon", null)).toBe(false);
    expect(vetOwnBrief("Wiring karta hoon ", null)).toBe(false);
    expect(vetOwnBrief("mail ramesh@example.com", null)).toBe(false);
    expect(vetOwnBrief("call 98765 43210", null)).toBe(false);
    expect(vetOwnBrief("", null)).toBe(false);
  });

  it("fails a line longer than the write bound, in code points", () => {
    expect(vetOwnBrief("a".repeat(GENERAL_FORM_BRIEF_MAX_CHARS), null)).toBe(true);
    expect(vetOwnBrief("a".repeat(GENERAL_FORM_BRIEF_MAX_CHARS + 1), null)).toBe(false);
    expect(vetOwnBrief("क".repeat(GENERAL_FORM_BRIEF_MAX_CHARS), null)).toBe(true);
  });
});

describe("ownBriefUsable — the stored row, narrowed and vetted", () => {
  it("true only for an ANSWERED brief that passes the re-check", () => {
    expect(ownBriefUsable({ status: "answered", text: "Wiring karta hoon" }, null)).toBe(true);
    expect(ownBriefUsable({ status: "answered", text: "Ramesh, wiring" }, "Ramesh Kumar")).toBe(
      false,
    );
    expect(ownBriefUsable({ status: "answered", text: "15k chahiye" }, null)).toBe(false);
  });

  it("false for a decline, a missing row and a damaged row — each prints the fallback line", () => {
    expect(ownBriefUsable({ status: "declined" }, null)).toBe(false);
    expect(ownBriefUsable(undefined, null)).toBe(false);
    expect(ownBriefUsable({ status: "answered" }, null)).toBe(false);
    expect(ownBriefUsable("Wiring karta hoon", null)).toBe(false);
  });
});
