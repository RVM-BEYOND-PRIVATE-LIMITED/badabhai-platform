import { describe, expect, it } from "vitest";

import type { QuestionPackItem } from "@badabhai/ai-contracts";
import { PROFILING_TIERS, type ProfilingTier } from "@badabhai/types";

import { CAPABILITY_ROW_BUDGET, tradeResumeMapFor } from "../../resume/trade-resume-map";
import { packFromCorpus, rawCorpusPack } from "../form/corpus-pack.test-support";
import { predicateFields } from "../form/form-eligibility";
import { ENABLED_ROLE_DESCRIPTORS } from "../roles/role-registry";
import {
  isUpgrade,
  itemsForTier,
  keysExcludedAtTier,
  packIsTagged,
  pageRevealFields,
  pageTierScope,
  PROFILING_TIER_FOOTER_LABEL,
  type ItemTierMap,
} from "./profiling-tier.policy";

/**
 * ═══ TIERED PROFILING — THE RULES, AGAINST THE SHIPPED PACKS ═══
 *
 * Every assertion below that names a role reads the REAL pack JSON and its REAL `min_tier` tags,
 * so a pack edit that breaks a tier property fails here rather than on a worker's form.
 */

/** The corpus JSON's own tags — the source of truth the seed projects into the database. */
function tagsOf(packId: string): ItemTierMap {
  const raw = rawCorpusPack(packId) as unknown as {
    items: { question_key: string; min_tier?: ProfilingTier | null }[];
  };
  return new Map(raw.items.map((item) => [item.question_key, item.min_tier ?? null]));
}

const keys = (items: readonly { question_key: string }[]) => items.map((i) => i.question_key);

describe.each(ENABLED_ROLE_DESCRIPTORS.map((d) => [d.kind, d] as const))(
  "every enabled role — %s",
  (_kind, descriptor) => {
    const pack = packFromCorpus(descriptor.packId);
    const tags = tagsOf(descriptor.packId);

    it("tags EVERY question of its pack (an untagged one would silently read as Hard)", () => {
      const untagged = pack.items.filter((item) => !tags.get(item.question_key));
      expect(keys(untagged)).toEqual([]);
    });

    it("is cumulative and monotonic: easy ⊆ medium ⊆ hard, and hard is the whole pack", () => {
      const [easy, medium, hard] = PROFILING_TIERS.map(
        (t) => new Set(keys(itemsForTier(pack.items, tags, t))),
      );
      for (const key of easy!) expect(medium!.has(key)).toBe(true);
      for (const key of medium!) expect(hard!.has(key)).toBe(true);
      expect([...hard!]).toEqual(keys(pack.items));
      expect(easy!.size).toBeLessThan(medium!.size);
      expect(medium!.size).toBeLessThan(hard!.size);
    });

    it("asks the tenure gate and every mandatory question at Easy — nothing a tier keeps is left ungated", () => {
      const easy = new Set(keys(itemsForTier(pack.items, tags, "easy")));
      expect(easy.has(descriptor.tenureQuestionKey)).toBe(true);
      for (const item of pack.items.filter((i) => i.is_mandatory)) {
        expect(easy.has(item.question_key)).toBe(true);
      }
    });

    // The form excludes a question whose gate or parent is out; the résumé checks each row's OWN
    // tag. The two agree only while no question is tagged BELOW a question it depends on — so
    // that is pinned here, for every pack, rather than left to authoring discipline.
    it("tags no question below a question it depends on (gate, skip condition or parent)", () => {
      const rank = (key: string) => PROFILING_TIERS.indexOf(tags.get(key) ?? "hard");
      const packKeys = new Set(keys(pack.items));
      const violations = pack.items.flatMap((item) =>
        [
          ...predicateFields(item.ask_if),
          ...predicateFields(item.skip_if),
          ...(item.parent_item_key ? [item.parent_item_key] : []),
        ]
          .filter((dep) => packKeys.has(dep) && rank(dep) > rank(item.question_key))
          .map(
            (dep) =>
              `${item.question_key} (${tags.get(item.question_key)}) depends on ${dep} (${tags.get(dep)})`,
          ),
      );
      expect(violations).toEqual([]);
    });

    // The résumé filters worker_attributes by question_key; attributes are keyed by target_field.
    it("keys every attribute question's answer by its own question_key (the résumé filter's assumption)", () => {
      const mismatched = pack.items.filter(
        (item) => item.target_kind === "attribute" && item.target_field !== item.question_key,
      );
      expect(keys(mismatched)).toEqual([]);
    });

    it("keeps the headline field at Easy, so an Easy headline is never missing its tools", () => {
      const headline = tradeResumeMapFor(descriptor.packId)?.capability.find(
        (row) => row.inHeadline,
      );
      expect(headline).toBeDefined();
      expect(tags.get(headline!.from)).toBe("easy");
    });

    // R6 (tier-tagging.md §1). The Hard sheet keeps its best CAPABILITY_ROW_BUDGET rows by rank.
    // A row tagged below Hard but shed by that budget would print on a Medium sheet and VANISH when
    // the worker upgrades — the one output an "add more detail" must never produce.
    it("tags no row below Hard that the Hard sheet's rank budget would shed (R6)", () => {
      const map = tradeResumeMapFor(descriptor.packId)!;
      const senior = map.capability.filter((row) => {
        const item = pack.items.find((i) => i.question_key === row.from);
        return item && JSON.stringify(item.ask_if ?? "").indexOf('"lte"') < 0;
      });
      const kept = new Set(
        [...senior]
          .sort((a, b) => a.rank - b.rank)
          .slice(0, CAPABILITY_ROW_BUDGET)
          .map((r) => r.from),
      );
      const shedBelowHard = senior.filter(
        (row) => !kept.has(row.from) && tags.get(row.from) !== "hard",
      );
      expect(shedBelowHard.map((r) => r.from)).toEqual([]);
    });
  },
);

