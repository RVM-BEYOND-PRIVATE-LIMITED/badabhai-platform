import type { AnswerRecord } from "@badabhai/ai-contracts";
import { loadQuestionPackCorpus, type PackRecord } from "@badabhai/db";
import type { MatchSkillId } from "@badabhai/taxonomy";

import { projectProfile, type ProjectedAttribute } from "../profiling/answer-map-projector";
import type { TradeFormKind } from "../profiling/roles/role-registry";

/**
 * TEST-ONLY. What a worker onboarded through each trade form (or a structured-answer chat that ran
 * the same role pack) leaves in `worker_attributes`, built through the SAME projector both
 * surfaces call — so a fixture cannot drift from the shape the real writers store.
 */

/** One realistic onboarding per enabled trade form, and the match skills it must derive. */
export interface TradeFormCase {
  readonly kind: TradeFormKind;
  /** Chip answers by `question_key` → `option_key`s — what the worker tapped. */
  readonly answers: Readonly<Record<string, readonly string[]>>;
  /** Exactly the `mskill_*` set this onboarding must derive. `[]` = the trade has none. */
  readonly expected: readonly MatchSkillId[];
}

/**
 * ONE ROW PER ENABLED FORM KIND — `form-onboarding-match-skills.test.ts` fails if a kind is added
 * to the registry without a row here, so a new trade form cannot ship without a reach decision.
 *
 * Every answer set includes the trade's tenure question and a universal-looking chip that maps to
 * nothing, so "derives exactly X" is tested against a realistic bag, not a single chip.
 */
export const TRADE_FORM_CASES: readonly TradeFormCase[] = [
  {
    kind: "cnc_turner",
    answers: { turning_experience: ["three_to_seven"], turning_machine: ["cnc_lathe"] },
    expected: ["mskill_cnc_turner"],
  },
  {
    kind: "vmc_milling",
    answers: { milling_experience: ["one_to_three"], milling_machine: ["vmc"] },
    expected: ["mskill_vmc_operator"],
  },
  {
    kind: "cnc_grinding",
    answers: {
      grinding_experience: ["one_to_three"],
      grinding_machine: ["cylindrical"],
      grinding_type: ["cnc"],
    },
    expected: ["mskill_cnc_grinding_operator"],
  },
  {
    kind: "conventional_machinist",
    answers: { machining_experience: ["over_seven"], machining_machine: ["centre_lathe"] },
    // #2022: a manual lathe reaches CNC Turner (point 1) and the manual machinist's own skill.
    expected: ["mskill_cnc_turner", "mskill_conventional_machinist"],
  },
  {
    kind: "tool_die_maker",
    answers: {
      toolroom_experience: ["three_to_seven"],
      tooling_made: ["press_tool", "progressive_die"],
      toolroom_machine: ["surface_grinder", "milling", "lathe"],
    },
    // The machines he runs do not make him a CNC hand; the tooling he builds is the claim.
    expected: ["mskill_tool_die_maker"],
  },
  {
    kind: "cam_programmer",
    answers: { programming_experience: ["one_to_three"], programming_mode: ["cam_software"] },
    expected: ["mskill_cam_programmer"],
  },
  {
    kind: "cad_draughtsman",
    answers: { drafting_experience: ["one_to_three"], cad_modules: ["two_d_drafting"] },
    expected: ["mskill_designer"],
  },
  {
    kind: "welder",
    answers: {
      welding_experience: ["three_to_seven"],
      welding_process: ["mig_mag"],
      welding_position: ["flat", "vertical"],
    },
    expected: ["mskill_mig_welder"],
  },
  {
    kind: "sheet_metal_worker",
    answers: {
      sheet_metal_experience: ["one_to_three"],
      sheet_metal_machine: ["cnc_press_brake", "fibre_laser"],
      sheet_operation: ["bending", "spot_welding"],
    },
    // Spot welding does not make him a welder.
    expected: ["mskill_sheet_metal_worker"],
  },
  {
    kind: "press_operator",
    answers: { press_experience: ["one_to_three"], press_machine: ["mechanical_power_press"] },
    expected: ["mskill_press_operator"],
  },
  {
    kind: "painter_coating",
    answers: { coating_experience: ["one_to_three"], coating_process: ["powder_coating"] },
    expected: ["mskill_painter_coater"],
  },
  {
    kind: "fitter",
    answers: { fitting_experience: ["three_to_seven"], fitter_work_type: ["maintenance_fitting"] },
    expected: ["mskill_fitter"],
  },
  {
    kind: "maintenance_technician",
    answers: {
      maintenance_experience: ["three_to_seven"],
      maintenance_discipline: ["mechanical", "hydraulic"],
    },
    expected: ["mskill_maintenance_technician"],
  },
  {
    kind: "industrial_electrician",
    answers: {
      electrical_experience: ["three_to_seven"],
      electrical_work_type: ["panel_wiring", "motor_drive"],
    },
    // His own skill — never the fitter proxy.
    expected: ["mskill_industrial_electrician"],
  },
  {
    kind: "assembly_line_worker",
    answers: { assembly_experience: ["one_to_three"], assembly_stage: ["sub_assembly"] },
    expected: ["mskill_assembly_line_worker"],
  },
  {
    kind: "quality_inspector",
    answers: { inspection_experience: ["one_to_three"], inspection_stage: ["final_inspection"] },
    expected: ["mskill_quality_inspector"],
  },
];

