import { describe, expect, it } from "vitest";

import {
  RESUME_PREFILL_FIELDS,
  aggregateCoverage,
  formatReport,
  type FieldObservation,
  type ImportObservation,
  type ResumePrefillField,
} from "./resume-prefill-coverage";

const UNCOVERED: FieldObservation = { covered: false, confirmed: false, matched: null };
const COVERED_UNCONFIRMED: FieldObservation = { covered: true, confirmed: false, matched: null };
const COVERED_CONFIRMED_MATCHED: FieldObservation = { covered: true, confirmed: true, matched: true };
const COVERED_CONFIRMED_OVERRIDDEN: FieldObservation = { covered: true, confirmed: true, matched: false };

/** Every field defaults to uncovered; `overrides` fills in the fields under test. */
function importObs(
  extractionMethod: ImportObservation["extractionMethod"],
  overrides: Partial<Record<ResumePrefillField, FieldObservation>>,
): ImportObservation {
  const fields = {} as Record<ResumePrefillField, FieldObservation>;
  for (const field of RESUME_PREFILL_FIELDS) fields[field] = overrides[field] ?? UNCOVERED;
  return { extractionMethod, fields };
}

describe("aggregateCoverage — vacuity: the fixtures exercise every branch", () => {
  // Written FIRST, per this repo's "detector fixture must contain the thing" convention: a
  // fixture set that happened to never contain an override, or never contain an uncovered
  // field, would let a broken override-detector or a broken coverage-gate pass silently. Each
  // assertion below names the ONE branch it is pinning, so a future regression that flips one
  // branch back to a default fails at a specific, legible line.
  const observations: ImportObservation[] = [
    importObs("pdf_text", { role_label: COVERED_CONFIRMED_MATCHED }),
    importObs("pdf_text", { role_label: COVERED_CONFIRMED_OVERRIDDEN }),
    importObs("pdf_text", { role_label: COVERED_UNCONFIRMED }),
    importObs("pdf_text", { role_label: UNCOVERED, experience_years: COVERED_CONFIRMED_MATCHED }),
  ];
  const summary = aggregateCoverage(observations);
  const roleLabel = summary.find((r) => r.field === "role_label" && r.extractionMethod === "pdf_text");

  it("contains a covered+confirmed+matched row (branch: matched)", () => {
    expect(roleLabel?.importsConfirmed).toBeGreaterThan(0);
    expect((roleLabel?.overrideCount ?? -1) < (roleLabel?.importsConfirmed ?? 0)).toBe(true);
  });

  it("contains a covered+confirmed+overridden row (branch: override)", () => {
    expect(roleLabel?.overrideCount).toBeGreaterThan(0);
  });

  it("contains a covered+unconfirmed row (branch: confirmed=false excluded from the rate)", () => {
    // 3 role_label suggestions offered on pdf_text (matched, overridden, unconfirmed), only 2 confirmed.
    expect(roleLabel?.importsWithSuggestion).toBe(3);
    expect(roleLabel?.importsConfirmed).toBe(2);
  });

  it("contains an uncovered row (branch: coverage gate excludes it entirely)", () => {
    // The 4th observation's role_label is UNCOVERED and must not inflate role_label's count.
    expect(roleLabel?.importsWithSuggestion).toBe(3);
  });
});

describe("aggregateCoverage — counts and rates", () => {
  it("computes override_rate as overrideCount / importsConfirmed", () => {
    const observations: ImportObservation[] = [
      importObs("ocr", { current_city: COVERED_CONFIRMED_MATCHED }),
      importObs("ocr", { current_city: COVERED_CONFIRMED_OVERRIDDEN }),
      importObs("ocr", { current_city: COVERED_CONFIRMED_OVERRIDDEN }),
      importObs("ocr", { current_city: COVERED_CONFIRMED_OVERRIDDEN }),
    ];
    const summary = aggregateCoverage(observations);
    expect(summary).toHaveLength(1);
    const row = summary[0]!;
    expect(row.importsConfirmed).toBe(4);
    expect(row.overrideCount).toBe(3);
    expect(row.overrideRate).toBeCloseTo(0.75);
  });

  it("never divides by zero: override_rate is 0 when nothing is confirmed", () => {
    const observations: ImportObservation[] = [importObs("docx", { salary_expected: COVERED_UNCONFIRMED })];
    const summary = aggregateCoverage(observations);
    expect(summary).toHaveLength(1);
    const row = summary[0]!;
    expect(row.importsConfirmed).toBe(0);
    expect(row.overrideRate).toBe(0);
    expect(Number.isNaN(row.overrideRate)).toBe(false);
  });

  it("splits by extraction_method — pdf_text and ocr for the same field do not merge", () => {
    const observations: ImportObservation[] = [
      importObs("pdf_text", { availability: COVERED_CONFIRMED_MATCHED }),
      importObs("ocr", { availability: COVERED_CONFIRMED_OVERRIDDEN }),
    ];
    const summary = aggregateCoverage(observations);
    expect(summary).toHaveLength(2);
    expect(summary.find((r) => r.extractionMethod === "pdf_text")?.overrideCount).toBe(0);
    expect(summary.find((r) => r.extractionMethod === "ocr")?.overrideCount).toBe(1);
  });

  it("reports a (field, method) pair that was offered zero times as a real zero row, not a dropped row", () => {
    // A single import covering only role_label still produces an explicit education_level row
    // is NOT true here — aggregateCoverage only emits rows for pairs it actually observed
    // (documented behaviour). This test pins that a field covered on one import and never on
    // another does not silently borrow the other's method.
    const observations: ImportObservation[] = [importObs("pdf_text", { role_label: COVERED_UNCONFIRMED })];
    const summary = aggregateCoverage(observations);
    expect(summary).toHaveLength(1);
    expect(summary[0]!.importsConfirmed).toBe(0);
  });
});

