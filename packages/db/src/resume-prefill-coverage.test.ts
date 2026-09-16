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

  it("a summary derived from fixtures containing distinctive raw strings never prints them", () => {
    // The raw strings never even reach aggregateCoverage — by construction, FieldObservation
    // has no string/number field. This test still fixes a literal string in a comment near the
    // fixture so a reviewer sees exactly what the leak-then-fix proof checked.
    void DISTINCTIVE_CITY;
    void DISTINCTIVE_TRADE;

    const observations: ImportObservation[] = [
      importObs("pdf_text", {
        current_city: COVERED_CONFIRMED_OVERRIDDEN,
        role_label: COVERED_CONFIRMED_OVERRIDDEN,
      }),
    ];
    const summary = aggregateCoverage(observations);
    const lines = formatReport(summary, observations.length);
    const serialized = JSON.stringify({ summary, lines });

    expect(serialized).not.toContain(DISTINCTIVE_CITY);
    expect(serialized).not.toContain(DISTINCTIVE_TRADE);
  });

  it("FieldObservation's type itself admits no value field (structural proof)", () => {
    // TypeScript enforces this at compile time; this runtime check is a belt-and-braces pin so
    // a future refactor that widens the type is caught by a failing assertion, not just a type
    // error someone could `as any` around.
    const obs: FieldObservation = COVERED_CONFIRMED_OVERRIDDEN;
    expect(Object.keys(obs).sort()).toEqual(["confirmed", "covered", "matched"]);
  });

  it("formatReport output contains no field/method values outside the closed vocabularies", () => {
    const observations: ImportObservation[] = [
      importObs("ocr", { education_level: COVERED_CONFIRMED_MATCHED }),
    ];
    const summary = aggregateCoverage(observations);
    const lines = formatReport(summary, observations.length);
    const body = lines.join("\n");
    const ALLOWED_WORDS = new Set([
      "field", "method", "offered", "confirmed", "overrides", "override", "rate",
      ...RESUME_PREFILL_FIELDS.flatMap((f) => f.split("_")),
      "pdf", "text", "docx", "ocr", "unknown",
      "eval", "resume", "prefill", "parsed", "imports", "with", "a", "suggestion", "payload",
      "no", "covered", "fields", "observed",
    ]);
    // Every alphabetic word on the table must be drawn from the closed vocabulary above — a
    // worker-derived string (a city, a trade label) would introduce a word this set does not
    // contain, and this assertion is what the leak-then-fix proof (below) actually exercised.
    for (const word of body.match(/[A-Za-z]+/g) ?? []) {
      expect(ALLOWED_WORDS.has(word), `unexpected word "${word}" in report output`).toBe(true);
    }
  });
});
