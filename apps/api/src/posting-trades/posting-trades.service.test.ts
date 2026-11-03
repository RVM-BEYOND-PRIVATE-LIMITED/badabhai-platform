import { describe, expect, it } from "vitest";
import { BadRequestException } from "@nestjs/common";
import type { QuestionPack } from "@badabhai/ai-contracts";
import { POSTING_TRADES } from "@badabhai/taxonomy";
import type { PackRegistryService } from "../profiling/pack-registry.service";
import {
  PostingTradesService,
  matchSkillsFromTaxonomyIds,
  questionsForPack,
} from "./posting-trades.service";

/**
 * The posting-side reader of the checked-in packs. The pack is the source of truth; these
 * pins prove the form keeps a facet chip a facet and a match chip a match, and that the
 * server — not the client — derives the match set.
 */
const pack: QuestionPack = {
  pack_id: "qp_cnc_turning",
  version: 6,
  family_id: "fam_cnc_turning",
  locale: "hi-IN",
  status: "active",
  content_hash: "test",
  items: [
    {
      question_key: "turning_experience",
      prompt_text: "Turning ka kitna tajurba hai?",
      display_order: 0,
      target_kind: "attribute",
      target_field: "turning_experience",
      target_skill_id: null,
      answer_type: "single_select",
      is_mandatory: true,
      is_core: true,
      max_asks: 2,
      min_turn: null,
      max_turn: null,
      ask_if: null,
      skip_if: null,
      parent_item_key: null,
      retry_text: null,
      why_text: null,
      options: [
        {
          option_key: "under_one",
          label_text: "1 saal se kam",
          value: 0,
          implies_skill_id: null,
          is_none_of_above: false,
        },
      ],
    },
    {
      question_key: "turning_level",
      prompt_text: "Aap kis level par kaam karte hain?",
      display_order: 1,
      target_kind: "attribute",
      target_field: "turning_level",
      target_skill_id: null,
      answer_type: "single_select",
      is_mandatory: false,
      is_core: false,
      max_asks: 1,
      min_turn: null,
      max_turn: null,
      ask_if: null,
      skip_if: null,
      parent_item_key: null,
      retry_text: null,
      why_text: null,
      options: [
        {
          option_key: "setter",
          label_text: "Setter",
          value: "setter",
          implies_skill_id: null,
          is_none_of_above: false,
        },
      ],
    },
    {
      question_key: "turning_machine",
      prompt_text: "Aap kaunsi turning machine chalate hain?",
      display_order: 2,
      target_kind: "attribute",
      target_field: "turning_machine",
      target_skill_id: null,
      answer_type: "multi_select",
      is_mandatory: false,
      is_core: true,
      max_asks: 2,
      min_turn: null,
      max_turn: null,
      ask_if: null,
      skip_if: null,
      parent_item_key: null,
      retry_text: null,
      why_text: null,
      options: [
        {
          option_key: "cnc_lathe",
          label_text: "CNC lathe ya turning centre",
          value: "cnc_lathe",
          implies_skill_id: null,
          is_none_of_above: false,
        },
        {
          option_key: "other_machine",
          label_text: "Koi aur machine",
          value: "unknown",
          implies_skill_id: null,
          is_none_of_above: true,
        },
      ],
    },
    {
      question_key: "controller_brand",
      prompt_text: "Machine par kaunsa controller lagaa hai?",
      display_order: 3,
      target_kind: "attribute",
      target_field: "controller_brand",
      target_skill_id: null,
      answer_type: "multi_select",
      is_mandatory: false,
      is_core: true,
      max_asks: 2,
      min_turn: null,
      max_turn: null,
      ask_if: null,
      skip_if: null,
      parent_item_key: null,
      retry_text: null,
      why_text: null,
      options: [
        {
          option_key: "fanuc",
          label_text: "Fanuc",
          value: "fanuc",
          implies_skill_id: null,
          is_none_of_above: false,
        },
      ],
    },
    {
      question_key: "programming_level",
      prompt_text: "Programme ke saath aap kitna kaam karte hain?",
      display_order: 4,
      target_kind: "attribute",
      target_field: "programming_level",
      target_skill_id: null,
      answer_type: "single_select",
      is_mandatory: false,
      is_core: true,
      max_asks: 1,
      min_turn: null,
      max_turn: null,
      ask_if: null,
      skip_if: null,
      parent_item_key: null,
      retry_text: null,
      why_text: null,
      options: [
        {
          option_key: "write_program",
          label_text: "Naya programme likh leta hoon",
          value: "write_program",
          implies_skill_id: null,
          is_none_of_above: false,
        },
      ],
    },
    {
      question_key: "iti_project_work",
      prompt_text: "ITI me kya banaya tha?",
      display_order: 5,
      target_kind: "attribute",
      target_field: "iti_project_work",
      target_skill_id: null,
      answer_type: "text",
      is_mandatory: false,
      is_core: false,
      max_asks: 1,
      min_turn: null,
      max_turn: null,
      ask_if: null,
      skip_if: null,
      parent_item_key: null,
      retry_text: null,
      why_text: null,
      options: [],
    },
  ],
};

