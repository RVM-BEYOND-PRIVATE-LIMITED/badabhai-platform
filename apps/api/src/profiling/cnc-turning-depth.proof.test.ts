/**
 * The depth ladder of `qp_cnc_turning`, proven against the REAL predicate evaluator and the
 * REAL option-resolution chain.
 *
 * WHY THIS TEST RESOLVES THE OPTION ITSELF instead of just handing `evaluatePredicate` a number.
 * The first version of this file did the latter, and a mutation that injected the exact authoring
 * trap the pack warns about — a `value_text` sitting next to `value_number` on the tier gate —
 * left all six tests GREEN. That test could not fail on the defect it existed to prevent.
 *
 * The trap is real: `pack-registry.service.ts:530` resolves an option as
 * `valueText ?? valueNumber ?? valueBool`, so a stray `value_text` makes the captured answer the
 * STRING "10". `predicate.ts:compare()` refuses to order a string against a number and returns
 * null, so every `gte` gate evaluates false, forever — and a permanently-false `ask_if` is a
 * question that is simply never asked, with no error anywhere. That is #776, which sat in
 * `qp_welding` for the life of the pack.
 *
 * So `resolveOptionValue` below mirrors the registry's `??` chain exactly, and the tests drive the
 * ladder by TAPPING A CHIP (`answerFor`), not by asserting a hand-written number.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { evaluatePredicate } from "./predicate";
import { MAX_ENGINE_ASKS } from "./next-question";

interface PackOption {
  option_key: string;
  label_text: string;
  value_text?: string | null;
  value_number?: number | null;
  value_bool?: boolean | null;
}
interface PackItem {
  question_key: string;
  answer_type: string;
  ask_if?: { op: string; right?: { const?: unknown } };
  options?: PackOption[];
}

const PACK_PATH = join(
  __dirname,
  "../../../../packages/db/data/question-packs/packs/qp_cnc_turning@2.json",
);
const pack = JSON.parse(readFileSync(PACK_PATH, "utf8")) as { items: PackItem[] };

const GATE_KEY = "turning_experience";
const LEVEL_KEY = "turning_level";

/** EXACTLY `pack-registry.service.ts:530`. A drift here is a test that stops protecting anything. */
function resolveOptionValue(o: PackOption): unknown {
  return o.value_text ?? o.value_number ?? o.value_bool ?? null;
}

const gate = pack.items.find((i) => i.question_key === GATE_KEY);

/** The answer map produced by TAPPING the gate chip whose numeric band is `band`. */
function answerFor(band: number | undefined) {
  if (band === undefined) return {};
  const chip = (gate?.options ?? []).find((o) => o.value_number === band);
  if (!chip) throw new Error(`no ${GATE_KEY} chip with value_number ${band}`);
  return { [GATE_KEY]: { value_normalized: resolveOptionValue(chip) } };
}

/** The answer map produced by TAPPING the level chip `level` (Middle-Way C3). */
function levelFor(level: string | undefined) {
  if (level === undefined) return {};
  const item = pack.items.find((i) => i.question_key === LEVEL_KEY);
  const chip = (item?.options ?? []).find((o) => o.value_text === level);
  if (!chip) throw new Error(`no ${LEVEL_KEY} chip with value_text ${level}`);
  return { [LEVEL_KEY]: { value_normalized: resolveOptionValue(chip) } };
}

function ctx(band: number | undefined, level?: string) {
  return {
    answers: { ...answerFor(band), ...levelFor(level) },
    occupation: null,
    phase: "occupation_specific",
    turn: 5,
  } as never;
}

function askedFor(band: number | undefined, level?: string): string[] {
  return pack.items
    .filter((i) => !i.ask_if || evaluatePredicate(i.ask_if as never, ctx(band, level)))
    .map((i) => i.question_key);
}

/** Tier-1/2 items, detected through the Middle-Way `any(years OR level)` gates. */
function gteConst(i: PackItem): unknown {
  const ask = i.ask_if as
    | { op: string; right?: { const?: unknown }; predicates?: { right?: { const?: unknown } }[] }
    | undefined;
  if (ask?.op === "any") return ask.predicates?.[0]?.right?.const;
  return ask?.right?.const;
}

