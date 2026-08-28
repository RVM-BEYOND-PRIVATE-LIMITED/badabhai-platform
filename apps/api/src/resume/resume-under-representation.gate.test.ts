import { describe, expect, it } from "vitest";

import { buildResumeRenderInput } from "./resume-render-input";
import { formatSalaryBand } from "./resume-sheet-rows";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════
 * THE UNDER-REPRESENTATION GATE (R10 R-2) — the one guard in this system pointing the other way.
 * ══════════════════════════════════════════════════════════════════════════════════════
 *
 * THE INVARIANT, stated once:
 *
 *     Where the worker STATED a scalar and the sheet prints a DERIVED one, the printed value may
 *     never be lower than the stated one.
 *
 * WHY IT NEEDED TO EXIST. Every other guard in the résumé path watches for OVER-claim — §8.3's
 * asymmetry rule resolves ambiguity downward, the fabrication gate refuses a string nobody said,
 * the transcript veto withdraws a chip the worker contradicted. All three protect the EMPLOYER
 * from a worker who claims too much. Nothing protected the worker from a sheet that claimed too
 * little on his behalf, and two live defects had already landed in that blind spot:
 *
 *   TOTAL YEARS (R8 §1) — the container branch summed the model's per-employment
 *   `duration_months` instead of reading `experience_years`. Workers who stated 2, 5, 8 and 12
 *   years got "duration not stated", "1 yr 8 mo", "5 yrs 4 mo" and "9 yrs 11 mo".
 *
 *   SALARY (R9 §0.5, R10 R-1) — `profile_extractor.py` wrote CURRENT pay into `amount_min` while
 *   the TypeScript projection wrote EXPECTED pay there, and the mapper prints `amount_min` under
 *   the label "expects". A man asking 16 and earning 14 advertised ₹14,000.
 *
 * NEITHER WAS CATCHABLE BY THE EXISTING GATES, and that is the point rather than an excuse. Every
 * number involved was worker-stated, so set-membership passed and the fabrication gate saw
 * nothing wrong. The defect is not that a value was invented — it is that the WRONG worker-stated
 * value reached a labelled slot. Provenance is not placement.
 *
 * WHY A TEST RATHER THAN A RUNTIME ASSERTION. The rule needs BOTH numbers — the stated one and
 * the derived one — and at runtime the mapper has already chosen. A guard placed after that choice
 * could only re-derive the input it was given, which is the circularity R8 §3 removed from the
 * page gate. So this is a property asserted over the mapper's inputs and outputs, at the boundary
 * where both are visible, and it fails the build rather than logging in production.
 */

/** Parse "8 yrs", "1 yr 6 mo", "duration not stated" back to years, for comparison. */
function yearsFromHeadline(line: string | null | undefined): number | null {
  if (!line || line.includes("duration not stated")) return null;
  const y = /(\d+)\s*yrs?/.exec(line);
  const m = /(\d+)\s*mo/.exec(line);
  if (!y && !m) return null;
  return (y ? Number(y[1]) : 0) + (m ? Number(m[1]) / 12 : 0);
}

/** Parse "₹24,000 – ₹28,000 / month" or "₹16,000 / month" back to its LOWER end. */
function lowerRupees(value: string | null | undefined): number | null {
  if (!value) return null;
  const first = /₹([\d,]+)/.exec(value);
  return first ? Number(first[1]!.replace(/,/g, "")) : null;
}

const CONTAINER = (months: (number | null)[]) => ({
  role_label: "CNC Setter-cum-Operator",
  experiences: months.map((m, i) => ({
    role_label: `Job ${i}`,
    duration_text: "",
    duration_months: m,
    work_done: "turning",
  })),
});

function sheetFor(snapshot: Record<string, unknown>, attributes: Record<string, unknown> = {}) {
  return buildResumeRenderInput(snapshot, "Ramesh Kumar Yadav", "bb_trade", null, false, "worker", {
    packId: "qp_cnc_turning",
    attributes,
  });
}

describe("R10 R-2 — instance 1: total years may never print below the stated figure", () => {
  // The four personas from the R7 run, at the figures they actually stated.
  const CASES = [
    { stated: 2, months: [null], was: "duration not stated" },
    { stated: 5, months: [null, 20], was: "1 yr 8 mo" },
    { stated: 8, months: [null, 12, 29, 23], was: "5 yrs 4 mo" },
    { stated: 12, months: [20, 34, 65], was: "9 yrs 11 mo" },
  ];

  for (const { stated, months, was } of CASES) {
    it(`a worker who stated ${stated} years is never printed lower (was "${was}")`, () => {
      const input = sheetFor({
        experience: { total_years: stated },
        resume_profile: CONTAINER(months),
      });
      const printed = yearsFromHeadline(input.headlineLine);
      expect(printed, "the headline must carry a tenure at all").not.toBeNull();
      expect(printed!).toBeGreaterThanOrEqual(stated);
      expect(input.experienceYears).toBeGreaterThanOrEqual(stated);
    });
  }

  it("holds as a PROPERTY across the range, not just on the four measured cases", () => {
    // The gate is an invariant, so it is asserted over a sweep rather than over the examples that
    // happened to be found. Every combination here has a sum strictly below the stated figure —
    // which is the shape the defect took every time.
    for (let stated = 1; stated <= 40; stated += 1) {
      for (const months of [[null], [1], [6, 6], [12], [null, 3]]) {
        const input = sheetFor({
          experience: { total_years: stated },
          resume_profile: CONTAINER(months),
        });
        expect(input.experienceYears, `stated=${stated} months=${months}`).toBeGreaterThanOrEqual(
          stated,
        );
      }
    }
  });

  it("still prints nothing when there is no stated figure AND no sum", () => {
    // The gate is a FLOOR, not a requirement to invent. §11 #3's genuine unknown survives.
    const input = sheetFor({ experience: {}, resume_profile: CONTAINER([null]) });
    expect(input.experienceYears).toBeNull();
    expect(input.headlineLine).toContain("duration not stated");
  });
});

