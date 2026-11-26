/**
 * PACK ANSWERS → the taxonomy ids they literally claim. The fourth bridge into Matching V1.
 *
 * THE GAP THIS CLOSES. A worker onboarded through a trade FORM (or a structured-answer chat that
 * ran a role pack) gets no `canonical_role_id` and no `skills` on `worker_profiles` — on purpose:
 * `toExtractionOutput` hardcodes both to null rather than invent an id. Everything he told us
 * lives in `worker_attributes`, keyed by the pack he answered. Until this table covered more than
 * `qp_cnc_turning`, a welder who tapped "MIG" and "TIG" derived ZERO `worker_skill` rows and saw
 * an empty V1 feed. So did every other trade form.
 *
 * WHY IT LIVES HERE AND NOT IN `apps/api`. Two writers derive `worker_skill`: the live rebuild
 * (`WorkerSkillsService`) and the batch repair (`db:backfill:worker-skills`). They must agree
 * byte for byte, or the nightly repair deletes what the live path wrote. The batch runner cannot
 * import from `apps/api`, so the one table both read has to sit in a package both depend on —
 * next to the three bridges it feeds.
 *
 * WHY A LOOKUP AND NOT A MODEL. Every key is an `option_key` from a checked-in pack JSON — a
 * closed set the worker TAPPED. There is nothing to infer, so there is no LLM, no embedding and
 * no confidence floor. Invariant #4 holds trivially: this emits ids, and `deriveWorkerSkills`
 * stays the only thing that turns ids into reach.
 *
 * WHAT AN ENTRY MAY EMIT — three kinds of id:
 *   - `skill_*` corpus ids → `ATTRIBUTE_TO_MATCH_SKILLS` (the attribute bridge)
 *   - `role_*` canonical roles → `ROLE_TO_MATCH_SKILL` (the role bridge), used ONLY where a chip
 *     names an occupation that has a match skill and no corpus id (`hmc` → `role_hmc_operator`).
 *   - `mskill_*` match skills, DIRECTLY — but ONLY a PACK-ONLY skill: one that no role and no
 *     corpus attribute bridges to (#2022). The eight trades minted for #2022 (conventional
 *     machinist, tool & die maker, sheet metal, press, coating, maintenance, industrial
 *     electrician, assembly line) have no `role_*` and no corpus id, so their own form is the only
 *     evidence there is. A test fails the moment a directly-named skill gains a bridge, because
 *     then the bridge must carry it and chat and form workers must agree.
 * Wherever a bridge exists, whether an answer implies a postable skill is the taxonomy's decision,
 * made once in that bridge, for chat and form workers alike.
 *
 * THE RULES AN ENTRY MUST PASS — read before extending:
 *
 *   1. **Map only what a chip literally claims.** The question stem is part of the claim: "Aap
 *      kaunsi welding karte hain?" → "TIG" is a TIG claim. "Kaunse measuring instrument chala
 *      lete hain?" → "micrometer" is not a quality inspector's claim.
 *   2. **No nearest-skill proxy (owner ruling, 2026-10-06).** A trade is mapped only to ITS OWN
 *      match skill. An electrician is not a fitter, a press operator is not a CNC operator, a sheet
 *      metal worker is not a welder. A pack whose trade has no match skill gets NO entry and is
 *      listed in `PACKS_WITHOUT_MATCH_SKILL` below, where a test pins that it derives nothing.
 *      MANUAL MACHINES ARE NOT A PROXY (owner ruling, #2022 point 1): a manual lathe, mill or
 *      grinder claim derives CNC Turner / VMC Operator / CNC Grinding Operator, exactly as the
 *      free-text "lathe" → `skill_turning` → CNC Turner path always has. Every path agrees, and
 *      `pack-answer-skills.test.ts` pins it.
 *   3. **Being routed to a pack is not a claim.** No entry keys off which form the worker was
 *      handed; a worker who answered nothing about his trade derives nothing. For the same reason
 *      no LEVEL question is mapped ("kis level ka sheet metal worker?" presupposes the trade the
 *      router picked) and no tenure question is.
 *   4. **Pack-scoped, never global (R12 §2.1).** `drawing_reading`, `measuring_tools`,
 *      `programming_level` and a dozen more keys recur across packs with different meanings. An
 *      entry applies only to answers stored under ITS pack id.
 *
 * POSTING-LEVEL ONLY, EXCEPT FOR THE TURNER. `qp_cnc_turning` predates this file and also emits
 * attribute-level corpus ids (fixtures, offsets, Fanuc) that map to `[]` in the attribute bridge;
 * they are carried over so no turner's derivation shrinks. Every other entry emits only ids that
 * reach a posting — an inert id would be review surface with no effect on reach.
 *
 * WRITES NOTHING. This runs on the derive READ path, so a taxonomy retag changes a worker's reach
 * on his next rebuild instead of leaving a stale row behind.
 */

import {
  matchSkillForRole,
  matchSkillsForAttribute,
  isMatchSkillId,
  type MatchSkillId,
} from "./match-skills";

/**
 * A taxonomy id a pack answer may imply: a corpus attribute (`skill_*`), a role (`role_*`), or a
 * PACK-ONLY match skill (closed set — `MatchSkillId`, so a typo is a compile error).
 */
export type PackAnswerTaxonomyId = `skill_${string}` | `role_${string}` | MatchSkillId;

type OptionMap = Readonly<Record<string, readonly PackAnswerTaxonomyId[]>>;
type PackMap = Readonly<Record<string, OptionMap>>;

/** Every fitting the fitter pack's stem scopes to fitting work — the occupation anchor. */
const FITTER_OCCUPATION = ["skill_fitter_occupation"] as const;

// ── Manual machining (#2022 point 1) ──────────────────────────────────────────────────────────
// A manual lathe / mill claim reaches the CNC skill the attribute bridge gives `skill_turning` /
// `skill_milling` (what a free-text "lathe" or "milling" already derives), AND the manual
// machinist's own skill, so a shop posting for manual work can target him. Shared by every pack
// that asks about a manual machine, so the same claim derives the same set wherever it is made.
const MANUAL_LATHE = ["skill_turning", "mskill_conventional_machinist"] as const;
const MANUAL_MILL = ["skill_milling", "mskill_conventional_machinist"] as const;
/** A manual machine with no CNC counterpart in the vocabulary (radial drill, shaper, slotter…). */
const MANUAL_MACHINE = ["mskill_conventional_machinist"] as const;

// ── The trades minted for #2022 — each pack-only skill, named once ─────────────────────────────
const TOOL_DIE_MAKER = ["mskill_tool_die_maker"] as const;
const SHEET_METAL_WORKER = ["mskill_sheet_metal_worker"] as const;
const PRESS_OPERATOR = ["mskill_press_operator"] as const;
const PAINTER_COATER = ["mskill_painter_coater"] as const;
const MAINTENANCE_TECHNICIAN = ["mskill_maintenance_technician"] as const;
const PLC_AUTOMATION_TECH = ["mskill_plc_automation_tech"] as const;
const EDM_WIRECUT_OPERATOR = ["mskill_edm_wirecut_operator"] as const;
const HEAT_TREATMENT_TECH = ["mskill_heat_treatment_tech"] as const;
const FOUNDRY_FORGING_OPERATOR = ["mskill_foundry_forging_operator"] as const;
const IMM_OPERATOR = ["mskill_imm_operator"] as const;
const PRODUCTION_SUPERVISOR = ["mskill_production_supervisor"] as const;
const INDUSTRIAL_ELECTRICIAN = ["mskill_industrial_electrician"] as const;
const ASSEMBLY_LINE_WORKER = ["mskill_assembly_line_worker"] as const;

