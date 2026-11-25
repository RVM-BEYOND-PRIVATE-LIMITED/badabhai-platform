/**
 * The depth ladders of the 15 Wave 1 forms (#3008 step 7), proven against the REAL predicate
 * evaluator and the REAL option-resolution chain, and the carry-over of stored version-1 answers
 * into each deepened form's version 2 (#3008 "Done when").
 *
 * COPIED FROM `cnc-turning-depth.proof.test.ts`, per form. That file explains why the ladder is
 * driven by TAPPING A CHIP and resolving it through the registry's `??` chain instead of handing
 * the evaluator a number: a stray `value_text` on the tier gate turns every `gte` below it into a
 * string compare that is false forever (#776), and only a test that resolves the option itself
 * goes red on that fault. The fault was injected once into `qp_cmm.json` while writing this file
 * (a `value_text: "12"` beside `value_number: 12` on `cmm_experience`): the gate-shape case and
 * the band-ladder case went red for qp_cmm (the senior path stays green there because its level
 * chip opens the same `any` gates); the file was then restored.
 *
 * The forms are compiled from CEO pack v2 by `db:compile:sheets` and disabled (#3004): nothing
 * here serves them. `profiling-tier.policy.test.ts` checks enabled roles only, so the tier tag
 * rule it pins ("no question tagged below a question it depends on") is pinned here too (#3008
 * step 8).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { WorkerPackAnswer } from "@badabhai/db";
import { PROFILING_TIERS, type ProfilingTier } from "@badabhai/types";

import { packFromCorpus, PACK_DIR } from "./form/corpus-pack.test-support";
import { answerMapFromRows, isFormQuestionVisible, predicateFields } from "./form/form-eligibility";
import { MAX_ENGINE_ASKS } from "./next-question";
import { evaluatePredicate } from "./predicate";

interface PackOption {
  option_key: string;
  label_text: string;
  value_text?: string | null;
  value_number?: number | null;
  value_bool?: boolean | null;
  is_none_of_above?: boolean;
}
interface PackItem {
  question_key: string;
  answer_type: string;
  min_tier?: ProfilingTier | null;
  ask_if?: unknown;
  skip_if?: unknown;
  parent_item_key?: string | null;
  options?: PackOption[];
}
interface Pack {
  pack_id: string;
  version: number;
  status: string;
  items: PackItem[];
}

function readPack(file: string): Pack {
  return JSON.parse(readFileSync(join(PACK_DIR, `${file}.json`), "utf8")) as Pack;
}

/** EXACTLY `pack-registry.service.ts`'s `??` chain. A drift here stops protecting anything. */
function resolveOptionValue(o: PackOption): unknown {
  return o.value_text ?? o.value_number ?? o.value_bool ?? null;
}

/** The qp_universal active tail, as `cnc-turning-depth.proof.test.ts` pins it. */
const UNIVERSAL_ASKS = 18;

/**
 * file -> the number of fresher items (`lte 0` on the experience gate). Shop-floor sheets carry
 * three; desk sheets two; Production Supervisor has no trainee rung and none.
 */
const WAVE_1: ReadonlyArray<readonly [file: string, fresher: number]> = [
  ["qp_edm_wirecut@2", 3],
  ["qp_cnc_router", 3],
  ["qp_heat_treatment@2", 3],
  ["qp_injection_moulding@2", 3],
  ["qp_cmm", 3],
  ["qp_quality_engineer", 2],
  ["qp_plc_automation@2", 3],
  ["qp_maintenance_engineer", 2],
  ["qp_production_supervisor@2", 0],
  ["qp_production_engineer", 2],
  ["qp_process_engineer", 2],
  ["qp_npd_engineer", 2],
  ["qp_ppc", 2],
  ["qp_purchase", 2],
  ["qp_cad_design_3d@2", 2],
];

