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
 * §6.2's TENURE SEGMENT — the worker's own answer, and the two ways it used to be wrong.
 *
 * THE TRAP THIS SUITE EXISTS FOR. `worker_attributes` stores the option's VALUE, never its key,
 * and the value 0 is not portable between packs:
 *
 *   qp_cad_drafting   `fresher_course` = 0   "Course kiya hai, kaam ka tajurba nahi"
 *                     `under_one`      = 1   "1 saal se kam"
 *   every other pack  `under_one`      = 0   "1 saal se kam"
 *
 * WHAT THE TWO RULINGS CHANGED. 2026-09-08 made "Fresher" reachable at all; 2026-09-09 came with a
 * rendered sheet — a turner who had filed no work history, still reading "CNC turner · duration not
 * stated · Siemens" — and said to fix it. The fix is not a wider fresher rule: it is that the tier
 * gate, the ONE tenure question a form-first worker is always asked, now prints at every rung.
 * §11 #3's text is left for the workers it was written for — nobody asked, or dates he could not
 * give.
 *
 * THE ASSERTION THAT KEEPS IT HONEST is the senior worker: a man who tapped "7 saal se zyada" and
 * skipped the work-history screen prints "7+ yrs", never "Fresher". Read literally the ruling
 * would have deleted seven years of his own stated experience from his own résumé.
 */
describe("tenureStatusLabel — the rung the worker actually tapped", () => {
  it("prints Fresher for the CAD draughtsman's own fresher chip, work history or not", () => {
    // The ratified page: "CAD Designer / Draughtsman — Draughtsman · Fresher · AutoCAD,
    // SolidWorks, Fusion 360". THE DECLARED RUNG IS UNGATED, exactly as it shipped: she said the
    // word herself, so nothing else has to be true for the sheet to print it.
    expect(tenureStatusLabel("qp_cad_drafting", { drafting_experience: 0 }, true)).toBe("Fresher");
    expect(tenureStatusLabel("qp_cad_drafting", { drafting_experience: 0 }, false)).toBe("Fresher");
  });

  it("prints the BAND for every higher rung, on the declared-fresher pack and the others", () => {
    // The scale is shared, but 0 is not: on `qp_cad_drafting` `under_one` stores 1, and it must
    // read as "Under 1 yr" rather than as the fresher chip one rung below it.
    expect(tenureStatusLabel("qp_cad_drafting", { drafting_experience: 1 }, true)).toBe(
      "Under 1 yr",
    );
    expect(tenureStatusLabel("qp_cad_drafting", { drafting_experience: 2 }, true)).toBe("1–3 yrs");
    expect(tenureStatusLabel("qp_cnc_turning", { turning_experience: 2 }, true)).toBe("1–3 yrs");
    expect(tenureStatusLabel("qp_cnc_turning", { turning_experience: 5 }, true)).toBe("3–7 yrs");
    expect(tenureStatusLabel("qp_cnc_turning", { turning_experience: 10 }, true)).toBe("7+ yrs");
    expect(tenureStatusLabel("qp_welding_trade", { welding_experience: 10 }, false)).toBe("7+ yrs");
  });

  it("NEVER prints Fresher over a worker who stated a higher rung — the §8.3 assertion", () => {
    // THE ONE THIS SUITE EXISTS FOR. He skipped the work-history screen, so a literal reading of
    // "no work experience added → Fresher" would land the word on a man with seven years he
    // himself declared, on his own résumé.
    for (const rung of [2, 5, 10]) {
      const label = tenureStatusLabel("qp_cnc_turning", { turning_experience: rung }, true);
      expect(label, `rung ${rung}`).not.toMatch(/fresher/i);
      expect(label, `rung ${rung} must still say something`).not.toBeNull();
    }
  });

  it("reads the LOWEST rung as Fresher only when no work history was filed", () => {
    // "1 saal se kam" is under a year, not none — so the word is owed to the ruling, and only for
    // the worker the ruling names. With employer blocks on the page it reads as the band instead:
    // "Fresher" three rows above a man's own job is a contradiction the sheet cannot defend.
    expect(tenureStatusLabel("qp_cnc_turning", { turning_experience: 0 }, true)).toBe("Fresher");
    expect(tenureStatusLabel("qp_cnc_turning", { turning_experience: 0 }, false)).toBe(
      "Under 1 yr",
    );
    expect(tenureStatusLabel("qp_vmc_milling", { milling_experience: 0 }, false)).toBe(
      "Under 1 yr",
    );
  });

  it("prints Fresher for a pack worker who answered NOTHING and filed no work history", () => {
    // The 2026-09-09 ruling applied to the worker who skipped even the mandatory tenure question.
    // He has told the form nothing and filed no job; "someone not added work experience" is the
    // owner's own definition of a fresher.
    expect(tenureStatusLabel("qp_cnc_turning", {}, true)).toBe("Fresher");
    expect(tenureStatusLabel("qp_cnc_turning", { turning_machine: ["cnc_lathe"] }, true)).toBe(
      "Fresher",
    );
  });

  it("says NOTHING for that worker once he HAS a work history — §11 #3 keeps him", () => {
    // No rung, but employer blocks on the page: his dates are what is missing, and "nobody asked"
    // is the honest line for a tenure the sheet genuinely does not know.
    expect(tenureStatusLabel("qp_cnc_turning", {}, false)).toBeNull();
  });

  it("says NOTHING without a pack — a legacy chat profile was never asked any of this", () => {
    // THE BOUND ON THE RULING. Every profile written before the role forms has no pack, no tier
    // gate and often no employment rows; reading that as "fresher" would relabel the entire back
    // catalogue on the strength of a question nobody put to them.
    expect(tenureStatusLabel(null, { turning_experience: 0 }, true)).toBeNull();
    expect(tenureStatusLabel(null, {}, true)).toBeNull();
    // A pack no descriptor claims has no gate key to read either.
    expect(tenureStatusLabel("qp_not_a_real_pack", { turning_experience: 0 }, true)).toBeNull();
  });

  it("does not coerce — a STRING rung is a different pack shape, not an answer", () => {
    // `pack-registry.service.ts::toOption` resolves `value_text ?? value_number`, so a numeric
    // rung arrives as a number. A pack that later spells its rungs as text must be NOTICED, not
    // read as a claim about a worker — and it falls through to the no-rung branch, which is the
    // conservative side.
    expect(tenureStatusLabel("qp_cnc_turning", { turning_experience: "2" }, false)).toBeNull();
    expect(tenureStatusLabel("qp_cad_drafting", { drafting_experience: "0" }, false)).toBeNull();
  });

  it("says NOTHING for a rung value the scale does not define", () => {
    // A pack authored later with a 3 or a 7 prints no band rather than the wrong one. The corpus
    // guard is what turns that silence into a CI failure.
    expect(tenureStatusLabel("qp_cnc_turning", { turning_experience: 3 }, false)).toBeNull();
    expect(tenureStatusLabel("qp_cnc_turning", { turning_experience: 99 }, false)).toBeNull();
  });
});