const LATEST = new Map<string, PackRecord>();
for (const pack of loadQuestionPackCorpus().packs) {
  const held = LATEST.get(pack.pack_id);
  if (!held || pack.version > held.version) LATEST.set(pack.pack_id, pack);
}

/** The latest corpus version of a pack, as authored (raw option values intact). */
export function latestPack(packId: string): PackRecord {
  const pack = LATEST.get(packId);
  if (!pack) throw new Error(`${packId} is not in the corpus`);
  return pack;
}

/**
 * Chip answers → the attributes both writers store, via the real projector.
 *
 * MIRRORS `TradeFormService.recordFor`'s chips branch: unknown keys throw, a single-select keeps
 * one value, and each option stores its VALUE (`value_text`, else `value_number` — the tenure
 * options), never its key. The interview's `answer-capture` writes the same values, which is why
 * one helper stands in for both surfaces.
 */
export function attributesFor(
  pack: PackRecord,
  answers: Readonly<Record<string, readonly string[]>>,
): readonly ProjectedAttribute[] {
  return projectProfile(answerRecordsFor(pack, answers)).attributes;
}

/**
 * Chip answers → the answer-map records the interview's capture writes for them: each option's
 * stored VALUE, a list for a multi-select, one value for a single-select. Unknown keys throw.
 */
export function answerRecordsFor(
  pack: PackRecord,
  answers: Readonly<Record<string, readonly string[]>>,
): AnswerRecord[] {
  return Object.entries(answers).map(([questionKey, optionKeys]) => {
    const item = pack.items.find((candidate) => candidate.question_key === questionKey);
    if (!item) throw new Error(`${pack.pack_id} has no question ${questionKey}`);
    const values = optionKeys.map((key) => {
      const option = (item.options ?? []).find((candidate) => candidate.option_key === key);
      if (!option) throw new Error(`${pack.pack_id}.${questionKey} has no option ${key}`);
      const value = option.value_text ?? option.value_number ?? option.value_bool;
      if (value === null || value === undefined) throw new Error(`${key} carries no value`);
      return value;
    });
    return {
      question_key: item.question_key,
      target_field: item.target_field ?? null,
      value_raw: null,
      evidence: null,
      turn: 0,
      history: [],
      value_normalized: item.answer_type === "single_select" ? values[0]! : values,
      status: "answered",
    };
  });
}

/** One structured chat on a GENERIC family pack (#2021), and the match skills it must derive. */
export interface GenericPackChatCase {
  readonly packId: string;
  /** Chip answers by `question_key` → `option_key`s, as in {@link TradeFormCase}. */
  readonly answers: Readonly<Record<string, readonly string[]>>;
  /** Exactly the `mskill_*` set this chat must derive. `[]` = the trade has none. */
  readonly expected: readonly MatchSkillId[];
}

/**
 * Generic-pack chats: welding and plumbing must reach their match skills; electrical reaches the
 * industrial electrician only from `industrial` / `panel` (#2075); a trade with no match skill must
 * derive nothing; and `furniture` under painting must not borrow carpentry's meaning.
 * Each bag carries an attribute-kind answer too, so "derives exactly X" is tested against a
 * realistic chat and not a single chip.
 */
export const GENERIC_PACK_CHAT_CASES: readonly GenericPackChatCase[] = [
  {
    packId: "qp_welding",
    answers: { welding_process: ["mig", "arc"], welding_position: ["yes"] },
    expected: ["mskill_arc_welder", "mskill_mig_welder"],
  },
  {
    packId: "qp_plumbing",
    answers: { plumbing_scope: ["household", "drainage"], pipe_material: ["pvc"] },
    expected: ["mskill_plumber"],
  },
  // #2075 (owner ruling 2026-10-07): `industrial` / `panel` claim the industrial electrician,
  // through the separate pack-only path, never through `worker_profiles.skills`.
  {
    packId: "qp_electrical",
    answers: {
      electrical_scope: ["house_wiring", "panel", "motor"],
      voltage_level: ["three_phase"],
    },
    expected: ["mskill_industrial_electrician"],
  },
  // House wiring and motor winding are not plant work: no proxy.
  {
    packId: "qp_electrical",
    answers: { electrical_scope: ["house_wiring", "motor"] },
    expected: [],
  },
  {
    packId: "qp_painting",
    answers: { painting_scope: ["furniture", "building"] },
    expected: [],
  },
];
