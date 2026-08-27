import { describe, expect, it } from "vitest";

import {
  buildAvailabilityRows,
  buildQualificationRows,
  buildVerdictLine,
} from "./resume-sheet-rows";

const FULL = {
  role: "CNC Turner (Setter-cum-Operator)",
  years: 8,
  tools: ["Fanuc", "Siemens", "Mitsubishi"],
  city: "Faridabad",
  availability: "15 days",
  salary: "₹24,000 – ₹28,000 / month",
};

describe("the Verdict Line (§6.2)", () => {
  it("composes both lines the way the ratified sheet reads", () => {
    expect(buildVerdictLine(FULL)).toEqual({
      headlineLine: "CNC Turner (Setter-cum-Operator) · 8 yrs · Fanuc, Siemens, Mitsubishi",
      subheadLine: "Faridabad · available in 15 days · expects ₹24,000 – ₹28,000 / month",
    });
  });

  it("DROPS an empty segment WITH its separator, never leaving a dangling dot", () => {
    // The rule the guideline states outright, and the one sparse profiles exercise on every
    // render. A leading "· " on a printed résumé reads as a defect in the product.
    const noCity = buildVerdictLine({ ...FULL, city: null });
    expect(noCity.subheadLine).toBe("available in 15 days · expects ₹24,000 – ₹28,000 / month");
    expect(noCity.subheadLine).not.toMatch(/^\s*·/);

    const noSalary = buildVerdictLine({ ...FULL, salary: null });
    expect(noSalary.subheadLine).toBe("Faridabad · available in 15 days");
    expect(noSalary.subheadLine).not.toMatch(/·\s*$/);

    const middle = buildVerdictLine({ ...FULL, availability: null });
    expect(middle.subheadLine).toBe("Faridabad · expects ₹24,000 – ₹28,000 / month");
    expect(middle.subheadLine).not.toMatch(/·\s+·/);
  });

  it("collapses to null when a whole line has nothing, so the strip can hide", () => {
    const empty = buildVerdictLine({
      role: null,
      years: null,
      tools: [],
      city: null,
      availability: null,
      salary: null,
    });
    // The years segment is never empty — an unknown is STATED — so the headline survives.
    expect(empty.headlineLine).toBe("duration not stated");
    expect(empty.subheadLine).toBeNull();
  });

  it('renders an unknown tenure as "duration not stated" — never a guess, never "fresher"', () => {
    // §11 #3 and §6.2 together: never estimated, never rounded, never silently omitted, and
    // never "fresher" — that word is reserved for a worker who SAID they have no experience.
    // Inferring it from a missing number puts a claim on the page its author never made.
    for (const years of [null, 0, -1, Number.NaN]) {
      const line = buildVerdictLine({ ...FULL, years })!.headlineLine!;
      expect(line, `years=${years}`).toContain("duration not stated");
      expect(line).not.toMatch(/fresher/i);
      expect(line).not.toMatch(/0 yrs?/);
    }
  });

  it("pluralises and carries months", () => {
    expect(buildVerdictLine({ ...FULL, years: 1 }).headlineLine).toContain("1 yr ·");
    expect(buildVerdictLine({ ...FULL, years: 2 }).headlineLine).toContain("2 yrs ·");
    expect(buildVerdictLine({ ...FULL, years: 1.5 }).headlineLine).toContain("1 yr 6 mo");
  });

  it("caps the tool list at three, because a longer one stops being scannable", () => {
    const many = buildVerdictLine({
      ...FULL,
      tools: ["Fanuc", "Siemens", "Mitsubishi", "Haas", "Mazak"],
    });
    expect(many.headlineLine).toContain("Fanuc, Siemens, Mitsubishi");
    expect(many.headlineLine).not.toContain("Haas");
  });

  it("says 'available immediately', not 'available in Immediate'", () => {
    expect(buildVerdictLine({ ...FULL, availability: "Immediate" }).subheadLine).toContain(
      "available immediately",
    );
    expect(buildVerdictLine({ ...FULL, availability: "immediately" }).subheadLine).toContain(
      "available immediately",
    );
  });
});

describe("availability & terms rows", () => {
  it("emits only the rows that have a value", () => {
    expect(
      buildAvailabilityRows({
        availability: "15 days",
        salary: "₹24,000 / month",
        preferredLocations: ["Faridabad", "Gurugram"],
        willingToRelocate: true,
        shift: "Rotational shifts",
      }),
    ).toEqual([
      { label: "Available from", value: "15 days" },
      { label: "Salary expected", value: "₹24,000 / month" },
      { label: "Preferred locations", value: "Faridabad, Gurugram · Willing to relocate" },
      { label: "Shift", value: "Rotational shifts" },
    ]);
  });

  it("prints NO relocation claim when the worker did not make one", () => {
    // Silence is what a résumé says about every preference nobody asserted. "Will not relocate"
    // is a refusal the worker never gave, and it costs them postings.
    const rows = buildAvailabilityRows({
      availability: null,
      salary: null,
      preferredLocations: ["Pune"],
      willingToRelocate: false,
      shift: null,
    });
    expect(rows).toEqual([{ label: "Preferred locations", value: "Pune" }]);
    expect(JSON.stringify(rows)).not.toMatch(/relocat/i);
  });

  it("returns nothing at all when the worker stated no terms", () => {
    expect(
      buildAvailabilityRows({
        availability: null,
        salary: null,
        preferredLocations: [],
        shift: null,
      }),
    ).toEqual([]);
  });
});

describe("qualification rows", () => {
  it("folds the level headline and the entries into one quiet Education line", () => {
    expect(
      buildQualificationRows({
        educationHeadline: "ITI — Machinist",
        education: ["NCVT · 2018 · Govt. ITI, Faridabad"],
        certifications: ["CNC / Turning Programming & Setting (RVM CAD, 2021)"],
        languages: ["Hindi", "Haryanvi", "English"],
      }),
    ).toEqual([
      { label: "Education", value: "ITI — Machinist · NCVT · 2018 · Govt. ITI, Faridabad" },
      { label: "Certificates", value: "CNC / Turning Programming & Setting (RVM CAD, 2021)" },
      { label: "Languages spoken", value: "Hindi · Haryanvi · English" },
    ]);
  });

  it("says NOTHING about a missing credential (§11 #2)", () => {
    // Twelve years on the machine and no ITI is frequently our most valuable worker. The row is
    // absent; nothing flags it, nothing apologises for it, and the capability block carries the
    // page instead.
    const rows = buildQualificationRows({
      educationHeadline: null,
      education: [],
      certifications: [],
      languages: ["Hindi"],
    });
    expect(rows).toEqual([{ label: "Languages spoken", value: "Hindi" }]);
    expect(JSON.stringify(rows)).not.toMatch(/none|not stated|n\/a/i);
  });
});
