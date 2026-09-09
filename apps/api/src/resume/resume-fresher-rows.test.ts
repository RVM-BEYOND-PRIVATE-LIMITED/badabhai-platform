import { describe, expect, it } from "vitest";

import { buildFresherRows, fresherTenureLabel } from "./resume-fresher-rows";
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
 * §6.2's TENURE STATUS — and the one number in this programme that means two different things.
 *
 * THE TRAP THIS SUITE EXISTS FOR. `worker_attributes` stores the option's VALUE, never its key,
 * and the value 0 is not portable between packs:
 *
 *   qp_cad_drafting   `fresher_course` = 0   "Course kiya hai, kaam ka tajurba nahi"
 *                     `under_one`      = 1   "1 saal se kam"
 *   every other pack  `under_one`      = 0   "1 saal se kam"
 *
 * WHAT THE 2026-09-08 OWNER RULING CHANGED, AND WHAT IT LEFT ALONE. Until it, a bare "0 means
 * fresher" rule was refused outright: it would print "Fresher" over a turner with eleven months
 * on a shop floor and delete real experience from his own résumé. The ruling — "in resume for
 * freshers (someone not added work experience) 'duration not stated' is written, I want 'Fresher'
 * mentioned there" — names the worker it is for, and that name is the gate. The rung is read as
 * "fresher" ONLY for a worker whose work history was read and is EMPTY, and only where he stated
 * no figure (`tenurePhrase` reads a label only in the absence of a number). The eleven-month man
 * keeps his experience the moment he records any of it, in either place.
 *
 * Every assertion below is those two sentences, made executable against the REAL descriptors
 * rather than against a fixture.
 */