describe("the approved calibration (BADABHAI_PROFILING_TIERS_PROMPT.md §4) comes out exactly", () => {
  // The owner's field names, mapped to the pack keys that capture them.
  it("CNC Turner (Rinku Kumar)", () => {
    const tags = tagsOf("qp_cnc_turning");
    expect(
      Object.fromEntries(
        [
          "turning_machine", // Machines
          "controller_brand", // Controllers
          "material_worked", // Materials
          "measuring_tools", // Measuring instruments
          "programming_level", // Programming
          "drawing_reading", // Drawings
          "workholding", // Workholding
          "setting_operation", // Setting
          "tolerance_band", // Tolerance held
          "advanced_capability", // Machine capability
        ].map((k) => [k, tags.get(k)]),
      ),
    ).toEqual({
      turning_machine: "easy",
      controller_brand: "easy",
      material_worked: "medium",
      measuring_tools: "medium",
      programming_level: "medium",
      drawing_reading: "medium",
      workholding: "hard",
      setting_operation: "hard",
      tolerance_band: "hard",
      advanced_capability: "hard",
    });
  });

  it("CAM Programmer (Fana Kaur)", () => {
    const tags = tagsOf("qp_cam_programming");
    expect(
      Object.fromEntries(
        [
          "cam_software",
          "machine_programmed",
          "controller_brand",
          "programming_work",
          "drawing_reading",
          "cad_model_handling",
          "sector_worked",
        ].map((k) => [k, tags.get(k)]),
      ),
    ).toEqual({
      cam_software: "easy",
      machine_programmed: "easy",
      controller_brand: "medium",
      programming_work: "medium",
      drawing_reading: "medium",
      cad_model_handling: "hard",
      sector_worked: "hard",
    });
  });
});

function item(partial: Partial<QuestionPackItem> & { question_key: string }): QuestionPackItem {
  return {
    prompt_text: "?",
    display_order: 0,
    target_kind: "none",
    target_field: null,
    target_skill_id: null,
    answer_type: "text",
    is_mandatory: false,
    is_core: false,
    max_asks: 2,
    min_turn: null,
    max_turn: null,
    ask_if: null,
    skip_if: null,
    parent_item_key: null,
    retry_text: null,
    why_text: null,
    options: [],
    ...partial,
  };
}

