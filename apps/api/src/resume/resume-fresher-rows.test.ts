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
 *   the other four    `under_one`      = 0   "1 saal se kam"
 *
 * A renderer rule of "0 means fresher" would therefore print "Fresher" over a turner, a miller,
 * a grinder or a part programmer with up to eleven months on a shop floor — deleting real
 * experience from his own résumé. Every assertion below is that one sentence, made executable
 * against the REAL descriptors rather than against a fixture.
 */
describe("fresherTenureLabel — the status chip, and the packs that must never get one", () => {
  it("prints Fresher for the CAD draughtsman's own fresher rung", () => {
    // The ratified page: "CAD Designer / Draughtsman — Draughtsman · Fresher · AutoCAD,
    // SolidWorks, Fusion 360".
    expect(fresherTenureLabel("qp_cad_drafting", { drafting_experience: 0 })).toBe("Fresher");
  });

  it("prints NOTHING for that role's other rungs, including 'under a year'", () => {
    // `under_one` on this pack stores 1, and 1 is not a claim of no experience.
    for (const value of [1, 2, 5, 10]) {
      expect(fresherTenureLabel("qp_cad_drafting", { drafting_experience: value })).toBeNull();
    }
  });

  it("prints NOTHING for the four machining packs, whose LOWEST rung also stores 0", () => {
    // THE ASSERTION THAT MAKES THE FEATURE SAFE. Each of these workers tapped "1 saal se kam" and
    // has up to eleven months on a shop floor; none of them said he is a fresher, and the sheet
    // must not say it for him (§8, and §8.3's asymmetry rule).
    expect(fresherTenureLabel("qp_cnc_turning", { turning_experience: 0 })).toBeNull();
    expect(fresherTenureLabel("qp_vmc_milling", { milling_experience: 0 })).toBeNull();
    expect(fresherTenureLabel("qp_cnc_grinding", { grinding_experience: 0 })).toBeNull();
    expect(fresherTenureLabel("qp_cam_programming", { programming_experience: 0 })).toBeNull();
  });

  it("prints NOTHING for an unanswered gate, an unmapped pack or no pack at all", () => {
    expect(fresherTenureLabel("qp_cad_drafting", {})).toBeNull();
    expect(fresherTenureLabel("qp_welding", { welding_experience: 0 })).toBeNull();
    expect(fresherTenureLabel(null, { drafting_experience: 0 })).toBeNull();
  });

  it("does not coerce — a STRING zero is a different pack shape, not a fresher claim", () => {
    // `pack-registry.service.ts::toOption` resolves `value_text ?? value_number`, so a numeric
    // rung arrives as a number. A pack that later spells its rung "0" as text is a change that
    // must be noticed, not silently read as a claim about a worker.
    expect(fresherTenureLabel("qp_cad_drafting", { drafting_experience: "0" })).toBeNull();
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

    // AND A TURNER WHO ANSWERED THE LOWEST RUNG STILL READS AS AN UNKNOWN, never as a fresher.
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
    expect(turner.headlineLine).toContain("duration not stated");
    expect(turner.headlineLine).not.toMatch(/fresher/i);
  });
});
