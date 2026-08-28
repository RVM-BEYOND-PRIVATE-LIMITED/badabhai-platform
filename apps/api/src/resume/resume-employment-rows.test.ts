import { describe, expect, it } from "vitest";

import {
  buildEmploymentBlock,
  EMPLOYMENT_BLOCK_BUDGET,
  type WorkerEmploymentRecord,
} from "./resume-employment-rows";

/**
 * ZONE 4 against the guideline's own edge-case table (§11). Each `describe` names the ruling it
 * enforces, so a failure points at the clause rather than at a string.
 *
 * SEEDED RECORDS, NOT A DATABASE. Nothing writes `worker_employment` yet — the capture surface
 * is blocked on an owner ruling — and that blocks the WRITER only. These fixtures are the shapes
 * the writer will produce, so the render block is verified today and the capture surface lands
 * against a block that is already known to be correct.
 */

const AS_OF = new Date("2026-08-28T00:00:00Z");

function employment(over: Partial<WorkerEmploymentRecord> = {}): WorkerEmploymentRecord {
  return {
    employer: "Sandhar Technologies",
    employerCity: "Gurugram",
    employerState: "Haryana",
    startYm: "2023-01",
    endYm: null,
    durationStated: true,
    roles: [
      { roleLabel: "CNC Turner", startYm: null, endYm: null, workDone: "CNC turning, Fanuc" },
    ],
    ...over,
  };
}

describe("§11 #3 — duration unknown", () => {
  it("prints the literal, never an estimate", () => {
    const { employments } = buildEmploymentBlock(
      [employment({ startYm: null, endYm: null, durationStated: false })],
      { asOf: AS_OF },
    );
    expect(employments[0]!.when).toBe("Duration not stated");
  });

  it("never rounds a missing duration into a number", () => {
    // The failure this guards is the tempting one: a worker who said "kuch saal" acquiring a
    // tenure figure nobody stated, on a sheet an employer treats as fact.
    const { employments } = buildEmploymentBlock(
      [employment({ startYm: null, durationStated: false })],
      { asOf: AS_OF },
    );
    expect(employments[0]!.when).not.toMatch(/\d/);
  });

  it("distinguishes CURRENT from UNSTATED — the two states a null end date cannot separate", () => {
    // `endYm: null` with `durationStated: true` is "still there", which is a real fact and prints
    // as one. Collapsing the two would make an honest gap indistinguishable from a live job.
    const current = buildEmploymentBlock([employment({ endYm: null })], { asOf: AS_OF });
    expect(current.employments[0]!.when).toBe("Jan 2023 – Present · 3 yrs 8 mo");
  });
});

describe("§11 #4 — contract or thekedar work, no company name", () => {
  it("renders whatever capture resolved, and never a blank employer", () => {
    // The column is NOT NULL and capture has already decided between the site and the literal
    // "Contract work" — this file must never invent one, and must never print an empty name.
    const { employments } = buildEmploymentBlock(
      [
        employment({
          employer: "Contract work",
          employerCity: "Manesar",
          employerState: null,
          roles: [
            { roleLabel: "Turner", startYm: null, endYm: null, workDone: "Job-shop turning" },
          ],
        }),
      ],
      { asOf: AS_OF },
    );
    expect(employments[0]!.employer).toBe("Contract work");
    expect(employments[0]!.location_suffix).toBe(" · Manesar");
  });

  it("drops the separator with an absent location, never leaving a stray dot", () => {
    const { employments } = buildEmploymentBlock(
      [employment({ employerCity: null, employerState: null })],
      { asOf: AS_OF },
    );
    expect(employments[0]!.location_suffix).toBe("");
  });
});

