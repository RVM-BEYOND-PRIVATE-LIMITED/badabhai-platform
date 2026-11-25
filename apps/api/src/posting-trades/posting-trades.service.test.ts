import { describe, expect, it } from "vitest";
import { BadRequestException } from "@nestjs/common";
import type { QuestionPack } from "@badabhai/ai-contracts";
import type { QuestionPackItem } from "@badabhai/ai-contracts";
import { DEFAULT_MATCH_CONFIG } from "@badabhai/match-engine";
import {
  LIVE_POSTING_TRADE_KINDS,
  POSTING_TRADES,
  TRADES_V2_POSTING_KINDS,
  TRADE_CATALOGUE,
  isMatchSkillId,
  postingTradeFor,
} from "@badabhai/taxonomy";
import type { PackRegistryService } from "../profiling/pack-registry.service";
import { releaseServiceFor } from "../trade-release/trade-release.test-support";
import {
  PostingTradesService,
  matchSkillsFromTaxonomyIds,
  questionsForPack,
} from "./posting-trades.service";

const TURNER_KEYS = postingTradeFor("cnc_turner")!.postingQuestionKeys;

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
    const keys = questionsForPack(pack, TURNER_KEYS).map((q) => q.question_key);
    expect(keys).toEqual(["turning_machine", "controller_brand", "programming_level"]);
  });

  it("keeps facet chips facet-only and match chips match-affecting", () => {
    const questions = questionsForPack(pack, TURNER_KEYS);
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
    const machine = questionsForPack(pack, TURNER_KEYS, "mskill_cnc_turner").find(
      (q) => q.question_key === "turning_machine",
    )!;
    const lathe = machine.options.find((o) => o.option_key === "cnc_lathe")!;
    expect(lathe.match).toBe(false);
    expect(lathe.match_skill_ids).toContain("mskill_cnc_turner");
  });

  it("returns the 16 released trades with their ladder and base skill", async () => {
    const svc = new PostingTradesService(packs, releaseServiceFor());
    const forms = await svc.listForms();
    expect(forms).toHaveLength(LIVE_POSTING_TRADE_KINDS.length);
    for (const form of forms) {
      expect(form.ladder.length).toBeGreaterThan(0);
      expect(form.match_skill_id).toMatch(/^mskill_/);
    }
  });

  it("derives base + selected match skills, and facets add nothing", async () => {
    const svc = new PostingTradesService(packs, releaseServiceFor());
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
    const svc = new PostingTradesService(packs, releaseServiceFor());
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

  it("offers the sheet-3 CAM ladder, but still saves and prints a posting's legacy rung (#2550)", async () => {
    const svc = new PostingTradesService(packs, releaseServiceFor());
    const cam = (await svc.listForms()).find((form) => form.role_kind === "cam_programmer")!;
    expect(cam.ladder.map((rung) => rung.rung)).toEqual([
      "trainee",
      "programmer",
      "senior",
      "lead",
      "supervisor",
    ]);
    // A posting made from the old catalogue keeps saving on edit, and keeps its label.
    for (const legacy of ["senior_programmer", "junior_programmer"]) {
      const saved = await svc.normalizeSelection("cam_programmer", legacy, {});
      expect(saved.tradeLevel).toBe(legacy);
      const shown = await svc.describeSelection("cam_programmer", legacy, {});
      expect(shown.levelLabel, legacy).toBeTruthy();
    }
    // A legacy key of ANOTHER trade is still refused: the allowance is per trade.
    await expect(svc.normalizeSelection("cnc_turner", "junior_programmer", {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    // The old "helper" rung is no longer offered anywhere, but a stored one still saves.
    for (const form of await svc.listForms()) {
      expect(form.ladder.map((rung) => rung.rung), form.role_kind).not.toContain("helper");
    }
    expect((await svc.normalizeSelection("cnc_turner", "helper", {})).tradeLevel).toBe("helper");
  });

  it("refuses trade fields for a role whose posting switch is off", async () => {
    const svc = new PostingTradesService(packs, releaseServiceFor());
    await expect(
      svc.normalizeSelection("injection_moulding_operator", "setter", {}),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("#3002: a trades-v2 kind with no release row is refused with the postable-role error", async () => {
    // No release row reads as off; posting validation answers with the existing error (the
    // release gate itself is wired in #3005 — this pins the refusal it must keep).
    const svc = new PostingTradesService(packs, releaseServiceFor());
    await expect(svc.normalizeSelection("gear_cutting_operator", "trainee", {})).rejects.toThrow(
      "trade fields are only available for a postable role",
    );
  });

  it("#3002: listForms is byte-for-byte the 16 live trades (no release row may move a form)", async () => {
    const svc = new PostingTradesService(packs, releaseServiceFor());
    const forms = await svc.listForms();
    expect(forms.map((form) => form.role_kind)).toEqual([...LIVE_POSTING_TRADE_KINDS]);
    expect(JSON.stringify(forms)).toMatchSnapshot();
  });

  it("resolves corpus attributes through the same bridge the worker side uses", () => {
    expect(matchSkillsFromTaxonomyIds(["skill_turning"])).toContain("mskill_cnc_turner");
    expect(matchSkillsFromTaxonomyIds(["skill_fanuc"])).toEqual([]);
    expect(matchSkillsFromTaxonomyIds(["role_cnc_turner_operator"])).toContain("mskill_cnc_turner");
  });
});

/**
 * A worker form for one trades-v2 trade as the sheet would load it: the experience and level
 * questions, a confirm question, a zero-experience-only question, a free-text question and
 * every posting key — each with one chip. Only the posting keys may reach a posting form.
 */
function v2Pack(roleKind: string): QuestionPack {
  const entry = TRADE_CATALOGUE.find((e) => e.roleKind === roleKind)!;
  const prefix = entry.levelKey.replace(/_level$/, "");
  const item = (
    question_key: string,
    answer_type: QuestionPackItem["answer_type"] = "multi_select",
  ): QuestionPackItem => ({
    question_key,
    prompt_text: `Q ${question_key}`,
    display_order: 0,
    target_kind: "attribute",
    target_field: question_key,
    target_skill_id: null,
    answer_type,
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
    options:
      answer_type === "text"
        ? []
        : [
            {
              option_key: "x",
              label_text: "X",
              value: "x",
              implies_skill_id: null,
              is_none_of_above: false,
            },
          ],
  });
  // Sheet order puts the posting keys after the excluded ones; the form follows the LIST order.
  const items = [
    item(`${prefix}_experience`, "single_select"),
    item(entry.levelKey, "single_select"),
    item(`${prefix}_setter_confirm`, "single_select"),
    // Asked only at zero experience on the sheet (the condition is not what excludes it).
    item(`${prefix}_training_exposure`),
    item("iti_project_work", "text"),
    ...[...entry.postingQuestionKeys].reverse().map((key) => item(key)),
  ].map((it, i) => ({ ...it, display_order: i }));
  return {
    pack_id: entry.packId,
    version: 1,
    family_id: entry.familyId,
    locale: "hi-IN",
    status: "active",
    content_hash: "test",
    items,
  };
}

const v2Packs = {
  loadForFamily: async (familyId: string) => {
    const entry = TRADE_CATALOGUE.find((e) => e.familyId === familyId)!;
    return v2Pack(entry.roleKind);
  },
} as unknown as PackRegistryService;

describe("#3005 — the 60-trade posting catalogue", () => {
  it("declares all 60 trades: the 16 live first, then the 44 in catalogue order", () => {
    expect(POSTING_TRADES).toHaveLength(60);
    expect(POSTING_TRADES.map((t) => t.roleKind)).toEqual([
      ...LIVE_POSTING_TRADE_KINDS,
      ...TRADES_V2_POSTING_KINDS,
    ]);
    expect(TRADES_V2_POSTING_KINDS).toEqual(
      TRADE_CATALOGUE.filter((e) => e.wave > 0).map((e) => e.roleKind),
    );
  });

  it.each([...TRADES_V2_POSTING_KINDS])(
    "%s: formFor returns the sheet ladder in order and no question from the excluded set",
    async (kind) => {
      const entry = TRADE_CATALOGUE.find((e) => e.roleKind === kind)!;
      const svc = new PostingTradesService(v2Packs, releaseServiceFor([kind]));
      const form = await svc.formFor(kind);
      expect(form).not.toBeNull();
      expect(form!.pack_id).toBe(entry.packId);
      expect(form!.match_skill_id).toBe(entry.matchSkillId);
      expect(form!.ladder.map((r) => r.rung)).toEqual(entry.ladder.map((r) => r.rung));
      const confirmedAt = entry.ladder.findIndex((r) => r.rung === entry.confirmedFrom);
      const higherAt = entry.ladder.findIndex((r) => r.rung === entry.higherPriceFrom);
      form!.ladder.forEach((rung, i) => {
        expect(rung.confirmed, rung.rung).toBe(i >= confirmedAt);
        expect(rung.priceTier, rung.rung).toBe(i >= higherAt ? "higher" : "lower");
        expect(rung.evidence.length, rung.rung).toBeGreaterThan(0);
        expect(rung.monthsFloor.length, rung.rung).toBeGreaterThan(0);
      });
      const keys = form!.questions.map((q) => q.question_key);
      expect(keys).toEqual([...entry.postingQuestionKeys]);
      for (const key of keys) {
        expect(key).not.toMatch(/_experience$|_confirm$|_training_exposure$|^iti_/);
        expect(key).not.toBe(entry.levelKey);
      }
      // Every rung on the sheet ladder is a rung a posting may store.
      for (const { rung } of entry.ladder) {
        expect((await svc.normalizeSelection(kind, rung, {})).tradeLevel).toBe(rung);
      }
    },
  );

  it("names the three sheet-excluded hidden requirements the key-ending filter dropped", () => {
    // The ending rule hid every `…_level` key but two; the explicit list keeps these.
    const keysOf = (kind: string) => TRADE_CATALOGUE.find((e) => e.roleKind === kind)!.postingQuestionKeys;
    expect(keysOf("boring_machine_operator")).toContain("boring_programming_level");
    expect(keysOf("cmm_operator")).toContain("cmm_programming_level");
    // Free text never becomes a posting chip (T44's brand question is free text on the sheet).
    expect(keysOf("service_engineer")).not.toContain("service_brand_handled");
  });

  it("with only the 16 seeded release rows, the public list is still the 16", async () => {
    const forms = await new PostingTradesService(v2Packs, releaseServiceFor()).listForms();
    expect(forms.map((f) => f.role_kind)).toEqual([...LIVE_POSTING_TRADE_KINDS]);
  });

  it("before migration 0198 is applied (no table), the readers answer its seed: the 16", async () => {
    const svc = new PostingTradesService(packs, releaseServiceFor("missing"));
    expect((await svc.listForms()).map((f) => f.role_kind)).toEqual([...LIVE_POSTING_TRADE_KINDS]);
    expect(await svc.formFor("cnc_turner")).not.toBeNull();
    expect(await svc.formFor("gear_cutting_operator")).toBeNull();
    expect((await svc.normalizeSelection("cnc_turner", "setter", {})).tradeLevel).toBe("setter");
    await expect(svc.normalizeSelection("gear_cutting_operator", "trainee", {})).rejects.toThrow(
      "trade fields are only available for a postable role",
    );
  });

  it("a switched-on 17th trade is listed, served and accepted", async () => {
    const svc = new PostingTradesService(
      v2Packs,
      releaseServiceFor([...LIVE_POSTING_TRADE_KINDS, "gear_cutting_operator"]),
    );
    const kinds = (await svc.listForms()).map((f) => f.role_kind);
    expect(kinds).toHaveLength(17);
    expect(kinds).toContain("gear_cutting_operator");
    expect(await svc.formFor("gear_cutting_operator")).not.toBeNull();
    const selection = await svc.normalizeSelection("gear_cutting_operator", "setter", {});
    expect(selection.matchSkillIds).toEqual(["mskill_gear_cutting_operator"]);
  });

  it("a posting that stores a switched-off trade still loads and saves; moving onto one is refused", async () => {
    const svc = new PostingTradesService(v2Packs, releaseServiceFor());
    // Off: not offered.
    expect(await svc.formFor("gear_cutting_operator")).toBeNull();
    // The posting already stores it: the edit saves, and the worker read still prints.
    const saved = await svc.normalizeSelection(
      "gear_cutting_operator",
      "setter",
      {},
      { storedRoleKind: "gear_cutting_operator" },
    );
    expect(saved.tradeLevel).toBe("setter");
    const shown = await svc.describeSelection("gear_cutting_operator", "setter", {});
    expect(shown.levelLabel).toBe("Setter");
    // A posting stored on another trade may not move onto it.
    await expect(
      svc.normalizeSelection("gear_cutting_operator", "setter", {}, { storedRoleKind: "welder" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    ["plc_automation_technician", "mskill_robot_operator_programmer"],
    ["robot_operator_programmer", "mskill_plc_automation_tech"],
    ["forklift_operator", "mskill_crane_operator"],
  ])(
    "step 6: %s — the base skill plus its one reach-changing chip fits the skill cap",
    (kind, chipSkill) => {
      // #3011 adds the chip rows; a posting then stores its base skill plus this one.
      const base = postingTradeFor(kind)!.matchSkillId;
      expect(isMatchSkillId(base)).toBe(true);
      expect(isMatchSkillId(chipSkill)).toBe(true);
      expect(new Set([base, chipSkill]).size).toBe(2);
      expect(2).toBeLessThanOrEqual(DEFAULT_MATCH_CONFIG.maxSkillsPerPosting);
    },
  );
});
