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
 * AND THE FOLLOW-UP RULING (2026-09-09b) FINISHED THE JOB. "Restrict the total experience shown on
 * the resume only to the work history details… if there is someone who has no work experience, no
 * work history, then it will be considered as a fresher, and it should not become like duration
 * not stated." The role pack's tier gate stays in the FORM — it sizes the questionnaire — and
 * leaves the SHEET entirely.
 *
 * SO THIS SUITE IS SMALLER THAN THE TWO BEFORE IT, ON PURPOSE. The first pinned the gate's rungs
 * as printed bands; the second pinned the rung being read to WITHHOLD the word. Both sets of
 * assertions are deleted rather than adapted, because both encoded the premise the owner rejected.
 * What is left asserts that the answers cannot reach the label at all.
 */
describe("tenureStatusLabel — one rule: no work history on file means Fresher", () => {
  it("prints Fresher for a form worker whose work history was read and is empty", () => {
    // The owner's standing definition — "someone not added work experience" — and with the sum as
    // the only source of a figure it is also simply true: there is nothing to add up.
    //
    // THIS ONE CALL IS ALSO THE CASE THE RULING TURNS OVER. A man who tapped "7 saal se zyada"
    // and filed no history reaches the same call and the same word, because there is no longer an
    // argument that could tell him apart. His sheet no longer repeats his bracket; the owner's
    // ground is that the bracket sized his questionnaire and was never a claim about his career,
    // and the fix for him is the work-history screen rather than a range on a page.
    expect(tenureStatusLabel("qp_cnc_turning", true)).toBe("Fresher");
    expect(tenureStatusLabel("qp_welding_trade", true)).toBe("Fresher");
    expect(tenureStatusLabel("qp_cad_drafting", true)).toBe("Fresher");
  });

  it("says NOTHING once a work history exists — the sum speaks, or §11 #3 does", () => {
    // Either it is dated and `totalEmployedYears` prints the figure, or it is not and "duration
    // not stated" is the honest line. "Fresher" over a man's own employer block is neither, and
    // that now holds for the CAD chip too: her declared "course kiya hai, kaam ka tajurba nahi"
    // used to print the word beside an employment block, which is the contradiction §6.2 exists
    // to prevent. Her ratified sheet is unaffected — it has no work history.
    expect(tenureStatusLabel("qp_cnc_turning", false)).toBeNull();
    expect(tenureStatusLabel("qp_cad_drafting", false)).toBeNull();
  });

  it("says NOTHING without a form pack — a legacy chat profile was never handed one", () => {
    // THE BOUND ON THE RULING, and the only thing the function still asks about a role. Every
    // profile written before the role forms has no pack and often no employment rows; reading
    // that as "fresher" would relabel the entire back catalogue. `qp_universal@2` is the trap
    // worth naming: it is a real, shipped pack that no ROLE FORM serves.
    expect(tenureStatusLabel(null, true)).toBeNull();
    expect(tenureStatusLabel("qp_not_a_real_pack", true)).toBeNull();
    expect(tenureStatusLabel("qp_universal@2", true)).toBeNull();
  });

  it("cannot be reached by any pack answer — the ruling, as an arity", () => {
    // WHAT REPLACES THE WITHHOLD SUITE. Those tests varied an attribute bag to prove the rung
    // changed the word; there is no bag left to vary, so the proof is structural instead: the
    // gate cannot be READ because it cannot be PASSED. A revision that starts consulting the
    // rung again has to widen this signature, and this line is what notices.
    expect(tenureStatusLabel).toHaveLength(2);
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

  it("EVERY rung of the tier gate reaches the same headline (owner ruling 2026-09-09b)", () => {
    // THE RULING AT THE LEVEL THE OWNER SEES IT, which is the sheet rather than a pure function.
    // He filed no work history; whatever he tapped on "Turning ka kitna tajurba hai?" — including
    // "7 saal se zyada", which used to withhold the word and print §11 #3's text over him — the
    // headline reads "Fresher" and carries no figure. The gate sizes his form and leaves the page.
    for (const rung of [0, 2, 5, 10]) {
      const input = buildResumeRenderInput(
        LEGACY,
        "Dean Parker",
        "bb_trade",
        null,
        false,
        "worker",
        {
          packId: "qp_cnc_turning",
          attributes: { turning_experience: rung, turning_machine: ["cnc_lathe"] },
          employments: [],
          asOf: new Date("2026-09-09T00:00:00Z"),
        },
      );
      expect(input.headlineLine, `rung ${rung}`).toContain("Fresher");
      expect(input.headlineLine, `rung ${rung}`).not.toContain("duration not stated");
      expect(input.experienceYears, `rung ${rung}`).toBeNull();
    }
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

/**
 * #1476 — the fresher's own words, beside the rewrite.
 *
 * #1350 lets a model rewrite the `iti_project_work` sentence, and until now the worker had no way
 * to see what it was rewritten FROM: the reveal #1354 built was wired to an employment block, and
 * a fresher has none. This is the data half of closing that asymmetry.
 *
 * THE COMPARISON HAS TO BE HONEST, which is why `work_own_words` is composed through the SAME
 * joiner as `work` in the same pass. The block is a ` · `-joined composite of machines, the
 * trade-test clause and his project sentence — and the machines are joined with that same
 * separator, so a client cannot take the line apart to find the segment that changed. It gets
 * both whole lines or it gets nothing it can trust.
 */
describe("buildFresherRows — work_own_words (#1476)", () => {
  const OWN = "kuch nhi banaya, bas knowledge he mujhe";
  const POLISHED = "Completed workshop training with hands-on machine exposure.";
  const BASE = {
    iti_workshop_machines: ["conventional_lathe"],
    trade_test_status: "passed",
    iti_project_work: OWN,
  };

  it("is ABSENT when nothing was rewritten", () => {
    // Nothing to compare, so nothing to offer — the same rule the employment block follows.
    const rows = buildFresherRows("qp_cnc_turning", BASE);
    expect(rows[0]!.work).toContain(OWN);
    expect(rows[0]!.work_own_words).toBeUndefined();
  });

  it("carries the WHOLE line from his own words when the project was rewritten", () => {
    const rows = buildFresherRows("qp_cnc_turning", BASE, {
      polishEnabled: true,
      polished: { iti_project_work: POLISHED },
    });

    // What prints for the employer.
    expect(rows[0]!.work).toBe(
      "Conventional lathe · Trade test passed · " + POLISHED,
    );
    // What he actually wrote, through the SAME joiner — so the ONLY difference between the two
    // strings is the segment the rewrite touched.
    expect(rows[0]!.work_own_words).toBe(
      "Conventional lathe · Trade test passed · " + OWN,
    );
  });

  it("differs from work in EXACTLY the rewritten segment, nothing else", () => {
    const rows = buildFresherRows("qp_cnc_turning", BASE, {
      polishEnabled: true,
      polished: { iti_project_work: POLISHED },
    });
    const work = rows[0]!.work.split(" · ");
    const own = rows[0]!.work_own_words!.split(" · ");

    // Same shape, same count: a second independent walk would not guarantee this.
    expect(own).toHaveLength(work.length);
    // Every segment but the last is identical.
    expect(own.slice(0, -1)).toEqual(work.slice(0, -1));
    expect(own.at(-1)).toBe(OWN);
    expect(work.at(-1)).toBe(POLISHED);
  });

  it("is absent when the kill switch is off, because his words are what printed", () => {
    // WORK_HISTORY_POLISH_ENABLED off ⇒ `work` already holds his own sentence.
    const rows = buildFresherRows("qp_cnc_turning", BASE, {
      polishEnabled: false,
      polished: { iti_project_work: POLISHED },
    });
    expect(rows[0]!.work).toContain(OWN);
    expect(rows[0]!.work_own_words).toBeUndefined();
  });

  it("is absent when the rewrite came back identical to his own words", () => {
    // "rewritten to the same words" must read as "not rewritten" to the client.
    const rows = buildFresherRows("qp_cnc_turning", BASE, {
      polishEnabled: true,
      polished: { iti_project_work: OWN },
    });
    expect(rows[0]!.work_own_words).toBeUndefined();
  });

  it("still says nothing when the worker answered nothing at all", () => {
    const rows = buildFresherRows("qp_cnc_turning", {
      iti_workshop_machines: [],
      trade_test_status: "not_yet",
    });
    expect(rows).toEqual([]);
  });
});