describe("§11 #5 — employment gaps", () => {
  it("renders the spans as they are, with no explanation and no filler label", () => {
    // "The employer draws his own conclusion." A generated "career break" line would be exactly
    // the composed prose §8 forbids, and it would editorialise about a worker's own history.
    const { employments, employmentsMore } = buildEmploymentBlock(
      [
        employment({ employer: "Rico Auto", startYm: "2024-06", endYm: null }),
        // A 26-month hole sits between these two. Nothing may mention it.
        employment({ employer: "Munjal Showa", startYm: "2019-02", endYm: "2022-04" }),
      ],
      { asOf: AS_OF },
    );
    const printed = JSON.stringify({ employments, employmentsMore });
    expect(printed).not.toMatch(/gap|break|unemploy|gap year|sabbatical/i);
    expect(employments[0]!.when).toBe("Jun 2024 – Present · 2 yrs 3 mo");
    expect(employments[1]!.when).toBe("Feb 2019 – Apr 2022 · 3 yrs 3 mo");
  });
});

describe("§11 #6 — nine employers in four years", () => {
  const NINE: WorkerEmploymentRecord[] = [
    ["2026-05", "2026-08"],
    ["2026-01", "2026-04"],
    ["2025-08", "2025-12"],
    ["2025-03", "2025-07"],
    ["2024-11", "2025-02"],
    ["2024-06", "2024-10"],
    ["2024-01", "2024-05"],
    ["2023-06", "2023-12"],
    ["2022-09", "2023-05"],
  ].map(([startYm, endYm], i) =>
    employment({
      employer: `Employer ${i + 1}`,
      startYm,
      endYm,
      roles: [{ roleLabel: "Turner", startYm: null, endYm: null, workDone: null }],
    }),
  );

  it("shows months for each of the four it renders", () => {
    const { employments } = buildEmploymentBlock(NINE, { asOf: AS_OF });
    for (const e of employments) expect(e.when).toMatch(/\d+ (yrs?|mo)/);
  });

  it("does not score job-hopping typographically — one grammar at every tenure length", () => {
    // The ruling is explicit that job-hopping is scored nowhere in the system "and must not be
    // scored typographically either". A short stint must not acquire a rendering a long one does
    // not get: no bracket, no asterisk, no "only", no marker that fires under twelve months.
    // Dropping a zero-years component ("4 mo" vs "10 yrs 4 mo") is arithmetic, not emphasis, so
    // the property asserted is ONE GRAMMAR rather than one literal shape.
    const SPAN =
      /^[A-Z][a-z]{2} \d{4} – (?:[A-Z][a-z]{2} \d{4}|Present)(?: · (?:\d+ yrs? )?(?:\d+ mo)?)?$/;
    const spans = [
      ["2026-05", "2026-08"], // 4 months
      ["2025-08", "2026-08"], // 13 months
      ["2016-05", "2026-08"], // 10 years
      ["2016-05", null], // current
    ].map(
      ([startYm, endYm]) =>
        buildEmploymentBlock([employment({ startYm, endYm })], { asOf: AS_OF }).employments[0]!
          .when,
    );
    for (const span of spans) {
      expect(span, `${span} broke the single span grammar`).toMatch(SPAN);
      expect(span, `${span} carries a typographic marker`).not.toMatch(/[()[\]*"'!<>]|only|short/i);
    }
    // The tenure tail is present at BOTH ends, so brevity never costs a worker the number.
    expect(spans[0]).toContain("4 mo");
    expect(spans[2]).toContain("10 yrs 4 mo");
  });
});

describe("§11 #7 — more than four employers", () => {
  const SIX: WorkerEmploymentRecord[] = [
    ["2024-01", null],
    ["2022-03", "2023-11"],
    ["2020-06", "2022-01"],
    ["2018-09", "2020-04"],
    ["2016-02", "2018-07"], // dropped
    ["2014-05", "2015-12"], // dropped
  ].map(([startYm, endYm], i) => employment({ employer: `Employer ${i + 1}`, startYm, endYm }));

  it("renders exactly four in full", () => {
    const { employments } = buildEmploymentBlock(SIX, { asOf: AS_OF });
    expect(employments).toHaveLength(4);
    expect(employments.map((e) => e.employer)).toEqual([
      "Employer 1",
      "Employer 2",
      "Employer 3",
      "Employer 4",
    ]);
    expect(EMPLOYMENT_BLOCK_BUDGET).toBe(4);
  });

  it("collapses the remainder to ONE counted line — never a silent drop", () => {
    // 2016-02..2018-07 is 30 months; 2014-05..2015-12 is 20. The count is what stops the sheet
    // lying by omission about a worker's tenure.
    const { employmentsMore } = buildEmploymentBlock(SIX, { asOf: AS_OF });
    expect(employmentsMore).toBe("2 earlier employers · 50 months total · 2014–2018");
  });

  it("prints the count but NOT a total when a dropped employment has no stated duration", () => {
    // A "total" that quietly excludes rows reads as complete and is therefore a false number on
    // a printed page. The count still prints, so nothing is silently dropped.
    const withUnstated = [
      ...SIX,
      employment({ employer: "Employer 7", startYm: null, endYm: null, durationStated: false }),
    ];
    expect(buildEmploymentBlock(withUnstated, { asOf: AS_OF }).employmentsMore).toBe(
      "3 earlier employers",
    );
  });

  it("says 'employer' in the singular for exactly one overflow row", () => {
    const five = SIX.slice(0, 5);
    expect(buildEmploymentBlock(five, { asOf: AS_OF }).employmentsMore).toBe(
      "1 earlier employer · 30 months total · 2016–2018",
    );
  });

  it("has no tail at all at or below the budget", () => {
    expect(buildEmploymentBlock(SIX.slice(0, 4), { asOf: AS_OF }).employmentsMore).toBeNull();
    expect(buildEmploymentBlock([], { asOf: AS_OF }).employmentsMore).toBeNull();
  });
});

describe("§11 #14 — promoted within one employer", () => {
  const PROMOTED = employment({
    employer: "Sandhar Technologies",
    startYm: "2021-04",
    endYm: null,
    roles: [
      {
        roleLabel: "Setter-cum-Operator",
        startYm: "2023-08",
        endYm: null,
        workDone: "Setting and first-piece approval",
      },
      {
        roleLabel: "CNC Operator",
        startYm: "2021-04",
        endYm: "2023-07",
        workDone: "CNC turning, Fanuc",
      },
    ],
  });

  it("is ONE employer block with two dated function lines", () => {
    const { employments } = buildEmploymentBlock([PROMOTED], { asOf: AS_OF });
    expect(employments).toHaveLength(1);
    expect(employments[0]!.roles).toEqual([
      { role: "Setter-cum-Operator", when: "Aug 2023 – Present · 3 yrs 1 mo" },
      { role: "CNC Operator", when: "Apr 2021 – Jul 2023 · 2 yrs 4 mo" },
    ]);
  });

  it("keeps the EMPLOYMENT's own continuous span on the block", () => {
    // This is the whole signal: five continuous years at one company, not two shorter jobs.
    const { employments } = buildEmploymentBlock([PROMOTED], { asOf: AS_OF });
    expect(employments[0]!.when).toBe("Apr 2021 – Present · 5 yrs 5 mo");
  });

  it("puts a single un-promoted role ON the employer line instead of under it", () => {
    // One employer, one role, one range. Repeating the range below reads as a second identical
    // fact; giving the title a line of its own costs a line in a zone that has 24% of the page,
    // and that line is what pushed shapes 5, 6 and 9 onto a SECOND PAGE — measured in WeasyPrint,
    // not guessed.
    //
    // R10 §2.5 rule 1 TRIED THE SAMPLE'S SHAPE AND MEASURED IT BACK OUT. Merging the role into
    // the detail line keeps the same LINE COUNT but makes that line longer, and on a
    // fully-answered turner it wraps: the parity sheet went from `degradationStage: 0` to STAGE 2,
    // shedding the Languages row and two materials chips. The placement is not affordable at
    // `SHEET_LINE_BUDGET = 41`, which R9 §5 measured as un-raiseable. See the parity contract.
    const { employments } = buildEmploymentBlock(
      [
        employment({
          startYm: "2021-04",
          endYm: "2024-02",
          roles: [
            { roleLabel: "CNC Turner", startYm: "2021-04", endYm: "2024-02", workDone: "Turning" },
          ],
        }),
      ],
      { asOf: AS_OF },
    );
    expect(employments[0]!.when).toBe("Apr 2021 – Feb 2024 · 2 yrs 11 mo");
    expect(employments[0]!.role_inline).toBe(" — CNC Turner");
    expect(employments[0]!.roles).toEqual([]);
  });

  it("KEEPS the dated function lines for a real promotion — the inline case must not swallow it", () => {
    // The condition is "exactly one stint AND it renders no dates". A promotion fails both
    // halves, and this is the assertion that stops a future page-budget squeeze from flattening
    // §11 #14 into one line and turning five years at one company into a job-hop.
    const { employments } = buildEmploymentBlock([PROMOTED], { asOf: AS_OF });
    expect(employments[0]!.role_inline).toBe("");
    expect(employments[0]!.roles).toHaveLength(2);
  });

  it("keeps a lone role's OWN line when its dates differ from the employment's", () => {
    // A worker who joined in 2019 but only took this title in 2022 has stated two facts. One
    // stint, but not an inline one — the date is real and may not be dropped to save a line.
    const { employments } = buildEmploymentBlock(
      [
        employment({
          startYm: "2019-01",
          endYm: null,
          roles: [{ roleLabel: "Setter", startYm: "2022-06", endYm: null, workDone: "Setting" }],
        }),
      ],
      { asOf: AS_OF },
    );
    expect(employments[0]!.role_inline).toBe("");
    expect(employments[0]!.roles).toEqual([
      { role: "Setter", when: "Jun 2022 – Present · 4 yrs 3 mo" },
    ]);
  });

  it("keeps BOTH work-done lines when a promotion changed what the worker did", () => {
    const { employments } = buildEmploymentBlock([PROMOTED], { asOf: AS_OF });
    expect(employments[0]!.work).toBe("Setting and first-piece approval · CNC turning, Fanuc");
  });

  it("de-duplicates an unchanged work-done line rather than printing it twice", () => {
    const sameWork = employment({
      roles: [
        { roleLabel: "Senior Turner", startYm: "2024-01", endYm: null, workDone: "CNC turning" },
        { roleLabel: "Turner", startYm: "2022-01", endYm: "2023-12", workDone: "CNC turning" },
      ],
    });
    expect(buildEmploymentBlock([sameWork], { asOf: AS_OF }).employments[0]!.work).toBe(
      "CNC turning",
    );
  });
});

describe("§11 #15 — Gulf and overseas experience", () => {
  it("renders the country", () => {
    const { employments } = buildEmploymentBlock(
      [
        employment({
          employer: "Al Faris Engineering",
          employerCity: "Dubai",
          employerState: "UAE",
        }),
      ],
      { asOf: AS_OF },
    );
    expect(employments[0]!.location_suffix).toBe(" · Dubai, UAE");
  });
});

describe("tenure arithmetic", () => {
  it("counts both bounds — a job held in one calendar month is one month, not zero", () => {
    const { employments } = buildEmploymentBlock(
      [employment({ startYm: "2025-03", endYm: "2025-03" })],
      { asOf: AS_OF },
    );
    expect(employments[0]!.when).toBe("Mar 2025 – Mar 2025 · 1 mo");
  });

  it("prints months alone under a year, and years alone on an exact year", () => {
    const under = buildEmploymentBlock([employment({ startYm: "2025-01", endYm: "2025-11" })], {
      asOf: AS_OF,
    });
    expect(under.employments[0]!.when).toBe("Jan 2025 – Nov 2025 · 11 mo");
    const exact = buildEmploymentBlock([employment({ startYm: "2024-01", endYm: "2024-12" })], {
      asOf: AS_OF,
    });
    expect(exact.employments[0]!.when).toBe("Jan 2024 – Dec 2024 · 1 yr");
  });

  it("prints the span with NO tenure when there is no clock to close an open-ended job", () => {
    // Absence rather than a default: a tenure figure is a number, and §8 forbids printing one
    // nobody can source. `new Date()` inside the mapper would also make it impure.
    const { employments } = buildEmploymentBlock([employment({ endYm: null })]);
    expect(employments[0]!.when).toBe("Jan 2023 – Present");
  });

  it("falls back to the literal for a malformed stored month the CHECK would have rejected", () => {
    const { employments } = buildEmploymentBlock([employment({ startYm: "2023-13" })], {
      asOf: AS_OF,
    });
    expect(employments[0]!.when).toBe("Duration not stated");
  });
});