const tiered = pack.items.filter((i) => i.ask_if);
const tier1 = tiered.filter((i) => gteConst(i) === 2).map((i) => i.question_key);
const tier2 = tiered.filter((i) => gteConst(i) === 5).map((i) => i.question_key);

/**
 * The active tail's item count, pinned so a tail change shows up here too. `qp_universal@4`
 * serves eighteen items: v2's eight plus `languages`/`work_types` (Phase 1) plus the Layer A
 * elicitation's eight. It is deliberately a literal HERE rather than a corpus read — this file
 * proves the turner LADDER's fit (`asked + universal <= budget`), and the budget guard beside it
 * is what pins the walk against a real corpus.
 */
const UNIVERSAL_ASKS = 18;
const ENGINE_ASK_BUDGET = MAX_ENGINE_ASKS;

describe("qp_cnc_turning depth ladder", () => {
  it("the tier gate carries a numeric value and NO value_text", () => {
    // The guard the mutation exposed. A `value_text` here silently disables every gate below.
    expect(gate).toBeDefined();
    for (const o of gate?.options ?? []) {
      expect(typeof o.value_number).toBe("number");
      expect(o.value_text ?? null).toBeNull();
      expect(typeof resolveOptionValue(o)).toBe("number");
    }
  });

  it("tier composition is 9 base / 3 gated at >=2-or-setter / 4 gated at >=5-or-programmer", () => {
    expect(pack.items.length - tiered.length).toBe(9);
    expect(tier1).toHaveLength(3);
    expect(tier2).toHaveLength(4);
  });

  it("a worker under 1 year gets the 9 base questions PLUS the 3 fresher items", () => {
    // R10 §2.6 — the FRESHER branch. §11 #1 puts training, trade test, workshop machines and
    // project work in a fresher's Zone 4, and nothing in the corpus asked any of it: persona 1
    // measured 125 mm of blank page. The three items are gated `lte 0`, so they are DISJOINT from
    // tiers 1 and 2 and cost a senior nothing — which is why the ask budget's worst case is
    // unchanged at 26.
    const asked = askedFor(0);
    expect(asked).toHaveLength(12);
    for (const k of [...tier1, ...tier2]) expect(asked).not.toContain(k);
    for (const k of ["iti_workshop_machines", "trade_test_status", "iti_project_work"]) {
      expect(asked).toContain(k);
    }
  });

  it("a 1-3 year worker gets base + tier 1, and never tier 2", () => {
    const asked = askedFor(2);
    expect(asked).toHaveLength(12);
    for (const k of tier1) expect(asked).toContain(k);
    for (const k of tier2) expect(asked).not.toContain(k);
  });

  it("a setter with under 2 years is asked the setter section anyway (Middle-Way C4)", () => {
    const asked = askedFor(0, "setter");
    for (const k of tier1) expect(asked).toContain(k);
    for (const k of tier2) expect(asked).not.toContain(k);
  });

  it("a programmer with 3 years is asked the programming section (old 5-year wall bypassed)", () => {
    const asked = askedFor(2, "programmer");
    for (const k of [...tier1, ...tier2]) expect(asked).toContain(k);
  });

  it("level never closes a gate years already opened", () => {
    // `any` only widens: a senior who answers "operator" keeps every section.
    const asked = askedFor(10, "operator");
    for (const k of [...tier1, ...tier2]) expect(asked).toContain(k);
  });

  it("a 7+ year worker gets all 16 non-fresher items, and still fits the ask budget", () => {
    const asked = askedFor(10);
    expect(asked).toHaveLength(16);
    expect(asked.length + UNIVERSAL_ASKS).toBeLessThanOrEqual(ENGINE_ASK_BUDGET);
  });

  it("an unanswered gate asks nothing tiered — it fails closed, not open", () => {
    expect(askedFor(undefined)).toHaveLength(9);
  });
});