describe("the tenure segment on a rendered sheet", () => {
  const turner = (attributes: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    buildResumeRenderInput(
      { experience: { total_years: null }, role_label: "CNC turner" },
      "Dean Parker",
      "bb_trade",
      null,
      false,
      "worker",
      { packId: "qp_cnc_turning", attributes, ...over },
    );

  it("DEAN PARKER's sheet — the render that prompted the 2026-09-09 ruling", () => {
    // His PDF read "CNC turner · duration not stated · Siemens" with no work history on it. The
    // attributes below are his sheet read back: every UNGATED question of `qp_cnc_turning` and
    // nothing from either gated tier, which is what the rendered page shows.
    const answers = {
      turning_machine: ["cnc_lathe"],
      controller_brand: ["siemens"],
      material_worked: ["ms"],
      turning_operation: ["boring"],
      workholding: ["collet"],
      measuring_tools: ["micrometer"],
      drawing_reading: "gdt",
    };
    // Whatever he answered on the gate — including not answering it — the segment now carries it.
    expect(turner(answers).headlineLine).toBe("CNC turner · Fresher · Siemens");
    expect(turner({ ...answers, turning_experience: 0 }).headlineLine).toBe(
      "CNC turner · Fresher · Siemens",
    );
    expect(turner({ ...answers, turning_experience: 2 }).headlineLine).toBe(
      "CNC turner · 1–3 yrs · Siemens",
    );
    expect(turner({ ...answers, turning_experience: 10 }).headlineLine).toBe(
      "CNC turner · 7+ yrs · Siemens",
    );
    for (const rung of [undefined, 0, 2, 5, 10]) {
      const attributes = rung === undefined ? answers : { ...answers, turning_experience: rung };
      expect(turner(attributes).headlineLine).not.toContain("duration not stated");
    }
  });

  it("a stated figure still outranks every band", () => {
    const input = buildResumeRenderInput(
      { experience: { total_years: 0.5 }, role_label: "CNC turner" },
      "Dean Parker",
      "bb_trade",
      null,
      false,
      "worker",
      { packId: "qp_cnc_turning", attributes: { turning_experience: 10 } },
    );
    expect(input.headlineLine).toContain("6 mo");
    expect(input.headlineLine).not.toContain("7+ yrs");
  });

  it("a failed work-history read never turns the lowest rung into Fresher", () => {
    // Both callers degrade that read to `[]`; `employmentsUnavailable` is how they say they did
    // not look. "Under 1 yr" is true of him whatever the read did.
    const input = turner(
      { turning_experience: 0, turning_machine: ["cnc_lathe"] },
      { employments: [], employmentsUnavailable: true },
    );
    expect(input.headlineLine).toContain("Under 1 yr");
    expect(input.headlineLine).not.toMatch(/fresher/i);
  });

  it("a worker with employer blocks gets the band, never the word", () => {
    const input = turner(
      { turning_experience: 0, turning_machine: ["cnc_lathe"] },
      {
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
    expect(input.headlineLine).toContain("Under 1 yr");
    expect(input.headlineLine).not.toMatch(/fresher/i);
  });
});
