import { describe, expect, it } from "vitest";
import type { ParsedField, ResumeEmployment, TargetField } from "@badabhai/ai-contracts";

import {
  CONTROL_CHARACTER_REFUSAL,
  applyResumeParseGates,
  containsHardIdentifier,
  filterEmployments,
  resumeValueCertifier,
} from "./resume-parse-gates";

/**
 * THE G1 FLOOR WITHHOLDS A VALUE CARRYING A CONTROL CHARACTER (issue #2064, risks-register R59).
 *
 * PARITY: `contains_hard_identifier` in `apps/ai-service/app/pseudonymize.py` (#1984, PR #2061)
 * and its `tests/test_output_walls_control_chars.py`. Any Unicode `Cc` other than TAB / LF / CR
 * is refused as `control_character`; those three read as a space; `Cf` (ZWJ / ZWNJ) is untouched.
 * The cross-language cases also live in the shared `hard-identifiers.cases.json`, which both
 * suites read. The values below are fabricated.
 */

const NUL = String.fromCharCode(0x00);
const NEL = String.fromCharCode(0x85);
const ZWJ = "‍";

/** The far side's `_CONTROL_CHAR_RE`, written out — what `\p{Cc}` must equal. */
function isFarSideCc(codePoint: number): boolean {
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}

const LAYOUT = new Set([0x09, 0x0a, 0x0d]);

describe("containsHardIdentifier refuses a non-layout control character", () => {
  it.each([
    ["the issue's NUL-split phone", `call 9876${NUL}543210`],
    ["the issue's NUL-split email", `anil${NUL}@example.com`],
    ["the issue's NEL-split skill label", `W${NEL}elding, Anil Kumar`],
    ["SOH", `W${String.fromCharCode(0x01)}elding`],
    ["DEL", `Fitter${String.fromCharCode(0x7f)}ITI`],
    ["the last C1", `Fitter${String.fromCharCode(0x9f)}`],
    ["a lone control character", NUL],
  ])("%s", (_label, text) => {
    expect(containsHardIdentifier(text)).toBe(CONTROL_CHARACTER_REFUSAL);
  });

  it("refuses every Cc but TAB/LF/CR, and nothing else, over all of Unicode", () => {
    // Pins `\p{Cc}` in the running engine to the far side's `[\x00-\x1f\x7f-\x9f]`: a code point
    // refused here that the far side reads (or the reverse) fails this, not a fixture case.
    const mismatches: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const refused =
        containsHardIdentifier(`a${String.fromCodePoint(cp)}b`) === CONTROL_CHARACTER_REFUSAL;
      const expected = isFarSideCc(cp) && !LAYOUT.has(cp);
      if (refused !== expected) mismatches.push(cp.toString(16));
    }
    expect(mismatches).toEqual([]);
  });
});

describe("TAB, LF and CR read as a space, so a split identifier is still caught", () => {
  it.each([
    ["tab-split phone", "call 98765\t43210", "phone"],
    ["CRLF-split phone", "call 98765\r\n43210", "phone"],
    ["LF-split Aadhaar", "1234\n5678\n9012", "aadhaar"],
    ["tab before a PAN", "PAN\tABCDE1234F", "pan"],
    ["CR before an email", "mail\ranil@example.com", "email"],
  ])("%s", (_label, text, expected) => {
    expect(containsHardIdentifier(text)).toBe(expected);
  });

  it("keeps a multi-line value with no identifier", () => {
    expect(containsHardIdentifier("CNC Turner\r\nTata Motors Ltd\t2019-2023")).toBeNull();
  });
});

describe("Cf is untouched", () => {
  it("keeps a Devanagari conjunct shaped with a ZWJ", () => {
    // क्‍ष — the half-form conjunct; ZWNJ likewise.
    expect(containsHardIdentifier(`क्${ZWJ}षेत्र काम`)).toBeNull();
    expect(containsHardIdentifier("क्‌ष")).toBeNull();
  });

  it("still reads through a ZWJ inside an identifier", () => {
    expect(containsHardIdentifier(`9876${ZWJ}543210`)).toBe("phone");
  });
});

describe("a refusal is never read as clean by the walls that call it", () => {
  const CITY: TargetField = {
    field_id: "current_city",
    type: "string",
    enum: null,
    unit: null,
    required: false,
  };

  function field(value: unknown, quote: string): ParsedField {
    return {
      value,
      evidence: { message_index: 0, quote },
      source: "transcript",
      normalization: "verbatim",
      confidence: 0.9,
    };
  }

  it("the résumé certifier blocks it", () => {
    expect(resumeValueCertifier(`call 9876${NUL}543210`).blocked).toBe(true);
    expect(resumeValueCertifier("Pune").blocked).toBe(false);
  });

  it("gate 6 drops a field whose VALUE or cited SPAN carries one", () => {
    const result = applyResumeParseGates(
      {
        current_city: field(`Pu${NEL}ne`, "Pune"),
      },
      [CITY],
    );
    expect(result.accepted).toEqual({});
    expect(result.rejections).toEqual([
      expect.objectContaining({ fieldId: "current_city", gate: "pii" }),
    ]);

    const span = applyResumeParseGates(
      { current_city: field("Pune", `Pune ${NUL}anil@example.com`) },
      [CITY],
    );
    expect(span.accepted).toEqual({});
  });

  it("an employment row carrying one is dropped", () => {
    const row: ResumeEmployment = {
      employer_name: `Tata${NEL}Motors Ltd`,
      role_title: "CNC Turner",
      start_year: 2019,
      end_year: 2023,
      evidence: { message_index: 0, quote: "Tata Motors Ltd" },
    };
    expect(filterEmployments([row])).toEqual({ kept: [], rejected: 1 });
  });
});
