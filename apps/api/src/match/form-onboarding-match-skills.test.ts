import { describe, expect, it } from "vitest";
import { deriveWorkerSkills, workerSkillDeriveInput } from "@badabhai/match-engine";
import {
  PACK_ANSWER_SKILLS,
  PACKS_WITHOUT_MATCH_SKILL,
  packAnswerFromStoredRow,
} from "@badabhai/taxonomy";

import type { ProjectedAttribute } from "../profiling/answer-map-projector";
import { descriptorForKind, TRADE_FORM_KINDS } from "../profiling/roles/role-registry";
import {
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
    qp_cad_drafting: ["mskill_designer"],
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
    qp_industrial_electrician: ["mskill_industrial_electrician"],
    qp_assembly_line: ["mskill_assembly_line_worker"],
  };

  it("pins every mapped pack", () => {
    expect(Object.keys(REACHABLE).sort()).toEqual(Object.keys(PACK_ANSWER_SKILLS).sort());
  });

  it.each(Object.entries(REACHABLE))("%s reaches exactly its own trade", (packId, reachable) => {
    const pack = latestPack(packId);
    const seen = new Set<string>();
    for (const item of pack.items) {
      for (const option of item.options ?? []) {
        if (option.value_text === undefined && option.value_number === undefined) continue;
        const attrs = attributesFor(pack, { [item.question_key]: [option.option_key] });
        for (const skill of derive(packId, attrs)) seen.add(skill);
      }
    }
    expect([...seen].sort()).toEqual([...reachable].sort());
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

describe("the table is written against what the packs actually store", () => {
  it.each(Object.keys(PACK_ANSWER_SKILLS))(
    "%s: every mapped question and option exists, and stores its option key as its value",
    (packId) => {
      // `worker_attributes` holds the option's VALUE. The table is keyed by option KEY. They are
      // spelled the same for every mapped option — asserted, because a pack edit that made them
      // differ would silently zero this trade's reach.
      const pack = latestPack(packId);
      for (const [questionKey, options] of Object.entries(PACK_ANSWER_SKILLS[packId]!)) {
        const item = pack.items.find((candidate) => candidate.question_key === questionKey);
        expect(item, `${packId} has no question ${questionKey}`).toBeDefined();
        expect(item!.target_field ?? item!.question_key).toBe(questionKey);
        for (const optionKey of Object.keys(options)) {
          const option = (item!.options ?? []).find((o) => o.option_key === optionKey);
          expect(option, `${packId}.${questionKey} has no option ${optionKey}`).toBeDefined();
          expect(option!.value_text).toBe(optionKey);
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
