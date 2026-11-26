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
    // An escape that is ALSO the question's only "don't know" stays served (#3009, T25's
    // `diecast_machine_brand`): "Pata nahi" is a real answer the typed card cannot give.
    const KEPT_AS_DONT_KNOW = new Set(["Koi aur ya pata nahi"]);
    const leaks = selectItems.flatMap(({ at, item }) =>
      formServedOptions(item, [])
        .filter((o) => o.is_none_of_above && /^\s*koi\s+aur\b/i.test(o.label_text))
        .filter((o) => !KEPT_AS_DONT_KNOW.has(o.label_text))
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
      "qp_blow_moulding:blow_machine_brand",
      "qp_blow_moulding:blow_product",
      "qp_boring_machine:boring_machine_make",
      "qp_boring_machine:boring_machine_type",
      "qp_cad_design_3d:design_software",
      "qp_cad_design_3d:design_work_area",
      "qp_cad_design_3d@2:design_software",
      "qp_cad_drafting:cad_software",
      "qp_cad_drafting@2:cad_software",
      "qp_cad_drafting@2:drawing_subject",
      "qp_cae_fea:cae_employer_type",
      "qp_cae_fea:cae_preprocessor",
      "qp_cae_fea:cae_process_sim_software",
      "qp_cae_fea:cae_solver",
      "qp_cam_programming:cam_software",
      "qp_cam_programming:machine_programmed",
      "qp_cam_programming@2:cam_software",
      "qp_cam_programming@2:machine_programmed",
      "qp_cam_programming@3:cam_software",
      "qp_cam_programming@3:machine_programmed",
      "qp_cam_programming@4:cam_software",
      "qp_cam_programming@4:machine_programmed",
      "qp_cmm:cmm_machine_type",
      "qp_cmm:cmm_software",
      "qp_cnc_grinding:grinding_machine",
      "qp_cnc_grinding@2:grinding_machine",
      "qp_cnc_grinding@3:grinding_machine",
      "qp_cnc_grinding@4:grinding_machine",
      "qp_cnc_grinding@5:grinding_machine",
      "qp_cnc_grinding@6:grinding_machine",
      "qp_cnc_router:router_machine_type",
      "qp_cnc_turning:turning_machine",
      "qp_cnc_turning@2:turning_machine",
      "qp_cnc_turning@3:turning_machine",
      "qp_cnc_turning@4:turning_machine",
      "qp_cnc_turning@5:turning_machine",
      "qp_cnc_turning@6:turning_machine",
      "qp_crane_rigging:crane_type",
      "qp_die_casting:diecast_part",
      "qp_die_casting:diecast_process",
      "qp_dispatch_logistics:dispatch_erp_system",
      "qp_draughting:cad_software",
      "qp_draughting:draughting_field",
      "qp_edm_wirecut@2:edm_brand",
      "qp_edm_wirecut@2:edm_cam_software",
      "qp_edm_wirecut@2:edm_machine",
      "qp_fitting:fitting_type",
      "qp_forging:forging_machine",
      "qp_forging:forging_part",
      "qp_forklift:forklift_make",
      "qp_foundry_casting:foundry_casting_product",
      "qp_gear_cutting:gear_machine_make",
      "qp_heat_treatment@2:heat_furnace",
      "qp_heat_treatment@2:ht_part",
      "qp_hvac_rac:hvac_brand",
      "qp_injection_moulding@2:moulding_machine_brand",
      "qp_machining:machine_type",
      "qp_npd_engineer:npd_part_process",
      "qp_piping_design:piping_employer_type",
      "qp_piping_design:piping_software",
      "qp_plastic_extrusion:extrusion_machine_brand",
      "qp_plastic_extrusion:extrusion_product_line",
      "qp_plc_automation@2:plc_brand",
      "qp_ppc:ppc_erp_system",
      "qp_ppc:ppc_plant_type",
      "qp_process_engineer:proc_process_type",
      "qp_production_engineer:prod_shop_type",
      "qp_production_supervisor@2:supervision_area",
      "qp_production_supervisor@2:supervision_trade_background",
      "qp_project_site:site_project_type",
      "qp_purchase:purchase_erp_system",
      "qp_robotics:robot_application",
      "qp_robotics:robot_brand",
      "qp_robotics:robot_part_type",
      "qp_rubber_moulding:rubber_product",
      "qp_safety_ehs:ehs_site_type",
      "qp_sheet_metal_fab@2:sheet_metal_product",
      "qp_sheet_metal_fab@3:sheet_metal_product",
      "qp_spm_finishing:spm_machine_type",
      "qp_stores:store_erp_system",
      "qp_stores:store_material_handled",
      "qp_surface_treatment:plating_part",
      "qp_technical_sales:sales_product_line",
      "qp_toolmaking:tool_type",
      "qp_tube_forming:tube_machine_type",
      "qp_utility:utility_boiler_make",
      "qp_vmc_milling:milling_machine",
      "qp_vmc_milling@2:milling_machine",
      "qp_vmc_milling@3:milling_machine",
      "qp_vmc_milling@4:milling_machine",
      "qp_vmc_milling@5:milling_machine",
      "qp_vmc_milling@6:milling_machine",
      "qp_welding:welding_process",
    ]);
  }, 30_000);
});