describe.each(WAVE_1)("Wave 1 depth ladder — %s", (file, fresherCount) => {
  const pack = readPack(file);
  const gate = pack.items[0] as PackItem;
  const level = pack.items[1] as PackItem;

  /** The answer map produced by TAPPING the chips named; each value goes through the `??` chain. */
  function answers(band?: number, rung?: string, extra: Record<string, unknown> = {}) {
    const map: Record<string, { value_normalized: unknown }> = {};
    if (band !== undefined) {
      const chip = (gate.options ?? []).find((o) => o.value_number === band);
      if (!chip) throw new Error(`no ${gate.question_key} chip with value_number ${band}`);
      map[gate.question_key] = { value_normalized: resolveOptionValue(chip) };
    }
    if (rung !== undefined) {
      const chip = (level.options ?? []).find((o) => o.value_text === rung);
      if (!chip) throw new Error(`no ${level.question_key} chip with value_text ${rung}`);
      map[level.question_key] = { value_normalized: resolveOptionValue(chip) };
    }
    for (const [key, value] of Object.entries(extra)) map[key] = { value_normalized: value };
    return map;
  }

  function askedFor(map: Record<string, { value_normalized: unknown }>): string[] {
    const ctx = { answers: map, occupation: null, phase: "occupation_specific", turn: 5 } as never;
    return pack.items
      .filter((i) => !i.ask_if || evaluatePredicate(i.ask_if as never, ctx))
      .map((i) => i.question_key);
  }

  const fresherItems = pack.items
    .filter((i) => (i.ask_if as { op?: string } | undefined)?.op === "lte")
    .map((i) => i.question_key);
  const topRung = (level.options ?? []).filter((o) => !o.is_none_of_above).at(-1)
    ?.value_text as string;
  /** Every value of every non-tier gate this form reads (T58's work-area sections). */
  const allSectionValues: Record<string, unknown> = {};
  for (const item of pack.items) {
    for (const field of predicateFields(item.ask_if as never)) {
      if (field === gate.question_key || field === level.question_key) continue;
      const source = pack.items.find((i) => i.question_key === field);
      allSectionValues[field] = (source?.options ?? []).map(resolveOptionValue);
    }
  }

  it("is the active form, and opens with the experience gate then the level question", () => {
    expect(pack.status).toBe("active");
    expect(gate.question_key.endsWith("_experience")).toBe(true);
    expect(level.question_key.endsWith("_level")).toBe(true);
  });

  it("the tier gate carries a numeric value and NO value_text, so every band resolves to a number", () => {
    expect((gate.options ?? []).length).toBeGreaterThan(0);
    for (const o of gate.options ?? []) {
      expect(typeof o.value_number).toBe("number");
      expect(o.value_text ?? null).toBeNull();
      expect(typeof resolveOptionValue(o)).toBe("number");
    }
  });

  it(`the fresher path asks the ${fresherCount} fresher question(s), and nobody else is asked them`, () => {
    expect(fresherItems).toHaveLength(fresherCount);
    const fresher = askedFor(answers(0));
    for (const k of fresherItems) expect(fresher).toContain(k);
    const veteran = askedFor(answers(12, topRung, allSectionValues));
    for (const k of fresherItems) expect(veteran).not.toContain(k);
  });

  it("the most senior path asks every non-fresher question but other rungs' confirms, inside MAX_ENGINE_ASKS", () => {
    // A rung's confirm question is asked at that rung only, so the top rung skips the others'.
    const otherRungConfirms = pack.items
      .filter((i) => {
        const a = i.ask_if as {
          op?: string;
          left?: { field?: string };
          right?: { const?: unknown };
        };
        return (
          a?.op === "in" &&
          a.left?.field === level.question_key &&
          !(a.right?.const as string[]).includes(topRung)
        );
      })
      .map((i) => i.question_key);
    const senior = askedFor(answers(12, topRung, allSectionValues));
    expect(senior).toHaveLength(pack.items.length - fresherCount - otherRungConfirms.length);
    for (const k of otherRungConfirms) expect(senior).not.toContain(k);
    // The budget holds on EVERY rung's senior path, not only the top one.
    for (const o of level.options ?? []) {
      const rung = resolveOptionValue(o) as string;
      if (o.is_none_of_above) continue;
      const asked = askedFor(answers(12, rung, allSectionValues));
      expect(asked.length + UNIVERSAL_ASKS, rung).toBeLessThanOrEqual(MAX_ENGINE_ASKS);
    }
  });

  it("an experience band opens the tier gates by NUMBER: 1-3 years opens less than 10+ years", () => {
    const junior = askedFor(answers(2));
    const senior = askedFor(answers(12));
    for (const k of junior) expect(senior.includes(k) || fresherItems.includes(k)).toBe(true);
    expect(senior.length).toBeGreaterThanOrEqual(junior.length);
  });

  it("an unanswered gate asks nothing gated — it fails closed, not open", () => {
    const ungated = pack.items.filter((i) => !i.ask_if).map((i) => i.question_key);
    expect(askedFor({})).toEqual(ungated);
  });

  it("tags every question with a tier, and no question below a question it depends on", () => {
    const tags = new Map(pack.items.map((i) => [i.question_key, i.min_tier ?? null]));
    expect(pack.items.filter((i) => !i.min_tier).map((i) => i.question_key)).toEqual([]);
    const rank = (key: string) => PROFILING_TIERS.indexOf(tags.get(key) ?? "hard");
    const violations = pack.items.flatMap((item) =>
      [
        ...predicateFields(item.ask_if as never),
        ...predicateFields(item.skip_if as never),
        ...(item.parent_item_key ? [item.parent_item_key] : []),
      ]
        .filter((dep) => tags.has(dep) && rank(dep) > rank(item.question_key))
        .map((dep) => `${item.question_key} (${tags.get(item.question_key)}) on ${dep}`),
    );
    expect(violations).toEqual([]);
  });
});

