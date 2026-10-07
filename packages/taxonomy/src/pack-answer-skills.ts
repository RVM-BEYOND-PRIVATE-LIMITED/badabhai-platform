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
const INDUSTRIAL_ELECTRICIAN = ["mskill_industrial_electrician"] as const;
const ASSEMBLY_LINE_WORKER = ["mskill_assembly_line_worker"] as const;

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
  // `conventional_lathe` keeps its legacy CNC Turner reach (owner ruling, #2022 point 1) and also
  // carries the manual machinist's skill — the same set a centre lathe derives on the manual form.
  qp_cnc_turning: {
    turning_machine: {
      cnc_lathe: ["skill_turning"],
      conventional_lathe: MANUAL_LATHE,
      vtl: ["skill_turning"],
      sliding_head: ["skill_turning"],
      spm: ["skill_turning"],
    },
    turning_operation: {
      facing_od: ["skill_turning"],
      grooving: ["skill_turning"],
      knurling: ["skill_turning"],
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
    // names nothing.
    cam_software: {
      mastercam: ["skill_cam_software"],
      powermill: ["skill_cam_software"],
      solidcam: ["skill_cam_software"],
      edgecam: ["skill_cam_software"],
    },
  },

  // ══ CAD DRAFTING ════════════════════════════════════════════════════════════════════════════
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