// ── The Wave 1 trades of CEO pack v2 (#3011) — each pack-only skill, named once ────────────────
// Minted by #3001 with no role and no corpus id, so the trade's own form is the only evidence.
const CNC_ROUTER_OPERATOR = ["mskill_cnc_router_operator"] as const;
const CMM_OPERATOR = ["mskill_cmm_operator"] as const;
const QUALITY_ENGINEER = ["mskill_quality_engineer"] as const;
const MAINTENANCE_ENGINEER = ["mskill_maintenance_engineer"] as const;
const PRODUCTION_ENGINEER = ["mskill_production_engineer"] as const;
const PROCESS_ENGINEER = ["mskill_process_engineer"] as const;
const NPD_ENGINEER = ["mskill_npd_engineer"] as const;
const PPC_ENGINEER = ["mskill_ppc_engineer"] as const;
const PURCHASE_ENGINEER = ["mskill_purchase_engineer"] as const;
const FOUNDRY_OPERATOR = ["mskill_foundry_operator"] as const;
const DIE_CASTING_OPERATOR = ["mskill_die_casting_operator"] as const;
const FORGING_OPERATOR = ["mskill_forging_operator"] as const;
/** A second-skill chip's skill (pack "Chips that add a second match skill"). */
const ROBOT_OPERATOR_PROGRAMMER = ["mskill_robot_operator_programmer"] as const;
/** The 3D CAD trade rides the ROLE bridge to `mskill_cad_designer_3d`. */
const CAD_DESIGNER_3D = ["role_cad_designer_3d"] as const;

// ── The Wave 2 trades of CEO pack v2 (#3016) — each pack-only skill, named once ─────────────────
// Minted by #3001 with no role and no corpus id, so the trade's own form is the only evidence.
const GEAR_CUTTING_OPERATOR = ["mskill_gear_cutting_operator"] as const;
const BORING_MACHINE_OPERATOR = ["mskill_boring_machine_operator"] as const;
const SPM_FINISHING_OPERATOR = ["mskill_spm_finishing_operator"] as const;
const FABRICATOR = ["mskill_fabricator"] as const;
const TUBE_BENDING_OPERATOR = ["mskill_tube_bending_operator"] as const;
const PLATING_OPERATOR = ["mskill_plating_operator"] as const;
const BLOW_MOULDING_OPERATOR = ["mskill_blow_moulding_operator"] as const;
const PLASTIC_EXTRUSION_OPERATOR = ["mskill_plastic_extrusion_operator"] as const;
const RUBBER_MOULDING_OPERATOR = ["mskill_rubber_moulding_operator"] as const;
const NDT_TECHNICIAN = ["mskill_ndt_technician"] as const;
const CALIBRATION_TECHNICIAN = ["mskill_calibration_technician"] as const;
const MATERIAL_LAB_TECHNICIAN = ["mskill_material_lab_technician"] as const;
const INSTRUMENTATION_TECHNICIAN = ["mskill_instrumentation_technician"] as const;
const HVAC_RAC_TECHNICIAN = ["mskill_hvac_rac_technician"] as const;
const UTILITY_OPERATOR = ["mskill_utility_operator"] as const;
const FORKLIFT_OPERATOR = ["mskill_forklift_operator"] as const;
/** A second-skill chip's skill (pack "Chips that add a second match skill"). */
const CRANE_OPERATOR = ["mskill_crane_operator"] as const;

/**
 * `pack_id` → `attribute_key` (= the pack item's `question_key`) → `option_key` → taxonomy ids.
 *
 * The VALUES stored in `worker_attributes` are the option's `value_text`, which equals its
 * `option_key` for every option mapped here — asserted against the pack JSON in
 * `apps/api/src/match/form-onboarding-match-skills.test.ts`.
 */
