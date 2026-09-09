import { describe, expect, it } from "vitest";

import { buildFresherRows, tenureStatusLabel } from "./resume-fresher-rows";
import { buildResumeRenderInput } from "./resume-render-input";

/**
 * R10 §2.6. §11 #1: "Training, trade test, machines used in the ITI workshop and project work
 * occupy Zone 4. Never render an empty History heading." Persona 1 — a fresh ITI pass-out —
 * measured 125 mm of blank page because nothing in the corpus asked a fresher any of it.
 */
describe("buildFresherRows", () => {
  const FULL = {
    iti_workshop_machines: ["conventional_lathe", "cnc_lathe", "milling"],
    trade_test_status: "passed",
    iti_project_work: "Stepped shaft aur bush banaya tha",
  };

  it("fills Zone 4 from the four things §11 #1 names", () => {
    const rows = buildFresherRows("qp_cnc_turning", FULL);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe("ITI workshop training");
    expect(rows[0]!.work).toBe(
      "Conventional lathe · CNC lathe / turning centre · Milling machine · " +
        "Trade test passed · Stepped shaft aur bush banaya tha",
    );
  });

  it("prints the project in the worker's OWN words, untranslated", () => {
    // §8's third permitted source. Nothing here passes through a model.
    expect(buildFresherRows("qp_cnc_turning", FULL)[0]!.work).toContain(
      "Stepped shaft aur bush banaya tha",
    );
  });

  it("says nothing about a trade test not yet taken", () => {
    // §8.3's asymmetry rule applied to a credential: "has not yet taken it" is true, costs the
    // worker the interview, and tells the employer nothing he would not already assume.
    const rows = buildFresherRows("qp_cnc_turning", { ...FULL, trade_test_status: "not_yet" });
    expect(rows[0]!.work).not.toContain("Trade test");
    // …but a test SAT and awaiting a result is a real thing he did.
    const waiting = buildFresherRows("qp_cnc_turning", { ...FULL, trade_test_status: "appeared" });
    expect(waiting[0]!.work).toContain("Trade test taken, result awaited");
  });

  it("drops a machine slug the dictionary does not know", () => {
    const rows = buildFresherRows("qp_cnc_turning", {
      iti_workshop_machines: ["conventional_lathe", "spaceship"],
    });
    expect(rows[0]!.work).toBe("Conventional lathe");
  });

  it("returns NOTHING when the fresher questions were never answered", () => {
    // A non-fresher who simply has not filled the work-history form must not get an invented
    // training block. The History heading collapses exactly as it does today.
    expect(buildFresherRows("qp_cnc_turning", {})).toEqual([]);
    expect(buildFresherRows("qp_cnc_turning", { turning_machine: ["cnc_lathe"] })).toEqual([]);
  });

  it("caps the machine list so one row cannot wrap into three", () => {
    const rows = buildFresherRows("qp_cnc_turning", {
      iti_workshop_machines: [
        "conventional_lathe",
        "cnc_lathe",
        "milling",
        "drilling",
        "grinding",
        "shaper",
      ],
    });
    expect(rows[0]!.work.split(" · ")).toHaveLength(4);
  });
});

describe("the fresher block reaches Zone 4 on a real sheet", () => {
  const sheetFor = (attributes: Record<string, unknown>, employments: unknown[] = []) =>
    buildResumeRenderInput({}, "Vikas Chauhan", "bb_trade", null, false, "worker", {
      packId: "qp_cnc_turning",
      attributes,
      employments: employments as never,
    });

  it("gives an ITI pass-out a non-empty History section", () => {
    const input = sheetFor({
      iti_workshop_machines: ["conventional_lathe", "cnc_lathe"],
      trade_test_status: "passed",
    });
    expect(input.experiences).toHaveLength(1);
    expect(input.experiences[0]!.role).toBe("ITI workshop training");
  });

  it("yields to REAL employment rows — it is the other branch, not a competing source", () => {
    const input = sheetFor({ iti_workshop_machines: ["cnc_lathe"], trade_test_status: "passed" }, [
      {
        employer: "Shakti Precision",
        employerCity: "Rajkot",
        employerState: "Gujarat",
        startYm: "2024-07",
        endYm: null,
        durationStated: true,
        roles: [{ roleLabel: "CNC Turner", startYm: null, endYm: null, workDone: "CNC lathe" }],
      },
    ]);
    expect(input.employments).toHaveLength(1);
    expect(input.experiences).toEqual([]);
  });
});