describe("R10 R-2 — instance 2: salary may never print below the stated figure", () => {
  it("prints the ASKING price, never the current wage (the live defect)", () => {
    // Persona 2's words: "abhi 14 hazaar mil rahe hain, 16 chahiye". Before R10 the legacy branch
    // printed ₹14,000 under the label "expects".
    const input = sheetFor({ salary_expectation: { amount_min: 16000 } });
    expect(lowerRupees(input.availFactRows?.find((r) => r.label === "Salary expected")?.value))
      .toBe(16000);
  });

  it("a band's LOWER end is never below the stated minimum", () => {
    for (const [min, max] of [
      [16000, 20000],
      [24000, 28000],
      [32000, null],
    ] as const) {
      const printed = lowerRupees(formatSalaryBand(min, max));
      expect(printed, `${min}-${max}`).toBeGreaterThanOrEqual(min);
    }
  });

  it("a contradictory band collapses to the MINIMUM, never to the smaller of the two", () => {
    // max < min is a data error. Printing "₹20,000 – ₹18,000" is nonsense; printing ₹18,000 alone
    // would be the one direction this gate forbids. The half the worker is certain about wins.
    expect(formatSalaryBand(20000, 18000)).toBe("₹20,000 / month");
    expect(lowerRupees(formatSalaryBand(20000, 18000))!).toBeGreaterThanOrEqual(20000);
  });

  it("prints NOTHING rather than a wrong number when nothing was stated", () => {
    // R-1: "Until the band ships, print nothing rather than the wrong number." §8.4 — a field with
    // no value collapses.
    expect(formatSalaryBand(null, null)).toBeNull();
    const input = sheetFor({ salary_expectation: {} });
    expect(input.availFactRows?.some((r) => r.label === "Salary expected")).toBe(false);
  });
});

describe("R10 R-2 — instance 3: the derived tenure of an employment", () => {
  it("never prints a total below the sum of the roles inside it", () => {
    // The third known instance, and the only one that was already correct: an employer's months
    // are computed from its own span, and the role stints inside it are computed from theirs. A
    // promotion whose stints span the whole employment must not total less than the employment.
    const input = buildResumeRenderInput(
      { experience: { total_years: 4 } },
      "R",
      "bb_trade",
      null,
      false,
      "worker",
      {
        packId: "qp_cnc_turning",
        attributes: {},
        asOf: new Date("2026-08-27T00:00:00Z"),
        employments: [
          {
            employer: "Harsha Precision",
            employerCity: "Faridabad",
            employerState: "Haryana",
            startYm: "2022-09",
            endYm: null,
            durationStated: true,
            roles: [
              { roleLabel: "Setter", startYm: "2024-04", endYm: null, workDone: null },
              { roleLabel: "Turner", startYm: "2022-09", endYm: "2024-03", workDone: null },
            ],
          },
        ],
      },
    );
    const emp = input.employments![0]!;
    const monthsIn = (s: string) => {
      const y = /(\d+)\s*yrs?/.exec(s);
      const m = /(\d+)\s*mo/.exec(s);
      return (y ? Number(y[1]) * 12 : 0) + (m ? Number(m[1]) : 0);
    };
    const total = monthsIn(emp.when);
    const roleSum = emp.roles.reduce((n, r) => n + monthsIn(r.when), 0);
    expect(total).toBeGreaterThanOrEqual(roleSum);
  });
});

describe("R10 R-2 — the gate itself is capable of failing", () => {
  it("would catch a mapper that preferred the sum over the stated figure", () => {
    // THE MUTATION BAR, expressed as a positive check rather than by editing the source: the
    // property above is only evidence if a wrong mapper would break it. `totalYearsFrom`'s output
    // for the measured personas IS strictly below their stated figures, so a mapper returning it
    // fails `toBeGreaterThanOrEqual(stated)` on every one of the four cases.
    const summedFor = (months: (number | null)[]) => {
      const kept = months.filter((m): m is number => typeof m === "number" && m > 0);
      return kept.length === 0 ? null : Math.round((kept.reduce((a, b) => a + b, 0) / 12) * 10) / 10;
    };
    expect(summedFor([null])).toBeNull();
    expect(summedFor([null, 20])!).toBeLessThan(5);
    expect(summedFor([null, 12, 29, 23])!).toBeLessThan(8);
    expect(summedFor([20, 34, 65])!).toBeLessThan(12);
  });
});