/**
 * #3008 "Done when": a worker with stored answers on version 1 of a deepened form still has them
 * read once version 2 is the active form.
 *
 * Stored answers key on (worker, pack_id, question_key), never on the version
 * (`worker_pack_answer`, `TradeFormRepository.listAnswers`), so this drives the same read the
 * form does — `answerMapFromRows` over v1-written rows, then `isFormQuestionVisible` on the v2
 * items — with one stored answer per v1 question, each a value v1 offered.
 */
const DEEPENED: ReadonlyArray<readonly [packId: string, v1Only: readonly string[]]> = [
  ["qp_edm_wirecut", []],
  ["qp_heat_treatment", []],
  ["qp_injection_moulding", ["moulding_training_institute"]],
  ["qp_plc_automation", ["plc_technician_confirm"]],
  [
    "qp_production_supervisor",
    ["supervision_report_confirm", "supervision_machines", "supervision_systems"],
  ],
  ["qp_cad_design_3d", []],
];

function storedRow(packId: string, item: PackItem, value: unknown): WorkerPackAnswer {
  return {
    id: `row-${item.question_key}`,
    workerId: "worker",
    chatSessionId: null,
    packId,
    packVersion: 1,
    questionKey: item.question_key,
    answerText: typeof value === "string" ? value : null,
    answerNumber: typeof value === "number" ? value : null,
    answerBool: null,
    answerOptionKeys: Array.isArray(value) ? (value as string[]) : null,
    answerOtherText: null,
    answerOtherTextPolished: null,
    answerOtherTextPolishedDeclined: false,
    status: "answered",
    source: "form",
    answeredAt: new Date(),
  } as WorkerPackAnswer;
}

/** The value a worker's tap on the v1 question stored: the most senior band, else the first chip. */
function v1Value(item: PackItem): unknown {
  const options = (item.options ?? []).filter((o) => !o.is_none_of_above);
  if (item.answer_type === "text") return "apna kaam";
  if (item.question_key.endsWith("_experience")) {
    return Math.max(...options.map((o) => o.value_number ?? 0));
  }
  const first = options[0];
  if (!first) throw new Error(`${item.question_key} has no chip`);
  const value = resolveOptionValue(first);
  return item.answer_type === "multi_select" ? [value] : value;
}

describe.each(DEEPENED)("stored v1 answers read under v2 — %s", (packId, v1Only) => {
  const v1 = readPack(packId);
  const v2raw = readPack(`${packId}@2`);
  const v2 = packFromCorpus(`${packId}@2`);
  const stored = v1.items.map((item) => [item, v1Value(item)] as const);
  const map = answerMapFromRows(stored.map(([item, value]) => storedRow(packId, item, value)));
  const v2Keys = new Set(v2.items.map((i) => i.question_key));

  it("v1 is deprecated in place and v2 is the active form of the same pack", () => {
    expect(v1.status).toBe("deprecated");
    expect(v2raw.status).toBe("active");
    expect(v2.pack_id).toBe(packId);
  });

  it("every kept v1 question is a v2 question, showing the worker's stored answer unchanged", () => {
    const kept = stored.filter(([item]) => v2Keys.has(item.question_key));
    expect(kept.length).toBe(v1.items.length - v1Only.length);
    for (const [item, value] of kept) {
      const v2item = v2.items.find((i) => i.question_key === item.question_key);
      expect(v2item, item.question_key).toBeDefined();
      expect(isFormQuestionVisible(v2item!, map), item.question_key).toBe(true);
      expect(map[item.question_key]?.status).toBe("answered");
      expect(map[item.question_key]?.value_normalized).toEqual(value);
    }
  });

  it("the questions v2 drops stay stored and readable, and are not asked by v2", () => {
    for (const key of v1Only) {
      expect(v2Keys.has(key), key).toBe(false);
      expect(map[key]?.status, key).toBe("answered");
    }
  });

  it("the stored v1 experience opens v2's senior questions — the gate reads the old number", () => {
    const gateKey = v2.items[0]!.question_key;
    expect(typeof map[gateKey]?.value_normalized).toBe("number");
    const seniorOnly = v2.items.filter((item) => {
      const raw = JSON.stringify(item.ask_if ?? null);
      return raw.includes(`"field":"${gateKey}"`) && raw.includes('"op":"gte"');
    });
    expect(seniorOnly.length).toBeGreaterThan(0);
    for (const item of seniorOnly) {
      expect(isFormQuestionVisible(item, map), item.question_key).toBe(true);
    }
  });
});