const packs = {
  loadForFamily: async () => pack,
} as unknown as PackRegistryService;

describe("posting trade form", () => {
  it("excludes tenure, self-rung, confirm, ITI and free-text questions", () => {
    const keys = questionsForPack(pack).map((q) => q.question_key);
    expect(keys).toEqual(["turning_machine", "controller_brand", "programming_level"]);
  });

  it("keeps facet chips facet-only and match chips match-affecting", () => {
    const questions = questionsForPack(pack);
    const machine = questions.find((q) => q.question_key === "turning_machine")!;
    expect(machine.options.find((o) => o.option_key === "cnc_lathe")?.match).toBe(true);
    expect(machine.options.find((o) => o.option_key === "other_machine")).toBeUndefined();

    const controller = questions.find((q) => q.question_key === "controller_brand")!;
    expect(controller.options[0]!.match).toBe(false);
    expect(controller.options[0]!.match_skill_ids).toEqual([]);

    const programming = questions.find((q) => q.question_key === "programming_level")!;
    expect(programming.options[0]!.match_skill_ids).toContain("mskill_cnc_programmer");
  });

  it("marks a chip that only repeats the base trade skill as a facet", () => {
    // `cnc_lathe` resolves to the turner's own `mskill_cnc_turner`, which is always in the
    // match set — so it changes no reach and must not print a "Match" badge.
    const machine = questionsForPack(pack, "mskill_cnc_turner").find(
      (q) => q.question_key === "turning_machine",
    )!;
    const lathe = machine.options.find((o) => o.option_key === "cnc_lathe")!;
    expect(lathe.match).toBe(false);
    expect(lathe.match_skill_ids).toContain("mskill_cnc_turner");
  });

  it("returns all 16 trades with their ladder and base skill", async () => {
    const svc = new PostingTradesService(packs);
    const forms = await svc.listForms();
    expect(forms).toHaveLength(POSTING_TRADES.length);
    for (const form of forms) {
      expect(form.ladder.length).toBeGreaterThan(0);
      expect(form.match_skill_id).toMatch(/^mskill_/);
    }
  });

  it("derives base + selected match skills, and facets add nothing", async () => {
    const svc = new PostingTradesService(packs);
    const selection = await svc.normalizeSelection("cnc_turner", "setter", {
      controller_brand: ["fanuc"],
      programming_level: ["write_program"],
    });
    expect(selection.tradeLevel).toBe("setter");
    expect(selection.tradeAnswers).toEqual({
      controller_brand: ["fanuc"],
      programming_level: ["write_program"],
    });
    expect(selection.matchSkillIds).toContain("mskill_cnc_turner");
    expect(selection.matchSkillIds).toContain("mskill_cnc_programmer");
    // The facet-only controller chip changed no reach input.
    expect(selection.matchSkillIds).not.toContain("mskill_fanuc");
  });

  it("fails closed on an unknown rung, question or option", async () => {
    const svc = new PostingTradesService(packs);
    await expect(svc.normalizeSelection("cnc_turner", "boss", {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      svc.normalizeSelection("cnc_turner", null, { not_a_question: ["x"] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.normalizeSelection("cnc_turner", null, { controller_brand: ["not_a_controller"] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses trade fields for a non-postable role", async () => {
    const svc = new PostingTradesService(packs);
    await expect(
      svc.normalizeSelection("injection_moulding_operator", "setter", {}),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("resolves corpus attributes through the same bridge the worker side uses", () => {
    expect(matchSkillsFromTaxonomyIds(["skill_turning"])).toContain("mskill_cnc_turner");
    expect(matchSkillsFromTaxonomyIds(["skill_fanuc"])).toEqual([]);
    expect(matchSkillsFromTaxonomyIds(["role_cnc_turner_operator"])).toContain("mskill_cnc_turner");
  });
});