/**
 * §6.2's TENURE SEGMENT — the sum of the worker's own work history, and the one word for a worker
 * who has none.
 *
 * WHAT TOTAL EXPERIENCE IS (owner ruling 2026-09-09). "It is not a range taken from any question.
 * It is calculated from the work history that is filled by the individual and the total calculated
 * from the work history itself" — 1 yr 2 mo + 10 mo + 2 yrs is 4 years. The figure is
 * `totalEmployedYears`; this label is only what prints when there is no work history to sum.
 *
 * THE REVISION THIS SUITE REPLACED read the role pack's tier gate and printed its rungs as bands
 * ("1–3 yrs", "7+ yrs"). That is exactly the range-from-a-question the ruling rejects, and the
 * assertions for it are deleted rather than adapted — the rung now does one thing only, and it is
 * negative: it stops the sheet calling a self-declared seven-year man a fresher.
 */
describe("tenureStatusLabel — Fresher, and the two ways it must be withheld", () => {
  it("prints Fresher for the CAD draughtsman's own fresher chip, work history or not", () => {
    // The ratified page: "CAD Designer / Draughtsman — Draughtsman · Fresher · AutoCAD,
    // SolidWorks, Fusion 360". UNGATED, exactly as it shipped: she said the word herself.
    expect(tenureStatusLabel("qp_cad_drafting", { drafting_experience: 0 }, true)).toBe("Fresher");
    expect(tenureStatusLabel("qp_cad_drafting", { drafting_experience: 0 }, false)).toBe("Fresher");
  });

  it("prints Fresher for a worker who filed no work history", () => {
    // The owner's standing definition — "someone not added work experience" — and with the sum as
    // the only source of a figure it is also simply true: there is nothing to add up.
    expect(tenureStatusLabel("qp_cnc_turning", {}, true)).toBe("Fresher");
    expect(tenureStatusLabel("qp_cnc_turning", { turning_machine: ["cnc_lathe"] }, true)).toBe(
      "Fresher",
    );
    // The lowest rung means "under a year" on the machining packs and does not contradict him.
    expect(tenureStatusLabel("qp_cnc_turning", { turning_experience: 0 }, true)).toBe("Fresher");
    expect(tenureStatusLabel("qp_cad_drafting", { drafting_experience: 1 }, true)).toBe("Fresher");
  });

  it("WITHHOLDS the word from a worker whose own form claims a year or more — §8.3", () => {
    // He filed no work history, so there is no sum; but he told the form he has years, and the
    // sheet may neither call him a fresher nor invent a figure for him. It says nothing, and
    // §11 #3's honest unknown prints instead.
    for (const rung of [2, 5, 10]) {
      expect(tenureStatusLabel("qp_cnc_turning", { turning_experience: rung }, true)).toBeNull();
      expect(tenureStatusLabel("qp_welding_trade", { welding_experience: rung }, true)).toBeNull();
    }
  });

  it("NEVER prints a band — the rung is read to withhold a word, never to print one", () => {
    // The ruling in one assertion. Whatever the rung, the only two outputs are the word and null.
    for (const rung of [0, 1, 2, 5, 10]) {
      for (const filed of [true, false]) {
        const label = tenureStatusLabel("qp_cnc_turning", { turning_experience: rung }, filed);
        expect(label === null || label === "Fresher", `rung ${rung}, filed=${filed}`).toBe(true);
      }
    }
  });

  it("says NOTHING once a work history exists — the sum speaks, or §11 #3 does", () => {
    // Either it is dated and `totalEmployedYears` prints the figure, or it is not and "duration
    // not stated" is the honest line. "Fresher" over a man's own employer block is neither.
    expect(tenureStatusLabel("qp_cnc_turning", {}, false)).toBeNull();
    expect(tenureStatusLabel("qp_cnc_turning", { turning_experience: 0 }, false)).toBeNull();
  });

  it("says NOTHING without a pack — a legacy chat profile was never asked any of this", () => {
    // THE BOUND ON THE RULING. Every profile written before the role forms has no pack and often
    // no employment rows; reading that as "fresher" would relabel the entire back catalogue.
    expect(tenureStatusLabel(null, { turning_experience: 0 }, true)).toBeNull();
    expect(tenureStatusLabel(null, {}, true)).toBeNull();
    expect(tenureStatusLabel("qp_not_a_real_pack", {}, true)).toBeNull();
  });

  it("does not coerce — a STRING rung is a different pack shape, not an answer", () => {
    // A string rung is not a number, so it cannot claim a year or more — and the worker still
    // filed nothing, so he still reads as a fresher. The shape change must be NOTICED (the corpus
    // guard is what notices it), not silently turned into a different claim about him.
    expect(tenureStatusLabel("qp_cnc_turning", { turning_experience: "5" }, true)).toBe("Fresher");
    expect(tenureStatusLabel("qp_cnc_turning", { turning_experience: "5" }, false)).toBeNull();
  });
});

