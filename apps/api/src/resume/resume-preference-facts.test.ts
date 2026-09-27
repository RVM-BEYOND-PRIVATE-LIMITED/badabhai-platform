import { describe, expect, it } from "vitest";

import { formAvailabilityLabel, readPreferenceFacts } from "./resume-preference-facts";
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

/**
 * ADR-0045 §3.4 — THE GENERAL ROAD'S "Available from" ROW, phrased for a page read LATER than it
 * was written: the employer copy renders live, possibly months after the answer. The rules are the
 * owner's (2026-09-27), first match wins.
 */
describe("formAvailabilityLabel — the general road's Available from row", () => {
  // Noon in India on 27 Sep 2026 — and 06:30 UTC, the same day on both clocks.
  const NOON_IST = new Date("2026-09-27T06:30:00Z");
  const label = (availability: Record<string, unknown>, asOf: Date | null = NOON_IST) =>
    formAvailabilityLabel(readPreferenceFacts({ availability }), asOf);

  it("a date still ahead prints 'From <day> <Mon> <year>', the day unpadded", () => {
    expect(label({ available_from: "2026-10-12" })).toBe("From 12 Oct 2026");
    expect(label({ available_from: "2026-11-02" })).toBe("From 2 Nov 2026");
    // The sheet's own month spelling, never ICU's ("Sept" on current builds).
    expect(label({ available_from: "2026-09-28" })).toBe("From 28 Sep 2026");
  });

  it("a date already reached — past or today — prints Immediately", () => {
    expect(label({ available_from: "2026-09-01" })).toBe("Immediately");
    expect(label({ available_from: "2026-09-27" })).toBe("Immediately");
  });

  it("today is the RENDER DAY IN INDIA, not in UTC", () => {
    // 20:00 UTC on the 27th is already 01:30 on the 28th in India: the 28th has begun.
    const lateUtc = new Date("2026-09-27T20:00:00Z");
    expect(label({ available_from: "2026-09-28" }, lateUtc)).toBe("Immediately");
    expect(label({ available_from: "2026-09-29" }, lateUtc)).toBe("From 29 Sep 2026");
  });

  it("the date wins over the status — it is the more specific statement", () => {
    expect(
      label({ status: "serving_notice", notice_period_days: 30, available_from: "2026-10-26" }),
    ).toBe("From 26 Oct 2026");
    expect(label({ status: "within_month", available_from: "2026-09-01" })).toBe("Immediately");
  });

  it("a status alone prints its vocabulary label, notice with its days", () => {
    expect(label({ status: "immediate" })).toBe("Immediately");
    expect(label({ status: "within_week" })).toBe("Within a week");
    expect(label({ status: "within_month" })).toBe("Within a month");
    expect(label({ status: "serving_notice", notice_period_days: 30 })).toBe(
      "Serving notice (30 days)",
    );
    expect(label({ status: "serving_notice", notice_period_days: 1 })).toBe(
      "Serving notice (1 day)",
    );
    expect(label({ status: "serving_notice" })).toBe("Serving notice");
    expect(label({ status: "serving_notice", notice_period_days: 0 })).toBe("Serving notice");
  });

  it("nothing answered, an unknown status or a date no calendar has: null (the caller falls back)", () => {
    expect(label({})).toBeNull();
    expect(label({ status: "not_looking" })).toBeNull();
    expect(label({ available_from: "2026-02-31" })).toBeNull();
    expect(formAvailabilityLabel(readPreferenceFacts({}), NOON_IST)).toBeNull();
  });

  it("with no clock no date is judged — the status decides, and a bare date prints nothing", () => {
    expect(label({ available_from: "2026-10-12" }, null)).toBeNull();
    expect(label({ status: "within_week", available_from: "2026-10-12" }, null)).toBe(
      "Within a week",
    );
  });
});

describe("readPreferenceFacts — the band's lower end and the status slug (ADR-0045)", () => {
  it("reads salary_expected_min beside salary_expected_max", () => {
    const facts = readPreferenceFacts({ salary_expected_min: 18000, salary_expected_max: 22000 });
    expect(facts.salaryMin).toBe(18000);
    expect(facts.salaryMax).toBe(22000);
    expect(readPreferenceFacts({}).salaryMin).toBeNull();
  });

  it("narrows the status slug to the vocabulary, exactly as its label is narrowed", () => {
    expect(readPreferenceFacts({ availability: { status: "serving_notice" } })).toMatchObject({
      availabilityStatus: "serving_notice",
      availabilityStatusLabel: "Serving notice",
    });
    expect(readPreferenceFacts({ availability: { status: "not_looking" } })).toMatchObject({
      availabilityStatus: null,
      availabilityStatusLabel: null,
    });
  });

  it("prints the lower end on no sheet off the road — a pack-less worker's row is unchanged", () => {
    // The key is read for every sheet; only the general road prints it.
    const input = buildResumeRenderInput(
      {},
      null,
      "bb_general",
      null,
      false,
      "worker",
      sheet({ salary_expected_min: 18000 }),
    );
    expect(rowValue(input.availFactRows, "Salary expected")).toBeUndefined();
  });
});