describe("keysExcludedAtTier", () => {
  it("reads an UNTAGGED question as Hard — asked at Hard only, today's behaviour", () => {
    const items = [item({ question_key: "tagged" }), item({ question_key: "untagged" })];
    const tags: ItemTierMap = new Map([["tagged", "easy"]]);
    expect(keys(itemsForTier(items, tags, "easy"))).toEqual(["tagged"]);
    expect(keys(itemsForTier(items, tags, "medium"))).toEqual(["tagged"]);
    expect(keys(itemsForTier(items, tags, "hard"))).toEqual(["tagged", "untagged"]);
  });

  it("excludes a question whose GATE is excluded, even when its own tag is lower", () => {
    const items = [
      item({ question_key: "gate" }),
      item({
        question_key: "child",
        ask_if: { op: "gte", left: { field: "gate" }, right: { const: 2 } } as never,
      }),
      item({ question_key: "grandchild", parent_item_key: "child" }),
    ];
    const tags: ItemTierMap = new Map<string, ProfilingTier>([
      ["gate", "medium"],
      ["child", "easy"],
      ["grandchild", "easy"],
    ]);
    expect([...keysExcludedAtTier(items, tags, "easy")].sort()).toEqual([
      "child",
      "gate",
      "grandchild",
    ]);
    expect([...keysExcludedAtTier(items, tags, "medium")]).toEqual([]);
  });

  it("ignores a gate on a field this pack does not own (the chat's answers are not its to drop)", () => {
    const items = [
      item({
        question_key: "depth",
        ask_if: { op: "gte", left: { field: "experience_years" }, right: { const: 2 } } as never,
      }),
    ];
    expect([...keysExcludedAtTier(items, new Map([["depth", "easy"]]), "easy")]).toEqual([]);
  });
});

describe("pages and labels", () => {
  it("Easy does not ASK documents, job descriptions, further jobs, certificates or trainings", () => {
    expect(pageTierScope("preferences", "easy")).toEqual({ hidden_fields: ["documents_ready"] });
    expect(pageTierScope("employment", "easy")).toEqual({
      hidden_fields: ["work_done", "additional_entries"],
    });
    expect(pageTierScope("qualifications", "easy")).toEqual({
      hidden_fields: ["certificates", "trainings"],
    });
  });

  // The review's data-loss finding: a whole-record PUT page must never be told a list CAP a client
  // could read as "send one entry". The scope names fields not to ask, and nothing else.
  it("carries no list cap a client could read as a truncation", () => {
    for (const tier of PROFILING_TIERS) {
      for (const page of ["preferences", "employment", "qualifications"] as const) {
        expect(Object.keys(pageTierScope(page, tier))).toEqual(["hidden_fields"]);
      }
    }
  });

  it.each(["medium", "hard"] as const)("%s hides nothing on any page", (tier) => {
    for (const page of ["preferences", "employment", "qualifications"] as const) {
      expect(pageTierScope(page, tier)).toEqual({ hidden_fields: [] });
    }
  });

  it("an upgrade reveals, from EASY, every page field a deeper tier adds — so a two-step upgrade skips none", () => {
    for (const tier of ["medium", "hard"] as const) {
      expect(pageRevealFields("preferences", tier)).toEqual(["documents_ready"]);
      expect(pageRevealFields("employment", tier)).toEqual(["work_done", "additional_entries"]);
      expect(pageRevealFields("qualifications", tier)).toEqual(["certificates", "trainings"]);
    }
    for (const page of ["preferences", "employment", "qualifications"] as const) {
      expect(pageRevealFields(page, "easy")).toEqual([]);
    }
  });

  it("reads a pack with no tag at all as UNTAGGED (the flag-before-seed guard)", () => {
    expect(
      packIsTagged(
        new Map([
          ["a", null],
          ["b", null],
        ]),
      ),
    ).toBe(false);
    expect(packIsTagged(new Map())).toBe(false);
    expect(
      packIsTagged(
        new Map([
          ["a", null],
          ["b", "easy"],
        ]),
      ),
    ).toBe(true);
  });

  it("labels the footer as the spec words it", () => {
    expect(PROFILING_TIER_FOOTER_LABEL).toEqual({
      easy: "Quick profile",
      medium: "Detailed profile",
      hard: "BadaBhai Recommended profile",
    });
  });

  it("only ever raises a tier", () => {
    expect(isUpgrade("easy", "medium")).toBe(true);
    expect(isUpgrade("medium", "hard")).toBe(true);
    expect(isUpgrade("hard", "easy")).toBe(false);
    expect(isUpgrade("medium", "medium")).toBe(false);
  });
});