export const PACK_ANSWER_SKILLS: Readonly<Record<string, PackMap>> = {
  // ══ CNC TURNING ═════════════════════════════════════════════════════════════════════════════
  // B0b's original table, moved here unchanged. DELIBERATELY ABSENT, each for a stated reason:
  //   turning_experience  a duration, read from experience.total_years
  //   material_worked     what he cut, not what he can do
  //   tolerance_band      a precision claim, not a skill; §4.3 display-only
  //   sector_worked       §4.3 "Display only. Never a matching input — locked"
  //   advanced_capability live tooling / bar feeder / sub-spindle have no corpus ids
  //   quality_work        checking your own first piece is not a quality inspector's chair
  //   troubleshooting     symptoms he has handled, with no corpus id to carry them
  // `edit_program` maps to the setter-level attribute (no reach); only `write_program` and `cam`
  // claim a programmer's chair. `haas`/`mazak`/`unknown_controller` have no corpus id.
  // `turn_mill`/`live_tool`/`c_axis`/`twin_spindle` (E1 slot-2 chips) carry none either: they
  // describe the machine's capability, not a distinct matchable skill, and the axis features
  // already capture via `axis_capability` on VMC. `both_types` (Track A #1) is CNC + manual in
  // one tap, so it carries exactly the manual lathe's set; `hard_turning` is turning work.
  // `fagor`/`syntec` have no corpus id (same rule as `haas`/`mazak`).
  // `conventional_lathe` keeps its legacy CNC Turner reach (owner ruling, #2022 point 1) and also
  // carries the manual machinist's skill — the same set a centre lathe derives on the manual form.
  qp_cnc_turning: {
    turning_machine: {
      cnc_lathe: ["skill_turning"],
      conventional_lathe: MANUAL_LATHE,
      both_types: MANUAL_LATHE,
      vtl: ["skill_turning"],
      sliding_head: ["skill_turning"],
      spm: ["skill_turning"],
    },
    turning_operation: {
      facing_od: ["skill_turning"],
      grooving: ["skill_turning"],
      knurling: ["skill_turning"],
      hard_turning: ["skill_turning"],
      boring: ["skill_boring"],
      drilling: ["skill_drilling"],
      threading: ["skill_tapping_threading"],
    },
    controller_brand: {
      fanuc: ["skill_fanuc"],
      siemens: ["skill_siemens"],
      mitsubishi: ["skill_mitsubishi"],
    },
    workholding: {
      three_jaw: ["skill_fixture_setup"],
      four_jaw: ["skill_fixture_setup"],
      collet: ["skill_fixture_setup"],
      soft_jaw: ["skill_fixture_setup"],
      tailstock: ["skill_fixture_setup"],
      steady_rest: ["skill_fixture_setup"],
    },
    setting_operation: {
      tool_offset: ["skill_tool_offset_setting"],
      work_offset: ["skill_tool_offset_setting"],
      nose_radius: ["skill_tool_offset_setting"],
      jaw_change: ["skill_fixture_setup"],
      tailstock_set: ["skill_fixture_setup"],
    },
    measuring_tools: {
      vernier: ["skill_measuring_instruments"],
      micrometer: ["skill_measuring_instruments"],
      bore_gauge: ["skill_measuring_instruments"],
      height_gauge: ["skill_measuring_instruments"],
      plug_gauge: ["skill_measuring_instruments"],
      dial_indicator: ["skill_measuring_instruments"],
    },
    drawing_reading: {
      basic_drawing: ["skill_drawing_reading"],
      gdt: ["skill_drawing_reading"],
    },
    programming_level: {
      offset_only: ["skill_tool_offset_setting"],
      edit_program: ["skill_program_editing"],
      write_program: ["skill_cnc_programming"],
      cam: ["skill_cam_software"],
    },
  },

  // ══ VMC / MILLING ═══════════════════════════════════════════════════════════════════════════
  // "Aap kaunsi milling machine chalate hain?" `vmc` is a VMC claim (`skill_milling` →
  // VMC Operator). `hmc` has no corpus id, so it rides the ROLE bridge to `mskill_hmc_operator`.
  // `conventional_mill` / `bed_mill` are MANUAL mills: they reach VMC Operator (owner ruling,
  // #2022 point 1, re-adding #2019's rows) plus the manual machinist's own skill. `spm` names no
  // trade; `other_machine` names nothing.
  qp_vmc_milling: {
    milling_machine: {
      vmc: ["skill_milling"],
      // Track A #2 (@6): the sheet-2 machine variants are VMC claims too.
      fourth_axis: ["skill_milling"],
      five_axis: ["skill_milling"],
      drill_tap: ["skill_milling"],
      double_column: ["skill_milling"],
      hmc: ["role_hmc_operator"],
      conventional_mill: MANUAL_MILL,
      bed_mill: MANUAL_MILL,
    },
    // Same question, same two posting-level chips as the turner's.
    programming_level: {
      write_program: ["skill_cnc_programming"],
      cam: ["skill_cam_software"],
    },
  },

  // ══ CNC GRINDING ════════════════════════════════════════════════════════════════════════════
  // "Machine CNC hai ya conventional?" — every answer is a grinding claim, and all three reach CNC
  // Grinding Operator: `conventional` is re-added by the owner's ruling (#2022 point 1), the same
  // reach a free-text "grinding" has always had. It does NOT take the manual machinist's skill: a
  // manual grinder is the ITI Machinist (Grinder) trade, not the lathe-and-mill hand that
  // `mskill_conventional_machinist` names. The machine-type question (cylindrical, surface…)
  // stays unmapped — `grinding_type` already carries the claim.
  qp_cnc_grinding: {
    grinding_type: {
      cnc: ["skill_grinding_ops"],
      conventional: ["skill_grinding_ops"],
      both: ["skill_grinding_ops"],
    },
  },

  // ══ CONVENTIONAL MACHINING (#2022) ══════════════════════════════════════════════════════════
  // "Aap kaunsi machine chalate hain?" — every named machine is a manual-machining claim. The
  // lathe and the mill also reach their CNC skill (owner ruling, #2022 point 1, re-adding #2019's
  // rows); drill, boring, shaper and slotter have no CNC counterpart and take only the manual
  // machinist's skill. The operation rows are #2019's: turning/facing and knurling are lathe work,
  // milling/slotting is mill work. Screw cutting, drilling, tapping and marking are left out — a
  // fitter does them at the bench, so they do not by themselves claim the machinist's chair.
  // `iti_workshop_machines` is training, not work, and stays unmapped as in every pack.
  qp_conventional_machining: {
    machining_machine: {
      centre_lathe: MANUAL_LATHE,
      vertical_milling: MANUAL_MILL,
      radial_drill: MANUAL_MACHINE,
      boring_machine: MANUAL_MACHINE,
      shaper_planer: MANUAL_MACHINE,
      slotter: MANUAL_MACHINE,
    },
    machining_operation: {
      turning_facing: MANUAL_LATHE,
      knurling: MANUAL_LATHE,
      milling_slotting: MANUAL_MILL,
    },
  },

  // ══ TOOL & DIE MAKING (#2022) ═══════════════════════════════════════════════════════════════
  // "Aap kaunsa tooling banate hain?" — making a press tool, die, jig, gauge or mould IS the trade.
  // The machines he runs (surface grinder, wire-cut, mill, lathe) are not mapped: a machine is not
  // a claim to build tooling, and mapping them to the CNC skills would be the proxy rule 2 bans.
  qp_tool_die_making: {
    tooling_made: {
      press_tool: TOOL_DIE_MAKER,
      progressive_die: TOOL_DIE_MAKER,
      jig_fixture: TOOL_DIE_MAKER,
      check_gauge: TOOL_DIE_MAKER,
      metal_mould: TOOL_DIE_MAKER,
    },
  },

  // ══ SHEET METAL FABRICATION (#2022) ═════════════════════════════════════════════════════════
  // "Sheet metal ki kaunsi machine chalate hain?" — the stem scopes every machine to sheet work.
  // "Sheet par kaunsa kaam khud karte hain?" — the forming and cutting operations are the trade.
  // `spot_welding` (a welding claim, and a sheet metal worker is not a welder) and `deburring`
  // (every shop's finishing chore) are left out.
  qp_sheet_metal_fab: {
    sheet_metal_machine: {
      fibre_laser: SHEET_METAL_WORKER,
      cnc_press_brake: SHEET_METAL_WORKER,
      turret_punch: SHEET_METAL_WORKER,
      shearing: SHEET_METAL_WORKER,
      plasma_cutting: SHEET_METAL_WORKER,
    },
    sheet_operation: {
      development_layout: SHEET_METAL_WORKER,
      bending: SHEET_METAL_WORKER,
      notching: SHEET_METAL_WORKER,
      punching: SHEET_METAL_WORKER,
      rolling: SHEET_METAL_WORKER,
    },
  },

  // ══ PRESS OPERATION (#2022) ═════════════════════════════════════════════════════════════════
  // "Kaunsi press machine chalate hain?" — every named press is a press claim (metal forming only,
  // R4-a). "Kaunse die par kaam kiya hai?" — running a blanking, progressive or drawing die is the
  // press operator's work. Safety systems and maintenance chores are not mapped.
  qp_press_operation: {
    press_machine: {
      mechanical_power_press: PRESS_OPERATOR,
      hydraulic_press: PRESS_OPERATOR,
      pneumatic_press: PRESS_OPERATOR,
      press_brake: PRESS_OPERATOR,
      fly_press: PRESS_OPERATOR,
    },
    press_die_type: {
      blanking_piercing: PRESS_OPERATOR,
      progressive: PRESS_OPERATOR,
      compound: PRESS_OPERATOR,
      bending_forming: PRESS_OPERATOR,
      deep_drawing: PRESS_OPERATOR,
    },
  },

  // ══ POWDER COATING / PAINTING (#2022) ═══════════════════════════════════════════════════════
  // "Aap kaunsa coating ka kaam karte hain?" — every process, touch-up included, is the trade.
  // Booth, oven and pretreatment EQUIPMENT is not mapped: a man who loads the oven or runs the
  // pretreatment tank has not claimed to coat.
  qp_powder_coating: {
    coating_process: {
      powder_coating: PAINTER_COATER,
      liquid_hvlp: PAINTER_COATER,
      electrostatic: PAINTER_COATER,
      touch_up: PAINTER_COATER,
    },
  },

  // ══ MAINTENANCE TECHNICIAN (#2022) ══════════════════════════════════════════════════════════
  // "Aap kis tarah ki maintenance karte hain?" — every discipline is a maintenance claim, and
  // `basic_electrical` stays a MAINTENANCE claim: it does not make him an industrial electrician.
  // "Maintenance me kaunse kaam aap khud karte hain?" — preventive, breakdown, condition
  // monitoring and shutdown overhaul are the technician's chair. Spare planning (stores work) and
  // following a lubrication schedule (the oiler's round) are left out.
  qp_maintenance_tech: {
    maintenance_discipline: {
      mechanical: MAINTENANCE_TECHNICIAN,
      hydraulic: MAINTENANCE_TECHNICIAN,
      pneumatic: MAINTENANCE_TECHNICIAN,
      basic_electrical: MAINTENANCE_TECHNICIAN,
    },
    maintenance_type: {
      preventive: MAINTENANCE_TECHNICIAN,
      breakdown: MAINTENANCE_TECHNICIAN,
      condition_monitoring: MAINTENANCE_TECHNICIAN,
      shutdown_overhaul: MAINTENANCE_TECHNICIAN,
    },
  },

  // ══ INDUSTRIAL ELECTRICIAN (#2022) ══════════════════════════════════════════════════════════
  // "Aap kis tarah ka bijli kaam karte hain?" — panel wiring and motor/drive work are the plant
  // electrician's. `lighting_power` (a building wireman says it too), `cable_laying` (a laying
  // gang's job) and `earthing` (domestic as much as industrial) are left out: the skill is
  // INDUSTRIAL Electrician, and those chips do not claim the plant. "Kaunse electrical equipment
  // par kaam karte hain?" — MCC/PCC panels, VFDs, starters and induction motors are plant
  // equipment. `dg_set` is left out: a DG set is run by an operator as often as by an electrician.
  // ══ PRODUCTION SUPERVISOR (Phase 2 #10) ═════════════════════════════════════════════════
  // "Kis department ki supervision karte hain?" — every named department is the trade's claim:
  // the answer says he supervises a production area, which is the job. The none-of-above
  // escape ("unknown") claims nothing.
  qp_production_supervisor: {
    supervision_area: {
      machine_shop: PRODUCTION_SUPERVISOR,
      assembly: PRODUCTION_SUPERVISOR,
      press_sheet_metal: PRODUCTION_SUPERVISOR,
      fabrication_welding: PRODUCTION_SUPERVISOR,
      moulding: PRODUCTION_SUPERVISOR,
      paint_shop: PRODUCTION_SUPERVISOR,
      packaging: PRODUCTION_SUPERVISOR,
      // v2 (sheet T45, #3011) asks the kept key with the sheet's shop chips; the same rule.
      press_shop: PRODUCTION_SUPERVISOR,
      weld_shop: PRODUCTION_SUPERVISOR,
      casting_forging: PRODUCTION_SUPERVISOR,
      packing: PRODUCTION_SUPERVISOR,
    },
  },

  // ══ INJECTION MOULDING (Phase 2 #9) ═════════════════════════════════════════════════════
  // "Kaunse brand ki machine chalayi hai?" — every named moulding-machine brand is the trade's
  // claim (the brand IS the injection moulding machine). The tool room's mould chips
  // (qp_tool_die_making) stay the tool maker's: building the mould is not running it.
  qp_injection_moulding: {
    moulding_machine_brand: {
      ferromatik_milacron: IMM_OPERATOR,
      windsor: IMM_OPERATOR,
      jsw: IMM_OPERATOR,
      toshiba: IMM_OPERATOR,
      haitian: IMM_OPERATOR,
      engel: IMM_OPERATOR,
      arburg: IMM_OPERATOR,
      larsen_toubro: IMM_OPERATOR,
      // v2 (sheet T29, #3011): the sheet's brand chips under the kept key, the same rule.
      milacron: IMM_OPERATOR,
      shibaura: IMM_OPERATOR,
      electronica: IMM_OPERATOR,
    },
  },

  // ══ FOUNDRY / FORGING (Phase 2 #11) ═══════════════════════════════════════════════════════
  // "Foundry ya forging me kaunsa kaam karte hain?" — every named casting or forging process
  // is the trade's claim. Metal, equipment and testing are depth (hardness is QC's word too).
  qp_foundry_forging: {
    foundry_process: {
      sand_moulding: FOUNDRY_FORGING_OPERATOR,
      shell_moulding: FOUNDRY_FORGING_OPERATOR,
      die_casting: FOUNDRY_FORGING_OPERATOR,
      investment_casting: FOUNDRY_FORGING_OPERATOR,
      hammer_forging: FOUNDRY_FORGING_OPERATOR,
      press_forging: FOUNDRY_FORGING_OPERATOR,
      upset_forging: FOUNDRY_FORGING_OPERATOR,
      melting: FOUNDRY_FORGING_OPERATOR,
      fettling: FOUNDRY_FORGING_OPERATOR,
      core_making: FOUNDRY_FORGING_OPERATOR,
    },
  },

  // ══ HEAT TREATMENT (Phase 2 #8) ══════════════════════════════════════════════════════════
  // "Kaunsa heat treatment process karte hain?" — every named HT process is the trade's claim.
  // Furnaces, testing and material are depth: Rockwell and hardness are QC's words too.
  qp_heat_treatment: {
    heat_process: {
      hardening_tempering: HEAT_TREATMENT_TECH,
      case_carburising: HEAT_TREATMENT_TECH,
      nitriding: HEAT_TREATMENT_TECH,
      induction_hardening: HEAT_TREATMENT_TECH,
      annealing_normalising: HEAT_TREATMENT_TECH,
      vacuum_heat_treatment: HEAT_TREATMENT_TECH,
      salt_bath: HEAT_TREATMENT_TECH,
      // v2 (sheet T27, #3011) splits v1's paired chips and adds three processes; every named
      // HT process is still the claim.
      carburising: HEAT_TREATMENT_TECH,
      carbonitriding: HEAT_TREATMENT_TECH,
      annealing: HEAT_TREATMENT_TECH,
      normalising: HEAT_TREATMENT_TECH,
      stress_relieving: HEAT_TREATMENT_TECH,
      austempering: HEAT_TREATMENT_TECH,
    },
  },

  // ══ EDM / WIRE-CUT (Phase 2 #7) ════════════════════════════════════════════════════════
  // "Kaunsi EDM machine chalate hain?" — every named EDM machine is the trade's claim. The
  // tool room's own EDM chips (qp_tool_die_making edm_work) stay the tool maker's.
  qp_edm_wirecut: {
    edm_machine: {
      wire_cut: EDM_WIRECUT_OPERATOR,
      sinker_edm: EDM_WIRECUT_OPERATOR,
      hole_drill: EDM_WIRECUT_OPERATOR,
      small_hole: EDM_WIRECUT_OPERATOR,
      // v2 (CEO pack v2, sheet T17, #3008) asks the kept key with the sheet's own machine chips.
      // The same rule as v1: every named EDM machine is the claim. The v1 rows above stay for
      // the workers who gave those values (#3008 §4).
      wirecut: EDM_WIRECUT_OPERATOR,
      moly_wirecut: EDM_WIRECUT_OPERATOR,
      znc_sinker: EDM_WIRECUT_OPERATOR,
      cnc_sinker: EDM_WIRECUT_OPERATOR,
      edm_drill: EDM_WIRECUT_OPERATOR,
    },
  },

  // ══ PLC / AUTOMATION (Phase 2 #6) ═══════════════════════════════════════════════════════
  // "Kaunsa PLC chalate hain?" and "Automation me kya kya karte hain?" — a named PLC or a
  // programming / HMI / drive / commissioning task is the trade's claim. Panel wiring and
  // I/O checks alone are the electrician's work too (A3), so they stay unmapped here:
  // reach comes from the programming side of the trade, never from wiring.
  qp_plc_automation: {
    plc_brand: {
      siemens: PLC_AUTOMATION_TECH,
      allen_bradley: PLC_AUTOMATION_TECH,
      mitsubishi: PLC_AUTOMATION_TECH,
      delta: PLC_AUTOMATION_TECH,
      omron: PLC_AUTOMATION_TECH,
      schneider: PLC_AUTOMATION_TECH,
      fuji: PLC_AUTOMATION_TECH,
      keyence: PLC_AUTOMATION_TECH,
    },
    plc_work: {
      program_editing: PLC_AUTOMATION_TECH,
      program_writing: PLC_AUTOMATION_TECH,
      hmi_scada: PLC_AUTOMATION_TECH,
      vfd_servo: PLC_AUTOMATION_TECH,
      robot_teaching: PLC_AUTOMATION_TECH,
      commissioning: PLC_AUTOMATION_TECH,
      // v2 (sheet T38, #3011): the same programming-side claims under the sheet's own keys.
      // `online_monitoring`, `io_checking`, `panel_wiring` and `program_backup` stay unmapped:
      // a maintenance electrician watches a PLC online, checks I/O, wires a panel and takes a
      // backup too, so none of them claims the PLC chair (the A3 rule above).
      program_edit: PLC_AUTOMATION_TECH,
      program_write: PLC_AUTOMATION_TECH,
      hmi_design: PLC_AUTOMATION_TECH,
    },
    // SECOND-SKILL CHIP (pack "Chips that add a second match skill", #3011 §3). The chip claims
    // robot programming, so it names that skill only; the PLC skill comes from the worker's own
    // PLC answers, which the chip presupposes ("bhi karta hoon"). Every other advanced system
    // (DCS, safety PLC, vision, robot interfacing, motion, IIoT) is depth and stays unmapped.
    plc_advanced_system: {
      robot_programming: ROBOT_OPERATOR_PROGRAMMER,
    },
  },

  // ══ WAVE 1 NEW TRADES (CEO pack v2, #3011) ══════════════════════════════════════════════════
  // One claim question per form (`claimQuestionKey` in TRADE_CATALOGUE): the first mandatory
  // select after the level and confirm questions, the one the résumé headline names. Each stem
  // scopes every chip to the trade, so every chip but the none-of-above escape is the claim, and
  // the escape claims nothing. No other question of these forms is mapped (rules 1 to 3).

  // T21 "Aap kaunsi machine chalate hain?" on the router form — each machine is a router claim.
  qp_cnc_router: {
    router_machine_type: {
      wood_router: CNC_ROUTER_OPERATOR,
      atc_router: CNC_ROUTER_OPERATOR,
      multi_head: CNC_ROUTER_OPERATOR,
      rotary_axis: CNC_ROUTER_OPERATOR,
      stone_router: CNC_ROUTER_OPERATOR,
      metal_engraver: CNC_ROUTER_OPERATOR,
      jewellery_cnc: CNC_ROUTER_OPERATOR,
      laser_engraver: CNC_ROUTER_OPERATOR,
    },
  },

  // T33 "Aap kaunsi measuring machine chalate hain?" on the CMM form — the metrology-room
  // machines of the sheet, each the trade's claim. `qp_quality_inspection`'s own CMM chips stay
  // the inspector's (`skill_cmm`): pack-scoped, rule 4.
  qp_cmm: {
    cmm_machine_type: {
      bridge_cmm: CMM_OPERATOR,
      gantry_cmm: CMM_OPERATOR,
      horizontal_arm: CMM_OPERATOR,
      portable_arm: CMM_OPERATOR,
      vmm: CMM_OPERATOR,
      three_d_scanner: CMM_OPERATOR,
      profile_projector: CMM_OPERATOR,
      contour_tester: CMM_OPERATOR,
    },
  },

  // T37 "Quality me aap kaunsa area dekhte hain?" — every quality area is the engineer's claim.
  qp_quality_engineer: {
    qe_function: {
      in_process: QUALITY_ENGINEER,
      final_pdi: QUALITY_ENGINEER,
      incoming: QUALITY_ENGINEER,
      supplier_quality: QUALITY_ENGINEER,
      customer_quality: QUALITY_ENGINEER,
      qms: QUALITY_ENGINEER,
      npd_quality: QUALITY_ENGINEER,
      standards_room: QUALITY_ENGINEER,
      warranty: QUALITY_ENGINEER,
    },
  },

  // T43 "Aap maintenance ka kaunsa hissa sambhalte hain?" — every area is the engineer's claim;
  // `electrical` and `electronics_automation` stay MAINTENANCE claims here (no electrician or PLC
  // skill: rule 2).
  qp_maintenance_engineer: {
    me_function: {
      mechanical: MAINTENANCE_ENGINEER,
      electrical: MAINTENANCE_ENGINEER,
      electronics_automation: MAINTENANCE_ENGINEER,
      utility: MAINTENANCE_ENGINEER,
      tooling_maintenance: MAINTENANCE_ENGINEER,
      planning: MAINTENANCE_ENGINEER,
      projects: MAINTENANCE_ENGINEER,
      facility: MAINTENANCE_ENGINEER,
    },
  },

  // T46 "Aap kaunsi shop ya line ka production dekhte hain?" — every shop is the claim; the shop
  // names where he works, never another trade's skill (a press shop is not a press operator).
  qp_production_engineer: {
    prod_shop_type: {
      machine_shop: PRODUCTION_ENGINEER,
      press_shop: PRODUCTION_ENGINEER,
      weld_shop: PRODUCTION_ENGINEER,
      assembly: PRODUCTION_ENGINEER,
      moulding: PRODUCTION_ENGINEER,
      casting: PRODUCTION_ENGINEER,
      forging: PRODUCTION_ENGINEER,
      paint_shop: PRODUCTION_ENGINEER,
    },
  },

  // T47 "ME me aapka main kaam kya hai?" — every ME function is the claim.
  qp_process_engineer: {
    proc_function: {
      process_planning: PROCESS_ENGINEER,
      industrial_engg: PROCESS_ENGINEER,
      tooling_fixture: PROCESS_ENGINEER,
      new_line_setup: PROCESS_ENGINEER,
      tool_optimisation: PROCESS_ENGINEER,
      layout_capacity: PROCESS_ENGINEER,
      lca_poka_yoke: PROCESS_ENGINEER,
      cost_reduction_vave: PROCESS_ENGINEER,
    },
  },

  // T48 "NPD me aapka main kaam kya hai?" — every NPD function is the claim.
  qp_npd_engineer: {
    npd_function: {
      rfq_costing: NPD_ENGINEER,
      apqp_timing: NPD_ENGINEER,
      tooling_development: NPD_ENGINEER,
      gauge_fixture_development: NPD_ENGINEER,
      sample_prototype: NPD_ENGINEER,
      ppap_submission: NPD_ENGINEER,
      customer_communication: NPD_ENGINEER,
      testing_validation: NPD_ENGINEER,
      vendor_part_development: NPD_ENGINEER,
    },
  },

  // T52 "PPC me aap kaunsa kaam sambhalte hain?" — every PPC task is the claim.
  qp_ppc: {
    ppc_function: {
      production_planning: PPC_ENGINEER,
      material_planning: PPC_ENGINEER,
      dispatch_planning: PPC_ENGINEER,
      jobwork_planning: PPC_ENGINEER,
      inventory_control: PPC_ENGINEER,
      customer_schedule: PPC_ENGINEER,
      mis_reporting: PPC_ENGINEER,
    },
  },

  // T54 "Purchase me aap kaunsa kaam sambhalte hain?" — every purchase task is the claim.
  qp_purchase: {
    purchase_function: {
      po_followup: PURCHASE_ENGINEER,
      rfq_negotiation: PURCHASE_ENGINEER,
      vendor_development: PURCHASE_ENGINEER,
      npd_sourcing: PURCHASE_ENGINEER,
      jobwork_outsourcing: PURCHASE_ENGINEER,
      import_purchase: PURCHASE_ENGINEER,
      capex_purchase: PURCHASE_ENGINEER,
      payment_followup: PURCHASE_ENGINEER,
    },
  },

  // T24 "Foundry ke kaunse section me aap kaam karte hain?" — every section is the trade's
  // claim; the stem scopes each chip to foundry work. The form offers no none-of-above chip
  // on this question, so every option maps. `foundry_process` (the casting process) is the
  // next mandatory select but is not the claim: the claim is the first mandatory select
  // after the level and confirm questions (#3011 §1), and the other questions stay
  // unmapped (rules 1 to 3).
  qp_foundry_casting: {
    foundry_section: {
      moulding: FOUNDRY_OPERATOR,
      core_making: FOUNDRY_OPERATOR,
      melting: FOUNDRY_OPERATOR,
      pouring: FOUNDRY_OPERATOR,
      sand_plant: FOUNDRY_OPERATOR,
      knock_out: FOUNDRY_OPERATOR,
      fettling: FOUNDRY_OPERATOR,
      shot_blasting: FOUNDRY_OPERATOR,
      wax_shell_room: FOUNDRY_OPERATOR,
    },
  },

  // T25 "Aap kaunsi die casting karte hain?" — every named process is the trade's claim.
  // `unknown` ("Koi aur process") is the none-of-above escape and claims nothing.
  qp_die_casting: {
    diecast_process: {
      hpdc_cold: DIE_CASTING_OPERATOR,
      hpdc_hot: DIE_CASTING_OPERATOR,
      lpdc: DIE_CASTING_OPERATOR,
      gdc: DIE_CASTING_OPERATOR,
    },
  },

  // T26 "Aap kaunsi forging machine par kaam karte hain?" — every named machine is the
  // trade's claim. `unknown` ("Koi aur machine") is the none-of-above escape and claims
  // nothing. `forging_type` (the forging process) is the next mandatory select but is not
  // the claim: the claim is the first mandatory select after the level and confirm
  // questions (#3011 §1).
  qp_forging: {
    forging_machine: {
      drop_hammer: FORGING_OPERATOR,
      power_hammer: FORGING_OPERATOR,
      screw_press: FORGING_OPERATOR,
      forging_press: FORGING_OPERATOR,
      hydraulic_press: FORGING_OPERATOR,
      upsetter: FORGING_OPERATOR,
      ring_rolling_mill: FORGING_OPERATOR,
      bolt_former: FORGING_OPERATOR,
    },
  },

  // ══ WAVE 2 NEW TRADES (CEO pack v2, #3016) ══════════════════════════════════════════════════
  // One claim question per form (the trade-specific first question after the experience, level
  // and confirm questions): the machine, process or type question the pack's first posting key
  // names. Each stem scopes every chip to the trade, so every chip but the none-of-above escape
  // is the claim, and the escape claims nothing. Only the two second-skill chips named on the
  // pack ("Chips that add a second match skill") map a second question; no other question of
  // these forms is mapped (rules 1 to 3). T49 Safety has no related trade and is untouched —
  // Wave 3 (#3016 step 5 leaves the statutory trade alone).

  // T18 "Gear ka kaunsa process aap karte hain?" — every named gear process is the claim.
  qp_gear_cutting: {
    gear_process: {
      hobbing: GEAR_CUTTING_OPERATOR,
      shaping: GEAR_CUTTING_OPERATOR,
      shaving: GEAR_CUTTING_OPERATOR,
      gear_grinding: GEAR_CUTTING_OPERATOR,
      bevel_generating: GEAR_CUTTING_OPERATOR,
      broaching: GEAR_CUTTING_OPERATOR,
      gear_milling: GEAR_CUTTING_OPERATOR,
      spline_rolling: GEAR_CUTTING_OPERATOR,
      chamfer_deburr: GEAR_CUTTING_OPERATOR,
    },
  },

  // T19 "Aap kaunsi boring machine chalate hain?" — every named Boring machine is the claim.
  // `unknown` is the none-of-above escape and claims nothing.
  qp_boring_machine: {
    boring_machine_type: {
      table_type_hbm: BORING_MACHINE_OPERATOR,
      floor_borer: BORING_MACHINE_OPERATOR,
      jig_boring: BORING_MACHINE_OPERATOR,
      plano_miller: BORING_MACHINE_OPERATOR,
      heavy_vtl: BORING_MACHINE_OPERATOR,
      portable_line_boring: BORING_MACHINE_OPERATOR,
    },
  },

  // T20 "Aap kaunsa process karte hain?" — every named finishing process is the claim.
  qp_spm_finishing: {
    spm_process: {
      honing: SPM_FINISHING_OPERATOR,
      broaching: SPM_FINISHING_OPERATOR,
      lapping: SPM_FINISHING_OPERATOR,
      superfinishing: SPM_FINISHING_OPERATOR,
      gun_drilling: SPM_FINISHING_OPERATOR,
      thread_rolling: SPM_FINISHING_OPERATOR,
      centring_facing: SPM_FINISHING_OPERATOR,
      multi_spindle: SPM_FINISHING_OPERATOR,
      burnishing: SPM_FINISHING_OPERATOR,
    },
  },

  // T22 "Aap kis tarah ka fabrication karte hain?" — every fabrication type is the claim.
  qp_fabrication: {
    fab_work_type: {
      structural: FABRICATOR,
      pressure_vessel: FABRICATOR,
      storage_tank: FABRICATOR,
      peb: FABRICATOR,
      machine_frame: FABRICATOR,
      chassis_body: FABRICATOR,
      ducting: FABRICATOR,
      piping_spool: FABRICATOR,
      gate_grill: FABRICATOR,
    },
  },

  // T23 "Aap kaunsi machine chalate hain?" — every named tube machine is the claim.
  // `unknown` is the none-of-above escape and claims nothing.
  qp_tube_forming: {
    tube_machine_type: {
      cnc_mandrel_bender: TUBE_BENDING_OPERATOR,
      nc_bender: TUBE_BENDING_OPERATOR,
      manual_bender: TUBE_BENDING_OPERATOR,
      three_roll_bender: TUBE_BENDING_OPERATOR,
      roll_forming_line: TUBE_BENDING_OPERATOR,
      tube_mill: TUBE_BENDING_OPERATOR,
      end_forming_machine: TUBE_BENDING_OPERATOR,
      tube_cutting_machine: TUBE_BENDING_OPERATOR,
    },
  },

  // T28 "Aap kaunsi plating ya coating karte hain?" — every named finish is the claim.
  qp_surface_treatment: {
    plating_process: {
      zinc: PLATING_OPERATOR,
      nickel_chrome: PLATING_OPERATOR,
      hard_chrome: PLATING_OPERATOR,
      anodising: PLATING_OPERATOR,
      phosphating: PLATING_OPERATOR,
      blackening: PLATING_OPERATOR,
      electroless_nickel: PLATING_OPERATOR,
      ced: PLATING_OPERATOR,
      hot_dip_galvanising: PLATING_OPERATOR,
    },
  },

  // T30 "Aap kaunsi blow moulding karte hain?" — every named blow process is the claim.
  // `unknown` is the none-of-above escape and claims nothing.
  qp_blow_moulding: {
    blow_process_type: {
      extrusion_blow: BLOW_MOULDING_OPERATOR,
      stretch_blow: BLOW_MOULDING_OPERATOR,
      single_stage_isbm: BLOW_MOULDING_OPERATOR,
      injection_blow: BLOW_MOULDING_OPERATOR,
      accumulator_head: BLOW_MOULDING_OPERATOR,
      multilayer: BLOW_MOULDING_OPERATOR,
    },
  },

  // T31 "Aap kaunsi extrusion line chalate hain?" — every named product line is the claim.
  // `unknown` is the none-of-above escape and claims nothing.
  qp_plastic_extrusion: {
    extrusion_product_line: {
      pipe: PLASTIC_EXTRUSION_OPERATOR,
      profile: PLASTIC_EXTRUSION_OPERATOR,
      blown_film: PLASTIC_EXTRUSION_OPERATOR,
      sheet: PLASTIC_EXTRUSION_OPERATOR,
      cable: PLASTIC_EXTRUSION_OPERATOR,
      tape_monofilament: PLASTIC_EXTRUSION_OPERATOR,
      compounding: PLASTIC_EXTRUSION_OPERATOR,
      recycling: PLASTIC_EXTRUSION_OPERATOR,
    },
  },

  // T32 "Rubber ka kaunsa kaam aap karte hain?" — every named rubber process is the claim.
  qp_rubber_moulding: {
    rubber_process: {
      compression: RUBBER_MOULDING_OPERATOR,
      transfer: RUBBER_MOULDING_OPERATOR,
      rubber_injection: RUBBER_MOULDING_OPERATOR,
      mixing: RUBBER_MOULDING_OPERATOR,
      rubber_extrusion: RUBBER_MOULDING_OPERATOR,
      calendering: RUBBER_MOULDING_OPERATOR,
      autoclave_hose: RUBBER_MOULDING_OPERATOR,
      tyre: RUBBER_MOULDING_OPERATOR,
      finishing: RUBBER_MOULDING_OPERATOR,
    },
  },

  // T34 "Aap kaunsa NDT method karte hain?" — every named method is the technician's claim.
  qp_ndt: {
    ndt_method: {
      ut: NDT_TECHNICIAN,
      rt: NDT_TECHNICIAN,
      mpt: NDT_TECHNICIAN,
      dpt: NDT_TECHNICIAN,
      vt: NDT_TECHNICIAN,
      ect: NDT_TECHNICIAN,
      paut: NDT_TECHNICIAN,
      tofd: NDT_TECHNICIAN,
      thickness_gauging: NDT_TECHNICIAN,
    },
  },

  // T35 "Aap kaunse parameter ka calibration karte hain?" — every parameter is the claim.
  qp_calibration: {
    calib_parameter: {
      dimensional: CALIBRATION_TECHNICIAN,
      pressure: CALIBRATION_TECHNICIAN,
      temperature: CALIBRATION_TECHNICIAN,
      electrical: CALIBRATION_TECHNICIAN,
      torque: CALIBRATION_TECHNICIAN,
      mass: CALIBRATION_TECHNICIAN,
      force: CALIBRATION_TECHNICIAN,
      volume: CALIBRATION_TECHNICIAN,
      flow: CALIBRATION_TECHNICIAN,
    },
  },

  // T36 "Lab me aap kaunse test karte hain?" — every named lab test is the claim.
  qp_material_lab: {
    matlab_test_type: {
      spectro: MATERIAL_LAB_TECHNICIAN,
      hardness: MATERIAL_LAB_TECHNICIAN,
      tensile: MATERIAL_LAB_TECHNICIAN,
      impact: MATERIAL_LAB_TECHNICIAN,
      microstructure: MATERIAL_LAB_TECHNICIAN,
      case_depth: MATERIAL_LAB_TECHNICIAN,
      salt_spray: MATERIAL_LAB_TECHNICIAN,
      sand_testing: MATERIAL_LAB_TECHNICIAN,
      wet_chemical: MATERIAL_LAB_TECHNICIAN,
    },
  },

  // T39 "Kaunse brand ke robot par kaam kiya hai?" — every named robot brand is the claim.
  // `unknown` is the none-of-above escape and claims nothing.
  qp_robotics: {
    robot_brand: {
      fanuc: ROBOT_OPERATOR_PROGRAMMER,
      yaskawa: ROBOT_OPERATOR_PROGRAMMER,
      abb: ROBOT_OPERATOR_PROGRAMMER,
      kuka: ROBOT_OPERATOR_PROGRAMMER,
      kawasaki: ROBOT_OPERATOR_PROGRAMMER,
      nachi: ROBOT_OPERATOR_PROGRAMMER,
      panasonic: ROBOT_OPERATOR_PROGRAMMER,
      universal_robots: ROBOT_OPERATOR_PROGRAMMER,
    },
    // SECOND-SKILL CHIP (pack "Chips that add a second match skill", #3016 §3). The chip claims
    // PLC ladder work, so it names that skill only; the robot skill comes from the worker's own
    // robot answers, which the chip presupposes ("bhi khud banata hoon"). Every other interface
    // (I/O check, handshake signals, fieldbus, safety config) is depth and stays unmapped.
    robot_plc_interface: {
      plc_programming: PLC_AUTOMATION_TECH,
    },
  },

  // T40 "Kaunse instrument par aapne kaam kiya hai?" — every instrument family is the claim.
  qp_instrumentation: {
    instr_instrument_type: {
      pressure: INSTRUMENTATION_TECHNICIAN,
      temperature: INSTRUMENTATION_TECHNICIAN,
      flow: INSTRUMENTATION_TECHNICIAN,
      level: INSTRUMENTATION_TECHNICIAN,
      control_valve: INSTRUMENTATION_TECHNICIAN,
      on_off_valve: INSTRUMENTATION_TECHNICIAN,
      analyser: INSTRUMENTATION_TECHNICIAN,
      weighing: INSTRUMENTATION_TECHNICIAN,
    },
  },

  // T41 "Aapne kaunse AC ya refrigeration system par kaam kiya hai?" — every system is the claim.
  qp_hvac_rac: {
    hvac_system_type: {
      split_window: HVAC_RAC_TECHNICIAN,
      ductable_package: HVAC_RAC_TECHNICIAN,
      vrf_vrv: HVAC_RAC_TECHNICIAN,
      chiller: HVAC_RAC_TECHNICIAN,
      ahu_fcu: HVAC_RAC_TECHNICIAN,
      cold_storage: HVAC_RAC_TECHNICIAN,
      ammonia_plant: HVAC_RAC_TECHNICIAN,
      process_chiller: HVAC_RAC_TECHNICIAN,
      precision_ac: HVAC_RAC_TECHNICIAN,
    },
  },

  // T42 "Aap kaunsa utility plant chalate hain?" — every utility plant is the claim.
  qp_utility: {
    utility_plant_type: {
      steam_boiler: UTILITY_OPERATOR,
      thermic_fluid_heater: UTILITY_OPERATOR,
      air_compressor: UTILITY_OPERATOR,
      dg_set: UTILITY_OPERATOR,
      etp_stp: UTILITY_OPERATOR,
      water_treatment: UTILITY_OPERATOR,
      cooling_tower_pump: UTILITY_OPERATOR,
      chiller_plant: UTILITY_OPERATOR,
      substation_log: UTILITY_OPERATOR,
    },
  },

  // T56 "Aap kaunsi gaadi chalate hain?" — every driven truck is the forklift claim, EXCEPT the
  // hydra crane: it is the SECOND-SKILL CHIP (pack "Chips that add a second match skill",
  // #3016 §3) and names the crane skill only, the way the PLC form's robot chip names only the
  // robot skill. A hand pallet truck is the yard's own equipment and stays the forklift claim:
  // the form offers no none-of-above escape on this question.
  qp_forklift: {
    forklift_equipment: {
      counterbalance: FORKLIFT_OPERATOR,
      reach_truck: FORKLIFT_OPERATOR,
      stacker: FORKLIFT_OPERATOR,
      bopt: FORKLIFT_OPERATOR,
      order_picker: FORKLIFT_OPERATOR,
      tow_truck: FORKLIFT_OPERATOR,
      hydra_crane: CRANE_OPERATOR,
      telehandler: FORKLIFT_OPERATOR,
      hand_pallet: FORKLIFT_OPERATOR,
    },
  },

  // T57 "Aap crane chalate hain ya rigging karte hain?" — operating, rigging, both and
  // signalling are all the trade's claim. The form offers no none-of-above escape here.
  qp_crane_rigging: {
    crane_role: {
      crane_operator: CRANE_OPERATOR,
      rigger: CRANE_OPERATOR,
      both: CRANE_OPERATOR,
      signalman: CRANE_OPERATOR,
    },
  },

  qp_industrial_electrician: {
    electrical_work_type: {
      panel_wiring: INDUSTRIAL_ELECTRICIAN,
      motor_drive: INDUSTRIAL_ELECTRICIAN,
    },
    electrical_equipment: {
      mcc_pcc: INDUSTRIAL_ELECTRICIAN,
      vfd_drive: INDUSTRIAL_ELECTRICIAN,
      starter: INDUSTRIAL_ELECTRICIAN,
      induction_motor: INDUSTRIAL_ELECTRICIAN,
    },
  },

  // ══ ASSEMBLY LINE (#2022) ═══════════════════════════════════════════════════════════════════
  // "Line ke kaunse stage par kaam kiya hai?" — every assembly stage, rework included, is line
  // work. `line_feeding` ("line feeding aur kitting") is material handling and is left out.
  qp_assembly_line: {
    assembly_stage: {
      sub_assembly: ASSEMBLY_LINE_WORKER,
      final_assembly: ASSEMBLY_LINE_WORKER,
      end_of_line: ASSEMBLY_LINE_WORKER,
      rework: ASSEMBLY_LINE_WORKER,
    },
  },

  // ══ CAM PROGRAMMING ═════════════════════════════════════════════════════════════════════════
  // "Program aap CAM software par banate hain ya machine par?" — both answers are programming
  // claims, of two different chairs. `no_programming` is an honest no.
  qp_cam_programming: {
    programming_mode: {
      cam_software: ["skill_cam_software"],
      machine_mdi: ["skill_cnc_programming"],
      both_modes: ["skill_cam_software", "skill_cnc_programming"],
    },
    // "Aap kaunsa CAM software chalate hain?" A named package is a CAM claim; `other_software`
    // names nothing. Track A #3 (@4): the sheet-3 packages claim the same chair.
    cam_software: {
      mastercam: ["skill_cam_software"],
      powermill: ["skill_cam_software"],
      solidcam: ["skill_cam_software"],
      edgecam: ["skill_cam_software"],
      nx_cam: ["skill_cam_software"],
      fusion: ["skill_cam_software"],
      hypermill: ["skill_cam_software"],
      cimatron: ["skill_cam_software"],
      worknc: ["skill_cam_software"],
      esprit: ["skill_cam_software"],
      // MDI-only: a programming claim without a CAM seat — the CNC programmer's skill.
      manual_gcode: ["skill_cnc_programming"],
    },
  },

  // ══ 3D CAD DESIGN (Track A #4) ════════════════════════════════════════════════
  // "Aap kaunsa 3D software chalate hain?" A named package is a 3D claim; `other_software`
  // names nothing. The role bridge derives the trade's permanent ID directly.
  // v2 (sheet T58, #3011) keeps `design_software` and puts `design_work_area` first: "Aap kis
  // cheez ka design karte hain?" — every design area is the trade's claim, and it is v2's claim
  // question. v2's `autocad` chip ("AutoCAD, 2D ke liye") stays unmapped: 2D drafting is the
  // draughtsman's trade, and AutoCAD alone does not say he models (the CAD drafting rule below).
  qp_cad_design_3d: {
    design_software: {
      solidworks: ["role_cad_designer_3d"],
      creo: ["role_cad_designer_3d"],
      nx: ["role_cad_designer_3d"],
      catia: ["role_cad_designer_3d"],
      inventor: ["role_cad_designer_3d"],
      fusion: ["role_cad_designer_3d"],
      solid_edge: ["role_cad_designer_3d"],
    },
    design_work_area: {
      product_design: CAD_DESIGNER_3D,
      spm_machine: CAD_DESIGNER_3D,
      sheet_metal: CAD_DESIGNER_3D,
      plastic_part: CAD_DESIGNER_3D,
      jig_fixture: CAD_DESIGNER_3D,
      press_tool: CAD_DESIGNER_3D,
      mould_design: CAD_DESIGNER_3D,
      biw_fixture: CAD_DESIGNER_3D,
      reverse_engg: CAD_DESIGNER_3D,
    },
  },
  // ══ CAD DRAFTING ════════════════════════════════════════════════════════════════════
  // The MODULE he works in is the claim, not the brand of software: "AutoCAD" alone does not say
  // whether he drafts or models. `other_module` names nothing.
  qp_cad_drafting: {
    cad_modules: {
      two_d_drafting: ["skill_cad_2d_drafting"],
      three_d_modelling: ["skill_3d_modeling"],
      assembly_module: ["skill_3d_modeling"],
      sheet_metal: ["skill_3d_modeling"],
      surface_module: ["skill_3d_modeling"],
    },
    drawing_type: {
      two_d_only: ["skill_cad_2d_drafting"],
      tracing: ["skill_cad_2d_drafting"],
      model_to_drawing: ["skill_3d_modeling", "skill_cad_2d_drafting"],
      model_and_drawing: ["skill_3d_modeling", "skill_cad_2d_drafting"],
    },
  },

  // ══ WELDING ═════════════════════════════════════════════════════════════════════════════════
  // "Aap kaunsi welding karte hain?" — each process is its own claim. Gas cutting and spot
  // welding have no match skill (`skill_gas_cutting` maps to `[]`: cutting does not make a
  // welder), so they are left out.
  qp_welding_trade: {
    welding_process: {
      mig_mag: ["skill_mig_welding"],
      arc: ["skill_arc_welding"],
      tig: ["skill_tig_welding"],
    },
    // "Kaunsi welding machine par kaam karte hain?" — the set names the process it runs.
    welding_equipment: {
      co_two_mig: ["skill_mig_welding"],
      inverter_arc: ["skill_arc_welding"],
      tig_machine: ["skill_tig_welding"],
    },
  },

  // ══ FITTER ══════════════════════════════════════════════════════════════════════════════════
  // "Aap kis tarah ka fitting kaam karte hain?" — the stem scopes every option to fitting work.
  // Assembly and bench fitting have their own corpus ids; maintenance and erection fitting are
  // fitting with no narrower id, so they take the occupation anchor. `other_fitting` names
  // nothing.
  qp_fitter: {
    fitter_work_type: {
      assembly_fitting: ["skill_mechanical_assembly"],
      bench_fitting: ["skill_bench_fitting"],
      maintenance_fitting: FITTER_OCCUPATION,
      erection_commissioning: FITTER_OCCUPATION,
    },
  },

  // ══ QUALITY INSPECTION ══════════════════════════════════════════════════════════════════════
  // "Kis stage par inspection karte hain?" — every stage is an inspection claim. Instruments are
  // NOT mapped, except the CMM: a vernier is every operator's, a CMM is an inspector's.
  qp_quality_inspection: {
    inspection_stage: {
      incoming: ["skill_quality_control"],
      in_process_patrol: ["skill_quality_control"],
      final_inspection: ["skill_quality_control"],
      layout_inspection: ["skill_quality_control"],
      // `gauge_rr` ("Gauge R&R me madad") is helping with a study, not an inspection stage.
    },
    measuring_tools: {
      cmm: ["skill_cmm"],
    },
    inspection_cmm_work: {
      run_program: ["skill_cmm"],
      write_program: ["skill_cmm"],
      part_alignment: ["skill_cmm"],
      cmm_report: ["skill_cmm"],
    },
  },
};