/**
 * THE FIGURE ITSELF — the defect the 2026-09-09 ruling surfaced.
 *
 * `totalEmployedYears` has summed the worker's dated employments since Zone 4 shipped, and
 * `resume-render-input.ts` handed it to the résumé-container path ALONE. The legacy branch — the
 * one every form-first worker takes, because the trade form runs no extraction — composed
 * `years: draft.experience.total_years` and never consulted the sum. So a worker with three fully
 * dated jobs on his sheet read "duration not stated" above them.
 */
describe("total experience is the sum of the work history, on BOTH branches", () => {
  /** The owner's example: 1 yr 2 mo + 10 mo + 2 yrs = 4 years, as dated employments. */
  const THREE_JOBS = [
    { employer: "First Engineering", startYm: "2024-01", endYm: "2025-02" }, // 14 months
    { employer: "Second Auto", startYm: "2023-01", endYm: "2023-10" }, // 10 months
    { employer: "Third Precision", startYm: "2021-01", endYm: "2022-12" }, // 24 months
  ].map((e) => ({
    ...e,
    employerCity: "Faridabad",
    employerState: "Haryana",
    durationStated: true,
    roles: [{ roleLabel: "CNC Turner", startYm: null, endYm: null, workDone: "CNC turning" }],
  }));

  const sheetFor = (snapshot: Record<string, unknown>, employments: unknown[]) =>
    buildResumeRenderInput(snapshot, "Dean Parker", "bb_trade", null, false, "worker", {
      packId: "qp_cnc_turning",
      attributes: { turning_machine: ["cnc_lathe"] },
      employments: employments as never,
      asOf: new Date("2026-09-09T00:00:00Z"),
    });

  const LEGACY = { role_label: "CNC Turner", experience: { total_years: null } };
  const CONTAINER = {
    resume_profile: { role_label: "CNC Turner", skills: ["CNC turning"], experiences: [] },
  };

  it("prints 4 yrs for 1 yr 2 mo + 10 mo + 2 yrs — the owner's own example", () => {
    for (const [name, snapshot] of [
      ["legacy (form-first)", LEGACY],
      ["container (interview)", CONTAINER],
    ] as const) {
      const input = sheetFor(snapshot, THREE_JOBS);
      expect(input.headlineLine, name).toContain("4 yrs");
      expect(input.headlineLine, name).not.toContain("duration not stated");
      expect(input.experienceYears, name).toBe(4);
    }
  });

  it("the two branches agree, which is what stops one worker having two tenures", () => {
    expect(sheetFor(LEGACY, THREE_JOBS).experienceYears).toBe(
      sheetFor(CONTAINER, THREE_JOBS).experienceYears,
    );
  });

  it("a STATED total still outranks the sum (R8 §1, and the under-representation gate)", () => {
    // A worker who says twelve years and has two dated jobs on the sheet keeps his own figure —
    // the sum is what fills the silence, not what overrules him.
    const input = sheetFor({ ...LEGACY, experience: { total_years: 12 } }, THREE_JOBS);
    expect(input.headlineLine).toContain("12 yrs");
  });

  it("a worker with NO work history reads Fresher, not a figure", () => {
    expect(sheetFor(LEGACY, []).headlineLine).toContain("Fresher");
    expect(sheetFor(LEGACY, []).experienceYears).toBeNull();
  });

  it("an UNDATED job voids the total — §11 #3, and it is asserted so it is a decision", () => {
    // `totalEmployedYears` is all-or-nothing by design: a total that quietly omits the jobs whose
    // dates the worker could not give is a false total. The cost is real and is pinned here — two
    // dated jobs and one undated print no figure at all — so that changing it is a ruling somebody
    // makes on purpose rather than a behaviour that drifts.
    const partial = [
      ...THREE_JOBS.slice(0, 2),
      { ...THREE_JOBS[2]!, startYm: null, durationStated: false },
    ];
    const input = sheetFor(LEGACY, partial);
    expect(input.headlineLine).toContain("duration not stated");
    expect(input.experienceYears).toBeNull();
  });
});
