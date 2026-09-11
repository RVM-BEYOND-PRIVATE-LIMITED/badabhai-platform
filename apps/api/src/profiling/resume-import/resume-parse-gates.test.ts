import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ParsedField, ResumeEmployment, TargetField } from "@badabhai/ai-contracts";

import {
  HARD_IDENTIFIER_CLASSES,
  applyResumeParseGates,
  containsHardIdentifier,
  filterEmployments,
  resumeValueCertifier,
} from "./resume-parse-gates";

/**
 * THE SECOND WALL FOR A RÉSUMÉ PARSE (ADR-0041 RI-3).
 *
 * The most important test in this file is the fixture one: the hard-identifier rule exists in
 * two languages, and two implementations of one privacy rule drift. `test_resume_parse.py`
 * reads the SAME fixture, so a case added there fails whichever side has not implemented it.
 *
 * The second most important is the pair that asserts what the wall PERMITS. ADR-0041 D5
 * authorises employer names; a wall that refuses "Tata Motors Ltd" would be deleted by
 * whoever first tried to ship the feature, and then nothing would be checking for PANs
 * either.
 */

const FIXTURE = join(
  __dirname,
  "../../../../../packages/ai-contracts/src/__fixtures__/hard-identifiers.cases.json",
);

interface Case {
  text: string;
  expected: string | null;
}

function loadCases(): Case[] {
  const parsed = JSON.parse(readFileSync(FIXTURE, "utf8")) as { cases: Case[] };
  return parsed.cases;
}

function field(value: unknown, quote = "CNC Turner"): ParsedField {
  return {
    value,
    evidence: { message_index: 0, quote },
    source: "transcript",
    normalization: "verbatim",
    confidence: 0.9,
  };
}

const CITY: TargetField = {
  field_id: "current_city",
  type: "string",
  enum: null,
  unit: null,
  required: false,
};
const YEARS: TargetField = {
  field_id: "experience_years",
  type: "number",
  enum: null,
  unit: null,
  required: false,
};

function employment(overrides: Partial<ResumeEmployment> = {}): ResumeEmployment {
  return {
    employer_name: "Tata Motors Ltd",
    role_title: "CNC Turner",
    start_year: 2019,
    end_year: 2023,
    evidence: { message_index: 0, quote: "Tata Motors Ltd" },
    ...overrides,
  };
}

describe("the hard-identifier wall agrees with the ai-service, case for case", () => {
  const cases = loadCases();

  it("the fixture is not empty and covers both verdicts (guards the loader, not the rule)", () => {
    // Without this, a fixture that failed to parse — or one that only listed refusals —
    // would make every assertion below pass vacuously.
    expect(cases.length).toBeGreaterThan(20);
    expect(cases.some((c) => c.expected !== null)).toBe(true);
    expect(cases.some((c) => c.expected === null)).toBe(true);
  });

  it.each(loadCases())("$text -> $expected", ({ text, expected }) => {
    expect(containsHardIdentifier(text)).toBe(expected);
  });

  it("every class the fixture expects is one this side declares", () => {
    const expectedClasses = new Set(
      cases.map((c) => c.expected).filter((value): value is string => value !== null),
    );
    for (const name of expectedClasses) {
      expect(HARD_IDENTIFIER_CLASSES).toContain(name);
    }
  });
});

describe("the certifier", () => {
  it("blocks a value carrying a hard identifier", () => {
    expect(resumeValueCertifier("PAN ABCDE1234F").blocked).toBe(true);
  });

  it("permits an employer name, which is the whole point of ruling D5", () => {
    expect(resumeValueCertifier("Tata Motors Ltd").blocked).toBe(false);
  });

  it("never rewrites the value", () => {
    // Gate 6 rejects on altered as well as blocked. Returning a rewritten string would
    // record that the worker's résumé said something it did not.
    for (const text of ["Tata Motors Ltd", "PAN ABCDE1234F", "1200000"]) {
      expect(resumeValueCertifier(text).text).toBe(text);
    }
  });

  it("takes no policy argument, so it cannot be pointed at the input masking policy", () => {
    // STRUCTURAL, not a convention — the same assertion the Python suite makes. A
    // `PiiCertifier` and a masker have the same shape, so one extra parameter here would
    // make RESUME_PARSE_RAW_TEXT_ENABLED a switch that disables the output wall.
    expect(resumeValueCertifier.length).toBe(1);
  });
});

describe("re-gating scalar fields before anything is persisted", () => {
  it("drops a value carrying a PAN, whatever the far side decided", () => {
    const result = applyResumeParseGates({ current_city: field("PAN ABCDE1234F", "PAN ABCDE1234F") }, [
      CITY,
    ]);
    expect(result.accepted.current_city).toBeUndefined();
    expect(result.rejections.some((r) => r.gate === "pii")).toBe(true);
  });

  it("keeps an honest value — the half that gets deleted if it is not asserted", () => {
    const result = applyResumeParseGates({ current_city: field("Pune", "Pune") }, [CITY]);
    expect(result.accepted.current_city?.value).toBe("Pune");
  });

  it("drops a field nobody asked for", () => {
    const result = applyResumeParseGates({ aadhaar_number: field("x") }, [CITY]);
    expect(result.accepted.aadhaar_number).toBeUndefined();
    expect(result.rejections.some((r) => r.gate === "vocabulary")).toBe(true);
  });

  it("drops a number outside the declared range", () => {
    const result = applyResumeParseGates({ experience_years: field(400, "400") }, [YEARS]);
    expect(result.accepted.experience_years).toBeUndefined();
    expect(result.rejections.some((r) => r.gate === "type_range")).toBe(true);
  });

  it("a null field is an honest 'nothing citable', not a rejection", () => {
    const result = applyResumeParseGates({ current_city: null }, [CITY]);
    expect(result.accepted.current_city).toBeUndefined();
    expect(result.rejections).toHaveLength(0);
  });
});

describe("employment rows", () => {
  it("keeps an honest row", () => {
    const { kept, rejected } = filterEmployments([employment()]);
    expect(kept).toHaveLength(1);
    expect(rejected).toBe(0);
  });

  it("drops a row whose employer name carries a phone number", () => {
    const { kept, rejected } = filterEmployments([
      employment({ employer_name: "Tata Motors 9876543210" }),
    ]);
    expect(kept).toHaveLength(0);
    expect(rejected).toBe(1);
  });

  it("drops a row whose ROLE TITLE carries a phone number", () => {
    // `employer_name` is not the only string on the row.
    const { kept, rejected } = filterEmployments([
      employment({ role_title: "CNC Turner 9876543210" }),
    ]);
    expect(kept).toHaveLength(0);
    expect(rejected).toBe(1);
  });

  it("drops a stint that ends before it starts", () => {
    const { kept } = filterEmployments([employment({ start_year: 2023, end_year: 2019 })]);
    expect(kept).toHaveLength(0);
  });

  it("drops a row naming neither an employer nor a role", () => {
    const { kept } = filterEmployments([
      employment({ employer_name: null, role_title: null }),
    ]);
    expect(kept).toHaveLength(0);
  });

  it("keeps a row with only one of the two names", () => {
    // Testing what the rule PERMITS: a résumé that lists a role and no employer is common,
    // and refusing it would silently halve the coverage this feature exists to deliver.
    const { kept } = filterEmployments([employment({ employer_name: null })]);
    expect(kept).toHaveLength(1);
  });
});