/**
 * Role packs that ship a form and DELIBERATELY derive no match skill — the trade has no
 * `mskill_*` in the V1 vocabulary, and the owner ruled out a nearest-skill proxy (2026-10-06).
 *
 * This list is the follow-up for the owner, not a TODO for an engineer: closing any row means
 * minting a match skill (a taxonomy decision), after which its pack gets an entry above. A test
 * pins that a fully-answered form for each of these derives nothing.
 *
 * EMPTY SINCE #2022. The owner minted a match skill for all eight trades that sat here
 * (conventional machining, tool & die, sheet metal, press, coating, maintenance, industrial
 * electrician, assembly line), and each pack now has an entry above. The list and its guards stay,
 * so the next form that ships without a skill has somewhere honest to go.
 */
export const PACKS_WITHOUT_MATCH_SKILL: readonly string[] = [];

/** One stored answer, carrying the `pack_id` off its own `worker_attributes` row. */
export interface PackAnswer {
  readonly packId: string | null;
  readonly attributeKey: string;
  readonly optionKeys: readonly string[];
}

/** The ids a worker's pack answers imply, split by the bridge each one rides. */
export interface PackAnswerEvidence {
  /** `skill_*` corpus ids → `deriveWorkerSkills({ profileSkills })`. Sorted, deduped. */
  readonly corpusSkillIds: string[];
  /** `role_*` ids → `deriveWorkerSkills({ additionalRoleIds })`. Sorted, deduped. */
  readonly roleIds: string[];
  /**
   * PACK-ONLY `mskill_*` ids, named directly by the table → `deriveWorkerSkills({ matchSkillIds })`.
   * Sorted, deduped, closed-set.
   */
  readonly matchSkillIds: MatchSkillId[];
}

