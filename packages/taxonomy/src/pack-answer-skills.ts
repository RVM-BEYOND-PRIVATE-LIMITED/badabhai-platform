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
 * WHAT AN ENTRY MAY EMIT — exactly two kinds of id, each through an EXISTING bridge:
 *   - `skill_*` corpus ids → `ATTRIBUTE_TO_MATCH_SKILLS` (the attribute bridge)
 *   - `role_*` canonical roles → `ROLE_TO_MATCH_SKILL` (the role bridge), used ONLY where a chip
 *     names an occupation that has a match skill and no corpus id (`hmc` → `role_hmc_operator`).
 * Nothing here emits an `mskill_*` id directly. Whether an answer implies a postable skill is the
 * taxonomy's decision, made once in those bridges, for chat and form workers alike.
 *
 * THE RULES AN ENTRY MUST PASS — read before extending:
 *
 *   1. **Map only what a chip literally claims.** The question stem is part of the claim: "Aap
 *      kaunsi welding karte hain?" → "TIG" is a TIG claim. "Kaunse measuring instrument chala
 *      lete hain?" → "micrometer" is not a quality inspector's claim.
 *   2. **No nearest-skill proxy (owner ruling, 2026-10-06).** A trade with no match skill derives
 *      NOTHING. An electrician is not a fitter, a press operator is not a CNC operator, a sheet
 *      metal worker is not a welder. Those packs have NO entry, by design — see
 *      `PACKS_WITHOUT_MATCH_SKILL` below — and a test pins that a fully-answered form for any of
 *      them derives zero match skills.
 *   3. **Being routed to a pack is not a claim.** No entry keys off which form the worker was
 *      handed; a worker who answered nothing about his trade derives nothing.
 *   4. **Pack-scoped, never global (R12 §2.1).** `drawing_reading`, `measuring_tools`,
 *      `programming_level` and a dozen more keys recur across packs with different meanings. An
 *      entry applies only to answers stored under ITS pack id.
 *
 * POSTING-LEVEL ONLY, EXCEPT FOR THE TURNER. `qp_cnc_turning` predates this file and also emits
 * attribute-level corpus ids (fixtures, offsets, Fanuc) that map to `[]` in the attribute bridge;
 * it is carried over unchanged so no turner's derivation moves. The packs added in this file emit
 * only ids that reach a posting — an inert id would be review surface with no effect on reach.
 *
 * WRITES NOTHING. This runs on the derive READ path, so a taxonomy retag changes a worker's reach
 * on his next rebuild instead of leaving a stale row behind.
 */

/** A taxonomy id a pack answer may imply: a corpus attribute (`skill_*`) or a role (`role_*`). */
export type PackAnswerTaxonomyId = `skill_${string}` | `role_${string}`;

type OptionMap = Readonly<Record<string, readonly PackAnswerTaxonomyId[]>>;
type PackMap = Readonly<Record<string, OptionMap>>;

/** Every fitting the fitter pack's stem scopes to fitting work — the occupation anchor. */
const FITTER_OCCUPATION = ["skill_fitter_occupation"] as const;

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
  qp_cnc_turning: {
    turning_machine: {
      cnc_lathe: ["skill_turning"],
      conventional_lathe: ["skill_turning"],
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
  // `conventional_mill` / `bed_mill` are MANUAL machines: a manual miller is not a VMC operator,
  // and the owner ruled out a nearest-skill proxy — they derive nothing.
  qp_vmc_milling: {
    milling_machine: {
      vmc: ["skill_milling"],
      hmc: ["role_hmc_operator"],
    },
    // Same question, same two posting-level chips as the turner's.
    programming_level: {
      write_program: ["skill_cnc_programming"],
      cam: ["skill_cam_software"],
    },
  },

  // ══ CNC GRINDING ════════════════════════════════════════════════════════════════════════════
  // The match skill is CNC Grinding Operator, so the claim that reaches it is the CNC one:
  // "Machine CNC hai ya conventional?" → `cnc` / `both`. The machine-type question
  // (cylindrical, surface, tool & cutter…) does not say CNC, and a manual grinder is not a CNC
  // grinding operator — `conventional` derives nothing (no proxy).
  qp_cnc_grinding: {
    grinding_type: {
      cnc: ["skill_grinding_ops"],
      both: ["skill_grinding_ops"],
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
 */
export const PACKS_WITHOUT_MATCH_SKILL = [
  // Manual lathe / mill / drill. CNC Turner and VMC Operator are the only machining match
  // skills, and mapping a manual machinist to them is exactly the proxy the ruling forbids.
  "qp_conventional_machining",
  "qp_tool_die_making",
  "qp_sheet_metal_fab",
  "qp_press_operation",
  "qp_powder_coating",
  "qp_maintenance_tech",
  "qp_industrial_electrician",
  "qp_assembly_line",
] as const;

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
  for (const { packId, attributeKey, optionKeys } of answers) {
    if (packId === null) continue;
    const options = PACK_ANSWER_SKILLS[packId]?.[attributeKey];
    if (!options) continue;
    for (const optionKey of optionKeys) {
      for (const id of options[optionKey] ?? []) {
        (id.startsWith("role_") ? roles : corpus).add(id);
      }
    }
  }
  return { corpusSkillIds: [...corpus].sort(), roleIds: [...roles].sort() };
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
