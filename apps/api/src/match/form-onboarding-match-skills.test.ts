import { describe, expect, it } from "vitest";
import type { PackRecord } from "@badabhai/db";
import { deriveWorkerSkills, workerSkillDeriveInput } from "@badabhai/match-engine";
import {
  PACK_ANSWER_SKILLS,
  PACKS_WITHOUT_MATCH_SKILL,
  TRADE_CATALOGUE,
  packAnswerFromStoredRow,
} from "@badabhai/taxonomy";

import type { ProjectedAttribute } from "../profiling/answer-map-projector";
import { descriptorForKind, TRADE_FORM_KINDS } from "../profiling/roles/role-registry";
import {
  allPackVersions,
  answerRecordsFor,
  attributesFor,
  latestPack,
  TRADE_FORM_CASES,
} from "./form-onboarding.test-support";

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * EVERY TRADE FORM YIELDS THE RIGHT MATCH SKILLS — OR, BY RULING, NONE.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * THE BUG (#2018). Under Matching V1 only the CNC-turning form produced `worker_skill` rows: the pack-answer
 * bridge covered `qp_cnc_turning` alone, so a welder, grinder, fitter or QC inspector onboarded
 * through their trade form (or through a structured-answer chat that ran the same role pack)
 * derived nothing and saw an EMPTY job feed.
 *
 * THE PIPELINE UNDER TEST is the real one end to end, minus the database (the `.db` twin holds
 * that half): chips → the projector both surfaces call → the stored row shape → the shared row
 * normaliser → the pack-answer bridge → `deriveWorkerSkills`.
 */

/** What `WorkerSkillsService.rebuildForWorker` derives for a pack-only worker. */
function derive(
  packId: string,
  attributes: readonly ProjectedAttribute[],
  profile: { totalYears: number | null; sourceSession?: unknown } | null = null,
): string[] {
  const answers = attributes.flatMap((attribute) => {
    const answer = packAnswerFromStoredRow({
      packId,
      attributeKey: attribute.attributeKey,
      valueText: attribute.valueKind === "text" ? attribute.value : null,
      valueTextList: attribute.valueKind === "text_list" ? attribute.value : null,
    });
    return answer ? [answer] : [];
  });
  // THE SHARED ASSEMBLY both writers call — not a hand-built input — so this test exercises the
  // exact code the live rebuild and the backfill run. Both surfaces leave the canonical role
  // null (`toExtractionOutput` hardcodes it; the form writes no profile row at all).
  const input = workerSkillDeriveInput({
    profile:
      profile === null
        ? null
        : {
            canonicalRoleId: null,
            profileSkills: [],
            totalYears: profile.totalYears,
            sourceSession: profile.sourceSession ?? null,
          },
    secondaryRoleIds: [],
    packAnswers: answers,
  });
  if (input === null) return [];
  return deriveWorkerSkills(input)
    .map((row) => row.skillId)
    .sort();
}

describe("the case table covers every trade form that ships", () => {
  it("has exactly one case per enabled form kind", () => {
    // A new trade form cannot ship without a reach decision: add its case (and, if it has a
    // match skill, its PACK_ANSWER_SKILLS entry) or this goes red.
    expect(TRADE_FORM_CASES.map((c) => c.kind).sort()).toEqual([...TRADE_FORM_KINDS].sort());
  });

  it("classifies every enabled form's pack as mapped XOR ruled to have no match skill", () => {
    const noSkill = new Set<string>(PACKS_WITHOUT_MATCH_SKILL);
    for (const kind of TRADE_FORM_KINDS) {
      const packId = descriptorForKind(kind)!.packId;
      const mapped = packId in PACK_ANSWER_SKILLS;
      expect(mapped !== noSkill.has(packId), `${kind} (${packId}) is unclassified or both`).toBe(
        true,
      );
    }
  });
});

describe.each(TRADE_FORM_CASES)(
  "a $kind onboarded through the form",
  ({ kind, answers, expected }) => {
    const packId = descriptorForKind(kind)!.packId;
    const pack = latestPack(packId);

    it(`derives exactly ${expected.length === 0 ? "nothing" : expected.join(" + ")}`, () => {
      expect(derive(packId, attributesFor(pack, answers))).toEqual([...expected].sort());
    });

    it("derives the same set through a structured-answer chat (profile row, null role, [] skills)", () => {
      // The chat writes a `worker_profiles` row with `canonical_role_id` null and `skills` [] plus
      // the same attribute rows; only tenure differs, and tenure never changes the SET.
      expect(derive(packId, attributesFor(pack, answers), { totalYears: 6 })).toEqual(
        [...expected].sort(),
      );
    });

    it("derives nothing for the same answers stored under a different pack", () => {
      // Pack-scoping (R12 §2.1): routing is not a claim, and another trade's table must not apply.
      expect(derive("qp_universal", attributesFor(pack, answers))).toEqual([]);
    });
  },
);

describe("no nearest-skill proxy — a trade with no match skill derives NOTHING (owner ruling)", () => {
  it("is vacuous today: #2022 minted a skill for every trade form that had none", () => {
    // The guard below stays armed for the next form that ships without a skill.
    expect(PACKS_WITHOUT_MATCH_SKILL).toEqual([]);
  });

  it.skipIf(PACKS_WITHOUT_MATCH_SKILL.length === 0).each([...PACKS_WITHOUT_MATCH_SKILL])(
    "%s: every chip of every question reaches no skill",
    (packId) => {
      const pack = latestPack(packId);
      for (const item of pack.items) {
        for (const option of item.options ?? []) {
          if (option.value_text === undefined && option.value_number === undefined) continue;
          expect(
            derive(packId, attributesFor(pack, { [item.question_key]: [option.option_key] })),
            `${packId}.${item.question_key}.${option.option_key} reached a match skill`,
          ).toEqual([]);
        }
      }
    },
  );
});

describe("the reachable set per mapped pack — every chip, exhaustively", () => {
  /**
   * The bridge is a UNION over independent options, so the union of single-chip derivations IS
   * the reachable set for every combination. Pinning it exactly means a new mapping that widens
   * any trade's reach has to be written here too — on purpose, in review.
   */
  const REACHABLE: Readonly<Record<string, readonly string[]>> = {
    qp_cnc_turning: [
      "mskill_cam_programmer",
      "mskill_cnc_programmer",
      "mskill_cnc_turner",
      "mskill_conventional_machinist",
    ],
    qp_vmc_milling: [
      "mskill_cam_programmer",
      "mskill_cnc_programmer",
      "mskill_conventional_machinist",
      "mskill_hmc_operator",
      "mskill_vmc_operator",
    ],
    qp_cnc_grinding: ["mskill_cnc_grinding_operator"],
    qp_cam_programming: ["mskill_cam_programmer", "mskill_cnc_programmer"],
    // Middle Way E0 (Q3): the CAD drafting pack's 3D-module chips now reach the 3D
    // designer; 2D chips stay on the (relabeled) 2D ID. Reach widening, written
    // here explicitly per this table's contract.
    qp_cad_drafting: ["mskill_3d_designer", "mskill_designer"],
    // CEO Launch Plan Pack v1, Track A #4: the new trade's software answers
    // derive its permanent ID directly (role bridge); the E0 ID stays related.
    qp_cad_design_3d: ["mskill_cad_designer_3d"],
    qp_welding_trade: ["mskill_arc_welder", "mskill_mig_welder", "mskill_tig_welder"],
    qp_fitter: ["mskill_fitter"],
    qp_quality_inspection: ["mskill_quality_inspector"],
    // #2022 — each minted trade reaches its own skill; the manual machinist's lathe and mill
    // chips also reach the CNC skills (owner ruling, point 1).
    qp_conventional_machining: [
      "mskill_cnc_turner",
      "mskill_conventional_machinist",
      "mskill_vmc_operator",
    ],
    qp_tool_die_making: ["mskill_tool_die_maker"],
    qp_sheet_metal_fab: ["mskill_sheet_metal_worker"],
    qp_press_operation: ["mskill_press_operator"],
    qp_powder_coating: ["mskill_painter_coater"],
    qp_maintenance_tech: ["mskill_maintenance_technician"],
    // Phase 2 #6: the new PLC trade reaches its own permanent ID; #3011 §3: v2's second-skill
    // chip (robot programming) adds the robot skill.
    qp_plc_automation: ["mskill_plc_automation_tech", "mskill_robot_operator_programmer"],
    qp_edm_wirecut: ["mskill_edm_wirecut_operator"],
    qp_heat_treatment: ["mskill_heat_treatment_tech"],
    qp_injection_moulding: ["mskill_imm_operator"],
    qp_production_supervisor: ["mskill_production_supervisor"],
    qp_foundry_forging: ["mskill_foundry_forging_operator"],
    qp_industrial_electrician: ["mskill_industrial_electrician"],
    qp_assembly_line: ["mskill_assembly_line_worker"],
    // #3011: the nine new Wave 1 trades each reach their own skill and nothing else.
    qp_cnc_router: ["mskill_cnc_router_operator"],
    qp_cmm: ["mskill_cmm_operator"],
    qp_quality_engineer: ["mskill_quality_engineer"],
    qp_maintenance_engineer: ["mskill_maintenance_engineer"],
    qp_production_engineer: ["mskill_production_engineer"],
    qp_process_engineer: ["mskill_process_engineer"],
    qp_npd_engineer: ["mskill_npd_engineer"],
    qp_ppc: ["mskill_ppc_engineer"],
    qp_purchase: ["mskill_purchase_engineer"],
  };

  it("pins every mapped pack", () => {
    expect(Object.keys(REACHABLE).sort()).toEqual(Object.keys(PACK_ANSWER_SKILLS).sort());
  });

  // EVERY VERSION'S CHIPS, because a stored answer outlives its version (#3008 §4): a worker who
  // answered a deepened form's v1 keeps the skill his v1 answer earned after v2 is active.
  it.each(Object.entries(REACHABLE))("%s reaches exactly its own trade", (packId, reachable) => {
    const seen = new Set<string>();
    for (const pack of allPackVersions(packId)) {
      for (const item of pack.items) {
        for (const option of item.options ?? []) {
          if (option.value_text === undefined && option.value_number === undefined) continue;
          const attrs = attributesFor(pack, { [item.question_key]: [option.option_key] });
          for (const skill of derive(packId, attrs)) seen.add(skill);
        }
      }
    }
    expect([...seen].sort()).toEqual([...reachable].sort());
  });

  // A NEW ANSWER ON v2 EARNS THE SKILL TOO. The six deepened Wave 1 forms (#3008) ship v2 under
  // their kept keys. #3008 gave EDM's v2 machine chips the v1 claim rule; #3011 did the same for
  // the other five, and added PLC's second-skill chip.
  it("a new answer on each deepened Wave 1 form's v2 reaches its own trade", () => {
    const got: Record<string, string[]> = {};
    for (const packId of Object.keys(V2_REACH_TODAY)) {
      const pack = latestPack(packId);
      expect(pack.version, packId).toBe(2);
      const seen = new Set<string>();
      for (const item of pack.items) {
        for (const option of item.options ?? []) {
          if (option.value_text === undefined && option.value_number === undefined) continue;
          const attrs = attributesFor(pack, { [item.question_key]: [option.option_key] });
          for (const skill of derive(packId, attrs)) seen.add(skill);
        }
      }
      got[packId] = [...seen].sort();
    }
    expect(got).toEqual(V2_REACH_TODAY);
  });

  it("a welder who said only MIG is not offered TIG or arc as EXACT skills", () => {
    // The relation carries him to TIG/arc postings at tier 2; the derived SET stays what he said.
    const pack = latestPack("qp_welding_trade");
    expect(
      derive("qp_welding_trade", attributesFor(pack, { welding_process: ["mig_mag"] })),
    ).toEqual(["mskill_mig_welder"]);
    expect(
      derive("qp_welding_trade", attributesFor(pack, { welding_process: ["gas_cutting", "spot"] })),
    ).toEqual([]);
  });

  it("a manual lathe derives the SAME set on the turning form and the manual form (#2022)", () => {
    const turning = latestPack("qp_cnc_turning");
    const manual = latestPack("qp_conventional_machining");
    const viaTurning = derive(
      "qp_cnc_turning",
      attributesFor(turning, { turning_machine: ["conventional_lathe"] }),
    );
    expect(viaTurning).toEqual(["mskill_cnc_turner", "mskill_conventional_machinist"]);
    const viaManual = derive(
      "qp_conventional_machining",
      attributesFor(manual, { machining_machine: ["centre_lathe"] }),
    );
    expect(viaManual).toEqual(viaTurning);
  });

  it("a manual grinder reaches CNC Grinding Operator (#2022 point 1)", () => {
    const pack = latestPack("qp_cnc_grinding");
    expect(
      derive("qp_cnc_grinding", attributesFor(pack, { grinding_type: ["conventional"] })),
    ).toEqual(["mskill_cnc_grinding_operator"]);
  });

  it("an HMC hand reaches the HMC skill through the ROLE bridge", () => {
    const pack = latestPack("qp_vmc_milling");
    expect(derive("qp_vmc_milling", attributesFor(pack, { milling_machine: ["hmc"] }))).toEqual([
      "mskill_hmc_operator",
    ]);
  });
});

/** Each deepened Wave 1 form's v2 → the skills its chips reach (measured, then pinned). */
const V2_REACH_TODAY: Record<string, string[]> = {
  qp_edm_wirecut: ["mskill_edm_wirecut_operator"],
  qp_heat_treatment: ["mskill_heat_treatment_tech"],
  qp_injection_moulding: ["mskill_imm_operator"],
  qp_plc_automation: ["mskill_plc_automation_tech", "mskill_robot_operator_programmer"],
  qp_production_supervisor: ["mskill_production_supervisor"],
  qp_cad_design_3d: ["mskill_cad_designer_3d"],
};

describe("the table is written against what the packs actually store", () => {
  it.each(Object.keys(PACK_ANSWER_SKILLS))(
    "%s: every mapped question and option exists, and stores its option key as its value",
    (packId) => {
      // `worker_attributes` holds the option's VALUE. The table is keyed by option KEY. They are
      // spelled the same for every mapped option — asserted, because a pack edit that made them
      // differ would silently zero this trade's reach.
      // ANY published version: a row for a value only v1 offers stays, because the workers who
      // gave it keep it (#3008 §4). Every version that asks the question must still store the
      // option key as its value.
      const versions = allPackVersions(packId);
      for (const [questionKey, options] of Object.entries(PACK_ANSWER_SKILLS[packId]!)) {
        const items = versions.flatMap((pack) =>
          pack.items.filter((candidate) => candidate.question_key === questionKey),
        );
        expect(items.length, `${packId} has no question ${questionKey}`).toBeGreaterThan(0);
        for (const item of items) {
          expect(item.target_field ?? item.question_key).toBe(questionKey);
        }
        for (const optionKey of Object.keys(options)) {
          const found = items.flatMap((item) =>
            (item.options ?? []).filter((o) => o.option_key === optionKey),
          );
          expect(
            found.length,
            `${packId}.${questionKey} has no option ${optionKey}`,
          ).toBeGreaterThan(0);
          for (const option of found) expect(option.value_text).toBe(optionKey);
        }
      }
    },
  );
});

describe("a generic qp_electrical chat agrees with the industrial-electrician form (#2075)", () => {
  const generic = latestPack("qp_electrical");
  const form = latestPack("qp_industrial_electrician");

  /**
   * A generic-pack chat worker: a profile row whose source session's persisted `conversation_state`
   * carries the answer map the capture wrote (the real record shape) and the worker-only stamps.
   * The generic chat writes no `worker_attributes` row for a `target_field: skills` question.
   */
  function deriveChat(
    optionKeys: readonly string[],
    stamp: Record<string, unknown> = { llm_led_turns: 0, llm_draft_settled: false },
  ): string[] {
    const answerMap = answerRecordsFor(generic, { electrical_scope: optionKeys });
    return derive("qp_electrical", [], {
      totalYears: 4,
      sourceSession: { pack_id: "qp_electrical", answer_map: answerMap, ...stamp },
    });
  }

  it("`industrial` or `panel` derives exactly what the form's `panel_wiring` derives", () => {
    const viaForm = derive(
      form.pack_id,
      attributesFor(form, { electrical_work_type: ["panel_wiring"] }),
    );
    expect(viaForm).toEqual(["mskill_industrial_electrician"]);
    expect(deriveChat(["industrial"])).toEqual(viaForm);
    expect(deriveChat(["panel"])).toEqual(viaForm);
  });

  it("pins the reachable set: every chip, exhaustively, reaches only the industrial electrician", () => {
    const item = generic.items.find((i) => i.question_key === "electrical_scope")!;
    const byChip = Object.fromEntries(
      (item.options ?? []).map((o) => [o.option_key, deriveChat([o.option_key])]),
    );
    expect(byChip).toEqual({
      house_wiring: [],
      industrial: ["mskill_industrial_electrician"],
      panel: ["mskill_industrial_electrician"],
      motor: [],
    });
  });

  it("an LLM-led or legacy session derives nothing from the same answers (worker-only)", () => {
    expect(
      deriveChat(["industrial", "panel"], { llm_led_turns: 2, llm_draft_settled: true }),
    ).toEqual([]);
    expect(deriveChat(["industrial", "panel"], {})).toEqual([]);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * WAVE 1 OF CEO PACK v2 (#3011): EACH FORM'S CLAIM QUESTION EARNS ITS TRADE'S SKILL.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Driven by `TRADE_CATALOGUE.claimQuestionKey`, so a trade whose claim key is recorded is tested
 * here without another edit. The foundry split (#3009) and Waves 2 and 3 (#3016, #3017) join as
 * their keys land.
 */
describe("each Wave 1 form's claim question (#3011)", () => {
  const WAVE1 = TRADE_CATALOGUE.filter((e) => e.wave === 1 && e.claimQuestionKey !== undefined);

  /** The options of a select item that carry a storable value. */
  function storable(item: PackRecord["items"][number]) {
    return (item.options ?? []).filter(
      (o) =>
        o.value_text !== undefined || o.value_number !== undefined || o.value_bool !== undefined,
    );
  }

  /** Claim questions that offer no none-of-above chip, so the escape case does not apply. */
  const NO_ESCAPE_ON_CLAIM = [
    "qp_cad_design_3d",
    "qp_heat_treatment",
    "qp_maintenance_engineer",
    "qp_npd_engineer",
    "qp_ppc",
    "qp_process_engineer",
    "qp_purchase",
    "qp_quality_engineer",
  ];

  it("covers the fifteen Wave 1 forms on main (all but the #3009 foundry split)", () => {
    expect(WAVE1.map((e) => e.code).sort()).toEqual([
      "T17",
      "T21",
      "T27",
      "T29",
      "T33",
      "T37",
      "T38",
      "T43",
      "T45",
      "T46",
      "T47",
      "T48",
      "T52",
      "T54",
      "T58",
    ]);
  });

  describe.each(WAVE1)("$code $packId", ({ packId, claimQuestionKey, matchSkillId }) => {
    const pack = latestPack(packId);
    const claim = pack.items.find((i) => i.question_key === claimQuestionKey)!;
    const escapes = (claim?.options ?? []).filter((o) => o.is_none_of_above === true);
    const chips = storable(claim).filter((o) => o.is_none_of_above !== true);

    it("the claim question is a mandatory select on the active version", () => {
      expect(claim, `${packId} has no ${claimQuestionKey}`).toBeDefined();
      expect(claim.is_mandatory).toBe(true);
      expect(["single_select", "multi_select"]).toContain(claim.answer_type);
    });

    it("a synthetic worker profiled through the whole form derives exactly the base skill", () => {
      // Every select question answered with its first real chip (never an escape, never the
      // second-skill chip), so "exactly" is tested against a full bag, not one chip.
      const answers: Record<string, string[]> = {};
      for (const item of pack.items) {
        if (item.answer_type !== "single_select" && item.answer_type !== "multi_select") continue;
        const first = storable(item).find(
          (o) => o.is_none_of_above !== true && o.option_key !== "robot_programming",
        );
        if (first) answers[item.question_key] = [first.option_key];
      }
      expect(answers[claimQuestionKey!]).toBeDefined();
      expect(derive(packId, attributesFor(pack, answers))).toEqual([matchSkillId]);
    });

    it("every non-escape chip of the claim question, alone, derives exactly the base skill", () => {
      expect(chips.length).toBeGreaterThan(0);
      for (const option of chips) {
        expect(
          derive(packId, attributesFor(pack, { [claimQuestionKey!]: [option.option_key] })),
          `${packId}.${claimQuestionKey}.${option.option_key}`,
        ).toEqual([matchSkillId]);
      }
    });

    it("a worker who taps only the escape chip on the claim question derives nothing", () => {
      if (NO_ESCAPE_ON_CLAIM.includes(packId)) {
        expect(escapes, `${packId}.${claimQuestionKey} grew an escape chip`).toEqual([]);
        return;
      }
      expect(escapes.length, `${packId}.${claimQuestionKey} has no escape chip`).toBe(1);
      // Tenure and level answered too: neither is a claim (rule 3).
      const before = pack.items.slice(0, pack.items.indexOf(claim));
      const answers: Record<string, string[]> = {
        [claimQuestionKey!]: [escapes[0]!.option_key],
      };
      for (const item of before) {
        if (!item.is_mandatory) continue;
        const first = storable(item)[0];
        if (first) answers[item.question_key] = [first.option_key];
      }
      expect(Object.keys(answers).length).toBeGreaterThan(1);
      expect(derive(packId, attributesFor(pack, answers))).toEqual([]);
    });
  });

  it("names the forms whose claim question has no escape chip, and only those", () => {
    const without = WAVE1.filter((e) => {
      const item = latestPack(e.packId).items.find((i) => i.question_key === e.claimQuestionKey);
      return !(item?.options ?? []).some((o) => o.is_none_of_above === true);
    }).map((e) => e.packId);
    expect(without.sort()).toEqual([...NO_ESCAPE_ON_CLAIM].sort());
  });
});

describe("the second-skill chips (#3011 §3)", () => {
  const pack = latestPack("qp_plc_automation");

  it("PLC: a PLC hand who also programs robots derives two skills", () => {
    expect(
      derive(
        "qp_plc_automation",
        attributesFor(pack, {
          plc_experience: ["three_to_five"],
          plc_brand: ["siemens"],
          plc_advanced_system: ["robot_programming"],
        }),
      ),
    ).toEqual(["mskill_plc_automation_tech", "mskill_robot_operator_programmer"]);
  });

  it("PLC: the chip claims robot programming only; the PLC skill comes from his PLC answers", () => {
    expect(
      derive(
        "qp_plc_automation",
        attributesFor(pack, { plc_advanced_system: ["robot_programming"] }),
      ),
    ).toEqual(["mskill_robot_operator_programmer"]);
  });

  it("PLC: robot interfacing and every other advanced system add nothing", () => {
    const item = pack.items.find((i) => i.question_key === "plc_advanced_system")!;
    for (const option of item.options ?? []) {
      if (option.option_key === "robot_programming") continue;
      expect(
        derive(
          "qp_plc_automation",
          attributesFor(pack, { plc_advanced_system: [option.option_key] }),
        ),
        option.option_key,
      ).toEqual([]);
    }
  });

  it("the robotics and forklift chips wait for their Wave 2 forms (#3016)", () => {
    // qp_robotics (robot_plc_interface = plc_programming) and qp_forklift (forklift_equipment =
    // hydra_crane) are not in the corpus yet; their rows land with the forms.
    expect(PACK_ANSWER_SKILLS.qp_robotics).toBeUndefined();
    expect(PACK_ANSWER_SKILLS.qp_forklift).toBeUndefined();
  });
});