/**
 * The taxonomy ids one worker's pack answers imply.
 *
 * PER-ROW PACK, NOT ONE PACK PER WORKER: a worker answers `qp_universal`'s tail AND a role pack,
 * so his attribute bag mixes provenances. A null `pack_id` (the finishing form writes these)
 * matches nothing. Unknown packs, keys and options are ignored rather than rejected: a pack that
 * grows a question must not stop an existing worker's reach from rebuilding.
 *
 * Deterministic: sorted, deduped, same input → same output, independent of input order.
 */
export function packAnswerEvidence(answers: readonly PackAnswer[]): PackAnswerEvidence {
  const corpus = new Set<string>();
  const roles = new Set<string>();
  const direct = new Set<MatchSkillId>();
  for (const { packId, attributeKey, optionKeys } of answers) {
    if (packId === null) continue;
    const options = PACK_ANSWER_SKILLS[packId]?.[attributeKey];
    if (!options) continue;
    for (const optionKey of optionKeys) {
      for (const id of options[optionKey] ?? []) {
        if (isMatchSkillId(id)) direct.add(id);
        else (id.startsWith("role_") ? roles : corpus).add(id);
      }
    }
  }
  return {
    corpusSkillIds: [...corpus].sort(),
    roleIds: [...roles].sort(),
    matchSkillIds: [...direct].sort(),
  };
}

