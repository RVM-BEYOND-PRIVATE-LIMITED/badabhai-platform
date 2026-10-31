import { readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { QuestionPackItem } from "@badabhai/ai-contracts";

import { packFromCorpus, PACK_DIR } from "./corpus-pack.test-support";
import { formServedOptions, isFormRedundantOther } from "./form-redundant-options";

/**
 * ═══ #2397 — ONE "OTHER" OPTION PER FORM QUESTION ═══
 *
 * The app draws "Koi aur — khud likhein" under every select question on the trade form. These
 * tests pin that the server leaves out the pack's own "Koi aur machine" style chip there, and
 * that it leaves out NOTHING else. The second half matters more, because a real answer removed
 * from a closed list cannot be given at all.
 */

const option = (option_key: string, label_text: string, is_none_of_above = false) => ({
  option_key,
  label_text,
  value: option_key,
  implies_skill_id: null,
  is_none_of_above,
});

const select = (options: QuestionPackItem["options"]): QuestionPackItem =>
  ({ question_key: "turning_machine", answer_type: "multi_select", options }) as QuestionPackItem;

describe("isFormRedundantOther", () => {
  it.each(["Koi aur machine", "Koi aur software", "Koi aur line", "Koi aur", "Koi aur tarah ki"])(
    "drops the pack's own escape %j",
    (label) => {
      expect(isFormRedundantOther(option("other", label, true))).toBe(true);
    },
  );

  it("matches the whole label whatever its case and spacing", () => {
    expect(isFormRedundantOther(option("other", "  KOI  aur   Machine ", true))).toBe(true);
  });

  it.each([
    "Inme se koi nahi",
    "Koi nahi",
    "Pata nahi",
    "Yaad nahi",
    "Koi bhi chalegi",
    "Setting koi aur karta hai",
    "Program koi aur banata hai",
  ])("keeps the real answer %j", (label) => {
    expect(isFormRedundantOther(option("none", label, true))).toBe(false);
  });

  it("keeps a 'Koi aur' chip the pack did not flag none-of-above — the flag is what makes it an escape", () => {
    expect(isFormRedundantOther(option("other", "Koi aur machine"))).toBe(false);
  });
});

describe("formServedOptions", () => {
  const machines = select([
    option("cnc_lathe", "CNC lathe"),
    option("vtl", "VTL, vertical lathe"),
    option("other_machine", "Koi aur machine", true),
  ]);

  it("serves the real options in pack order, without the escape", () => {
    expect(formServedOptions(machines, []).map((o) => o.option_key)).toEqual(["cnc_lathe", "vtl"]);
  });

  it("keeps the escape when it is the worker's own saved pick", () => {
    expect(formServedOptions(machines, ["other_machine"]).map((o) => o.option_key)).toEqual([
      "cnc_lathe",
      "vtl",
      "other_machine",
    ]);
  });
});

describe("the shipped corpus, as the trade form serves it", () => {
  const FILES = readdirSync(PACK_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.replace(/\.json$/, ""));

  const selectItems = FILES.flatMap((file) =>
    packFromCorpus(file)
      .items.filter((i) => i.answer_type === "single_select" || i.answer_type === "multi_select")
      .map((item) => ({ at: `${file}:${item.question_key}`, item })),
  );

  it("serves no 'Koi aur …' escape on any select question in any pack", () => {
    // THE GUARD FOR THE NEXT PACK. A new "Koi aur controller" chip fails here until its label
    // joins the closed set in `form-redundant-options.ts`.
    const leaks = selectItems.flatMap(({ at, item }) =>
      formServedOptions(item, [])
        .filter((o) => o.is_none_of_above && /^\s*koi\s+aur\b/i.test(o.label_text))
        .map((o) => `${at} → ${o.label_text}`),
    );
    expect(leaks).toEqual([]);
    expect(selectItems.length).toBeGreaterThan(100);
  }, 30_000);

  it("drops at most one option per question, and never empties one", () => {
    const dropped = selectItems.flatMap(({ at, item }) => {
      const served = formServedOptions(item, []);
      const gone = item.options.length - served.length;
      expect(gone, at).toBeLessThanOrEqual(1);
      expect(served.length, at).toBeGreaterThan(1);
      return gone > 0 ? [at] : [];
    });
    // Every list that carried a duplicate escape on 2026-10-22. Listed so a change to the set
    // shows up as a reviewed diff here rather than as a chip quietly appearing or vanishing.
    expect(dropped.sort()).toEqual([
      "qp_cad_drafting:cad_software",
      "qp_cam_programming:cam_software",
      "qp_cam_programming:machine_programmed",
      "qp_cam_programming@2:cam_software",
      "qp_cam_programming@2:machine_programmed",
      "qp_cam_programming@3:cam_software",
      "qp_cam_programming@3:machine_programmed",
      "qp_cnc_grinding:grinding_machine",
      "qp_cnc_grinding@2:grinding_machine",
      "qp_cnc_grinding@3:grinding_machine",
      "qp_cnc_grinding@4:grinding_machine",
      "qp_cnc_turning:turning_machine",
      "qp_cnc_turning@2:turning_machine",
      "qp_cnc_turning@3:turning_machine",
      "qp_cnc_turning@4:turning_machine",
      "qp_draughting:cad_software",
      "qp_draughting:draughting_field",
      "qp_fitting:fitting_type",
      "qp_machining:machine_type",
      "qp_toolmaking:tool_type",
      "qp_vmc_milling:milling_machine",
      "qp_vmc_milling@2:milling_machine",
      "qp_vmc_milling@3:milling_machine",
      "qp_vmc_milling@4:milling_machine",
      "qp_welding:welding_process",
    ]);
  }, 30_000);
});
