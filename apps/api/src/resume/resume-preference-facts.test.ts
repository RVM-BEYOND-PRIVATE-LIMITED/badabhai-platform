import { describe, expect, it } from "vitest";

import { readPreferenceFacts } from "./resume-preference-facts";
import { buildResumeRenderInput, type TradeSheetContext } from "./resume-render-input";

/** The finishing form's answers, exactly as `loadTradeSheet` returns them. */
const ANSWERED: Record<string, unknown> = {
  languages: ["hindi", "haryanvi", "english"],
  documents_ready: ["aadhaar", "pan", "bank_account", "uan_pf", "iti_certificate"],
  preferred_locations: ["Faridabad", "Gurugram", "Manesar"],
  shift_preference: "rotational",
  job_type: "permanent",
  relocation_willingness: true,
};

const sheet = (attributes: Record<string, unknown>): TradeSheetContext => ({
  packId: null,
  attributes,
});

const rowValue = (
  rows: readonly { label: string; value: string }[] | undefined,
  label: string,
): string | undefined => rows?.find((r) => r.label === label)?.value;

describe("readPreferenceFacts — the form's answers, printed in English", () => {
  it("prints the ratified sheet's own values", () => {
    const facts = readPreferenceFacts(ANSWERED);
    expect(facts.languages).toEqual(["Hindi", "Haryanvi", "English"]);
    expect(facts.documents).toEqual([
      "Aadhaar",
      "PAN",
      "Bank account",
      "UAN / PF",
      "ITI certificate",
    ]);
    // "Rotational shifts · Permanent" is one line on the ratified sheet, not two rows.
    expect(facts.shiftLine).toBe("Rotational shifts · Permanent");
    expect(facts.willingToRelocate).toBe(true);
  });

  it("drops a slug no dictionary knows, rather than printing it raw", () => {
    // `uan_pf` on a printed sheet is worse than an absent row. An option removed from a
    // dictionary must stop printing, never start printing as a slug.
    const facts = readPreferenceFacts({ languages: ["hindi", "klingon"] });
    expect(facts.languages).toEqual(["Hindi"]);
  });

  it("lets either half of the shift line stand alone, with no dangling separator", () => {
    expect(readPreferenceFacts({ shift_preference: "day" }).shiftLine).toBe("Day shift");
    expect(readPreferenceFacts({ job_type: "contract" }).shiftLine).toBe("Contract");
    expect(readPreferenceFacts({}).shiftLine).toBeNull();
  });

  it("keeps UNANSWERED and FALSE apart on the two booleans", () => {
    // Only the positive claim ever prints. `undefined` means nobody asked; `false` means the
    // worker withdrew a claim. Collapsing them would make "not answered" print as a refusal.
    expect(readPreferenceFacts({}).willingToRelocate).toBeUndefined();
    expect(readPreferenceFacts({ relocation_willingness: false }).willingToRelocate).toBe(false);
  });

  it("survives an attribute bag holding the wrong shapes", () => {
    // The bag is `Record<string, unknown>` off a jsonb column, and a pack could write a scalar
    // where this expects a list. A render must degrade to an absent row, never throw and cost
    // the worker the whole PDF.
    const facts = readPreferenceFacts({ languages: "hindi", relocation_willingness: "yes" });
    expect(facts.languages).toEqual([]);
    expect(facts.willingToRelocate).toBeUndefined();
  });
});

describe("the form's answers reach the sheet (R6 §4)", () => {
  it("fills Zone 3 and Zone 5 on the LEGACY branch — the one a real turner takes", () => {
    // `resume_profile` is empty because `profile_extraction` is armed in no compose file, so
    // this is the branch every deterministic worker reaches. Before this wiring the whole
    // AVAILABILITY & TERMS block rendered one row.
    const input = buildResumeRenderInput(
      { availability: { status: "notice_period", notice_period_days: 15 } },
      "Ramesh Kumar Yadav",
      "bb_trade.v1",
      null,
      false,
      "worker",
      sheet(ANSWERED),
    );
    expect(rowValue(input.availFactRows, "Preferred locations")).toBe(
      "Faridabad, Gurugram, Manesar · Willing to relocate",
    );
    expect(rowValue(input.availFactRows, "Shift")).toBe("Rotational shifts · Permanent");
    expect(rowValue(input.qualFactRows, "Languages spoken")).toBe("Hindi · Haryanvi · English");
    expect(input.qualTickRows?.[0]?.values).toContain("ITI certificate");
  });

  it("prints the salary the universal pack asked for — it was captured and then dropped", () => {
    // The defect this closes: `salary_expected` is a universal ask, the crosswalk carries it to
    // the draft, the projection scatters it into `salary_expectation.amount_min`, and this branch
    // passed a hard `null` to the row. §5.1 makes salary one of the four outright rejection
    // filters, so a sheet without it is answering a question the employer asked with silence.
    const input = buildResumeRenderInput(
      { salary_expectation: { amount_min: 24000 } },
      null,
      "bb_trade.v1",
      null,
      false,
      "worker",
      sheet({}),
    );
    expect(rowValue(input.availFactRows, "Salary expected")).toBe("₹24,000 / month");
  });

  it("withholds that salary from the PAYER copy, exactly as the container path does", () => {
    // A worker's asking price is a negotiating position, and moving it into a labelled row must
    // not become a way around the suppression the scalar already has.
    const input = buildResumeRenderInput(
      { salary_expectation: { amount_min: 24000 } },
      null,
      "bb_trade.v1",
      null,
      false,
      "employer",
      sheet({}),
    );
    expect(rowValue(input.availFactRows, "Salary expected")).toBeUndefined();
  });

  it("does not print a relocation refusal the worker never gave", () => {
    const input = buildResumeRenderInput(
      {},
      null,
      "bb_trade.v1",
      null,
      false,
      "worker",
      sheet({ preferred_locations: ["Faridabad"], relocation_willingness: false }),
    );
    expect(rowValue(input.availFactRows, "Preferred locations")).toBe("Faridabad");
  });

  it("leaves every row absent when the form was never answered", () => {
    // The 140-odd trades with no form answers must render exactly as they do today — a label
    // with nothing after it reads as a claim the worker failed to answer.
    const input = buildResumeRenderInput({}, null, "bb_trade.v1", null, false, "worker", sheet({}));
    expect(rowValue(input.availFactRows, "Shift")).toBeUndefined();
    expect(rowValue(input.qualFactRows, "Languages spoken")).toBeUndefined();
    expect(input.qualTickRows).toEqual([]);
  });

  it("the caller-supplied block still wins over the form, per field", () => {
    // `qualification` is the worker's own structured answer on a different surface, and the
    // established precedence is per-field rather than all-or-nothing: supplying languages must
    // not blank the documents the form holds.
    const input = buildResumeRenderInput({}, null, "bb_trade.v1", null, false, "worker", {
      ...sheet(ANSWERED),
      qualification: { languages: ["Tamil"] },
    });
    expect(rowValue(input.qualFactRows, "Languages spoken")).toBe("Tamil");
    expect(input.qualTickRows?.[0]?.values).toContain("Aadhaar");
  });
});