/**
 * The match skills ONE emitted id reaches, through the route `deriveWorkerSkills` takes for it:
 * a pack-only `mskill_*` is itself, a `role_*` rides the role bridge, a `skill_*` the attribute
 * bridge. Unknown → `[]`. The single resolver every report and test uses, so none of them
 * re-implements the routing.
 */
export function matchSkillsForPackAnswerId(id: string): readonly MatchSkillId[] {
  if (isMatchSkillId(id)) return [id];
  if (id.startsWith("role_")) {
    const viaRole = matchSkillForRole(id);
    return viaRole === undefined ? [] : [viaRole];
  }
  return matchSkillsForAttribute(id);
}

/**
 * The match skills a FULLY-answered form for this pack can derive — the union over every mapped
 * option. An upper bound: a real worker derives the subset his chips claim. Sorted.
 */
export function packReachableMatchSkills(packId: string): MatchSkillId[] {
  const out = new Set<MatchSkillId>();
  for (const options of Object.values(PACK_ANSWER_SKILLS[packId] ?? {})) {
    for (const ids of Object.values(options)) {
      for (const id of ids) for (const m of matchSkillsForPackAnswerId(id)) out.add(m);
    }
  }
  return [...out].sort();
}

/** Every id the table can emit — the surface a taxonomy retag has to keep covering. */
export function packAnswerIdsEmitted(): PackAnswerTaxonomyId[] {
  const ids = new Set<PackAnswerTaxonomyId>();
  for (const attributes of Object.values(PACK_ANSWER_SKILLS)) {
    for (const options of Object.values(attributes)) {
      for (const emitted of Object.values(options)) for (const id of emitted) ids.add(id);
    }
  }
  return [...ids].sort();
}

/** The `worker_attributes` columns a pack answer is read from — the shape both readers select. */
export interface StoredPackAttributeRow {
  readonly packId: string | null;
  readonly attributeKey: string;
  readonly valueText: unknown;
  readonly valueTextList: unknown;
}

/**
 * One `worker_attributes` row → the {@link PackAnswer} it holds, or `null` when it holds no text.
 *
 * SHARED BY BOTH READERS — `WorkerSkillsRepository.findPackAttributeOptions` (live) and
 * `db:backfill:worker-skills` (batch). They used to differ in whether they read pack answers at
 * all, and the batch side's silence pruned rows the live side wrote. One normaliser means the two
 * cannot disagree about what a row says. A list wins over a scalar; non-strings are dropped.
 */
export function packAnswerFromStoredRow(row: StoredPackAttributeRow): PackAnswer | null {
  const values = Array.isArray(row.valueTextList)
    ? row.valueTextList.filter((v): v is string => typeof v === "string")
    : typeof row.valueText === "string"
      ? [row.valueText]
      : [];
  if (values.length === 0) return null;
  return { packId: row.packId, attributeKey: row.attributeKey, optionKeys: values };
}