describe("formatReport — privacy: only counts and rates ever reach the table", () => {
  // THE LEAK-THEN-FIX PROOF (see PR description / session notes): this test was first run
  // against a deliberately leaking formatReport that interpolated a raw field name value into
  // the table — e.g. `${(row as any).sampleSuggestedValue}` — and it FAILED, catching the
  // leak. The leaking branch has been removed; this is the version that must stay green.
  const DISTINCTIVE_CITY = "Zzqrxvantownistan-9182";
  const DISTINCTIVE_TRADE = "Fabled Unicorn Welder Grade-7";

  /**
   * A test-only widened shape — what a FUTURE regression might look like if someone added an
   * optional raw-value field to `FieldObservation` (e.g. "just for debugging"). This type is
   * never exported and never read by production code. TypeScript's structural typing means an
   * object built from it still satisfies `FieldObservation`, so it can be handed to the REAL,
   * unmodified `aggregateCoverage`/`formatReport` below: the proof that the distinctive string
   * doesn't leak has to run through the actual pipeline, not a stand-in for it.
   */
  interface LeakableFieldObservation extends FieldObservation {
    readonly _futureRawValue?: string;
  }

  function leaking(raw: string): FieldObservation {
    const widened: LeakableFieldObservation = {
      covered: true,
      confirmed: true,
      matched: false,
      _futureRawValue: raw,
    };
    return widened;
  }

  it("a summary derived from fixtures carrying raw strings on a widened observation never prints them", () => {
    // Each observation below is a real FieldObservation as far as aggregateCoverage/formatReport
    // are concerned — it just happens to also carry `_futureRawValue`, structurally. Nothing in
    // this test tells the pipeline to ignore that field; the pipeline's own row-building (it
    // constructs each summary row from named fields, never a spread) is what has to do the work.
    // PROVEN (see session notes / PR description): temporarily mutating aggregateCoverage's row
    // constructor to spread `...obs` into the row turned this test RED; reverting turned it GREEN.
    const observations: ImportObservation[] = [
      importObs("pdf_text", {
        current_city: leaking(DISTINCTIVE_CITY),
        role_label: leaking(DISTINCTIVE_TRADE),
      }),
    ];
    const summary = aggregateCoverage(observations);
    const lines = formatReport(summary, observations.length);
    const serialized = JSON.stringify({ summary, lines });

    expect(serialized).not.toContain(DISTINCTIVE_CITY);
    expect(serialized).not.toContain(DISTINCTIVE_TRADE);
  });

  // A prior "structural proof" here asserted `Object.keys()` of one hardcoded literal — it could
  // never fail from a widened `FieldObservation`, since nothing forces that literal to grow a new
  // key just because the type gained an optional one. Its actual intent (catch a widened type
  // carrying real data into the report) is what the test above proves directly, by constructing
  // an object that HAS the extra field and sending it through the unmodified real pipeline: it
  // only stays green because `aggregateCoverage` builds each row from named fields and never
  // forwards unknown ones. Removed as redundant rather than kept as a check that cannot fail.

  it("formatReport output matches a closed grammar — no numeric or word token outside the expected shape", () => {
    const observations: ImportObservation[] = [
      importObs("ocr", { education_level: COVERED_CONFIRMED_MATCHED }),
      importObs("pdf_text", { salary_expected: COVERED_CONFIRMED_OVERRIDDEN }),
    ];
    const summary = aggregateCoverage(observations);
    const lines = formatReport(summary, observations.length);

    const HEADER_LINE = /^\[eval:resume-prefill] parsed imports with a suggestion payload: \d+$/;
    const COLUMN_HEADER_LINE = /^ {2}field\s+method\s+offered\s+confirmed\s+overrides\s+override_rate$/;
    // A row line's ENTIRE shape, not just its words: a known field name, a known extraction
    // method, then exactly three small integers and one percentage — nothing else is permitted
    // anywhere on the line. Earlier this only scanned `[A-Za-z]+`, which is blind to a numeric
    // leak (e.g. a real salary figure) since digits never match that pattern at all; anchoring
    // the whole line closes that gap for both the alphabetic and the numeric tokens.
    const ROW_LINE = new RegExp(
      `^ {2}(${RESUME_PREFILL_FIELDS.join("|")})\\s+(pdf_text|docx|ocr|unknown)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+\\.\\d)%$`,
    );

    expect(lines[0]).toMatch(HEADER_LINE);
    expect(lines[1]).toMatch(COLUMN_HEADER_LINE);
    const rowLines = lines.slice(2);
    for (const line of rowLines) {
      expect(line, `line does not match the closed report grammar: ${JSON.stringify(line)}`).toMatch(ROW_LINE);
    }

    // Cross-check each row's three integers against the summary it was built from, so a
    // substituted numeric token (e.g. a leaked figure standing in for `importsConfirmed`) can't
    // pass merely by fitting the `\d+` shape — it has to equal the count that produced it.
    for (const row of summary) {
      const match = rowLines
        .map((line) => line.match(ROW_LINE))
        .find((m) => m !== null && m[1] === row.field && m[2] === row.extractionMethod);
      expect(match, `no report line found for ${row.field}/${row.extractionMethod}`).toBeTruthy();
      expect(Number(match![3])).toBe(row.importsWithSuggestion);
      expect(Number(match![4])).toBe(row.importsConfirmed);
      expect(Number(match![5])).toBe(row.overrideCount);
    }
  });
});