describe("fresherTenureLabel — the status chip, and what still may never get one", () => {
  it("prints Fresher for the CAD draughtsman's own fresher rung, work history or not", () => {
    // The ratified page: "CAD Designer / Draughtsman — Draughtsman · Fresher · AutoCAD,
    // SolidWorks, Fusion 360". THE DECLARED RUNG IS UNGATED, exactly as it shipped: she said the
    // word herself, so nothing else has to be true for the sheet to print it.
    expect(fresherTenureLabel("qp_cad_drafting", { drafting_experience: 0 }, true)).toBe("Fresher");
    expect(fresherTenureLabel("qp_cad_drafting", { drafting_experience: 0 }, false)).toBe(
      "Fresher",
    );
  });

  it("prints NOTHING for that role's other rungs, including 'under a year'", () => {
    // `under_one` on this pack stores 1, and 1 is not a claim of no experience — on this pack it
    // is the rung ABOVE the fresher one, so neither route may fire for it.
    for (const value of [1, 2, 5, 10]) {
      expect(
        fresherTenureLabel("qp_cad_drafting", { drafting_experience: value }, true),
      ).toBeNull();
    }
  });

  it("prints Fresher on the other packs' lowest rung ONLY when no work history was filed", () => {
    // THE 2026-09-08 RULING. Twenty of the twenty-one roles have no `fresher_course` rung, so
    // before this every genuine fresher on those forms printed "duration not stated" over the top
    // of his own sheet — the complaint the ruling was written from.
    expect(fresherTenureLabel("qp_cnc_turning", { turning_experience: 0 }, true)).toBe("Fresher");
    expect(fresherTenureLabel("qp_vmc_milling", { milling_experience: 0 }, true)).toBe("Fresher");
    expect(fresherTenureLabel("qp_cnc_grinding", { grinding_experience: 0 }, true)).toBe("Fresher");
    expect(fresherTenureLabel("qp_cam_programming", { programming_experience: 0 }, true)).toBe(
      "Fresher",
    );
  });

  it("prints NOTHING on that rung when the worker HAS a work history, or when we could not read one", () => {
    // TWO CASES, ONE ARGUMENT, AND THE SECOND IS THE FAIL-CLOSED ONE. A worker with employment
    // rows has a history on the page and cannot be described as a fresher beside it. A worker
    // whose history FAILED TO LOAD is the twelve-year turner the callers' degrade would otherwise
    // relabel — the caller passes `false` for both, so the sheet says "duration not stated" and
    // an infrastructure miss puts no claim on his résumé.
    expect(fresherTenureLabel("qp_cnc_turning", { turning_experience: 0 }, false)).toBeNull();
    expect(fresherTenureLabel("qp_vmc_milling", { milling_experience: 0 }, false)).toBeNull();
  });

  it("prints NOTHING for any rung above the lowest, whatever the work history", () => {
    // A man who said one-to-three, three-to-seven or over-seven years has stated experience. The
    // ruling is about the bottom rung alone; nothing above it may ever read as a fresher claim.
    for (const value of [2, 5, 10]) {
      expect(fresherTenureLabel("qp_cnc_turning", { turning_experience: value }, true)).toBeNull();
      expect(
        fresherTenureLabel("qp_welding_trade", { welding_experience: value }, true),
      ).toBeNull();
    }
  });

  it("prints NOTHING for an unanswered gate, an unmapped pack or no pack at all", () => {
    expect(fresherTenureLabel("qp_cad_drafting", {}, true)).toBeNull();
    expect(fresherTenureLabel("qp_cnc_turning", {}, true)).toBeNull();
    // A pack no descriptor claims has no gate key to read, so it can reach neither route.
    expect(fresherTenureLabel("qp_not_a_real_pack", { turning_experience: 0 }, true)).toBeNull();
    expect(fresherTenureLabel(null, { drafting_experience: 0 }, true)).toBeNull();
  });

  it("does not coerce — a STRING zero is a different pack shape, not a fresher claim", () => {
    // `pack-registry.service.ts::toOption` resolves `value_text ?? value_number`, so a numeric
    // rung arrives as a number. A pack that later spells its rung "0" as text is a change that
    // must be noticed, not silently read as a claim about a worker. Both routes hold the line.
    expect(fresherTenureLabel("qp_cad_drafting", { drafting_experience: "0" }, true)).toBeNull();
    expect(fresherTenureLabel("qp_cnc_turning", { turning_experience: "0" }, true)).toBeNull();
  });

  it("reaches the rendered headline, and does not disturb a worker who stated years", () => {
    const fresher = buildResumeRenderInput(
      { experience: { total_years: null }, role_label: "CAD Designer / Draughtsman" },
      "Pooja Chaudhary",
      "bb_trade",
      null,
      false,
      "worker",
      {
        packId: "qp_cad_drafting",
        attributes: { drafting_experience: 0, cad_software: ["autocad"] },
      },
    );
    expect(fresher.headlineLine).toContain("· Fresher ·");

    // SAME WORKER, ONE YEAR LATER. A stated figure wins outright — the label never overwrites a
    // tenure the worker gave.
    const stated = buildResumeRenderInput(
      { experience: { total_years: 1 }, role_label: "CAD Designer / Draughtsman" },
      "Pooja Chaudhary",
      "bb_trade",
      null,
      false,
      "worker",
      {
        packId: "qp_cad_drafting",
        attributes: { drafting_experience: 0, cad_software: ["autocad"] },
      },
    );
    expect(stated.headlineLine).toContain("· 1 yr ·");
    expect(stated.headlineLine).not.toMatch(/fresher/i);

    // AND THE TURNER WHO PROMPTED THE RULING. He answered the lowest rung, filed no work history
    // and stated no total; his headline used to read "duration not stated". No trailing separator
    // is asserted — this fixture's machine chip is not a headline row, so the segment is last.
    const turner = buildResumeRenderInput(
      { experience: { total_years: null }, role_label: "CNC Turner" },
      "Vinod Sharma",
      "bb_trade",
      null,
      false,
      "worker",
      {
        packId: "qp_cnc_turning",
        attributes: { turning_experience: 0, turning_machine: ["cnc_lathe"] },
      },
    );
    expect(turner.headlineLine).toBe("CNC Turner · Fresher");
    expect(turner.headlineLine).not.toContain("duration not stated");

    // THE SAME TURNER WITH ONE JOB ON THE SHEET reads as an unknown again, never as a fresher —
    // asserted end-to-end, because the gate is applied by the mapper rather than by the label.
    const employed = buildResumeRenderInput(
      { experience: { total_years: null }, role_label: "CNC Turner" },
      "Vinod Sharma",
      "bb_trade",
      null,
      false,
      "worker",
      {
        packId: "qp_cnc_turning",
        attributes: { turning_experience: 0, turning_machine: ["cnc_lathe"] },
        employments: [
          {
            employer: "Shakti Auto Components",
            employerCity: "Rajkot",
            employerState: "Gujarat",
            startYm: null,
            endYm: null,
            durationStated: false,
            roles: [{ roleLabel: "CNC Turner", startYm: null, endYm: null, workDone: "CNC lathe" }],
          },
        ],
      },
    );
    expect(employed.headlineLine).toContain("duration not stated");
    expect(employed.headlineLine).not.toMatch(/fresher/i);

    // AND THE SAME TURNER WHOSE HISTORY COULD NOT BE READ. `employments: []` is what both callers
    // degrade to, so the flag is the only thing separating him from the fresher above.
    const unread = buildResumeRenderInput(
      { experience: { total_years: null }, role_label: "CNC Turner" },
      "Vinod Sharma",
      "bb_trade",
      null,
      false,
      "worker",
      {
        packId: "qp_cnc_turning",
        attributes: { turning_experience: 0, turning_machine: ["cnc_lathe"] },
        employments: [],
        employmentsUnavailable: true,
      },
    );
    expect(unread.headlineLine).toContain("duration not stated");
    expect(unread.headlineLine).not.toMatch(/fresher/i);
  });
});
