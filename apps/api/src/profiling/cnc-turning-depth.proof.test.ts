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
  "../../../../packages/db/data/question-packs/packs/qp_cnc_turning.json",
);
const pack = JSON.parse(readFileSync(PACK_PATH, "utf8")) as { items: PackItem[] };

const GATE_KEY = "turning_experience";

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

function ctx(band: number | undefined) {
  return {
    answers: answerFor(band),
    occupation: null,
    phase: "occupation_specific",
    turn: 5,
  } as never;
}

function askedFor(band: number | undefined): string[] {
  return pack.items
    .filter((i) => !i.ask_if || evaluatePredicate(i.ask_if as never, ctx(band)))
    .map((i) => i.question_key);
}

const tiered = pack.items.filter((i) => i.ask_if);
const tier1 = tiered.filter((i) => i.ask_if?.right?.const === 2).map((i) => i.question_key);
const tier2 = tiered.filter((i) => i.ask_if?.right?.const === 5).map((i) => i.question_key);

/** `MAX_ENGINE_ASKS` in next-question.ts, minus the 8 items `qp_universal@2` always spends. */
const ENGINE_ASK_BUDGET = 24;
const UNIVERSAL_ASKS = 8;

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

  it("tier composition is 8 base / 3 gated at >=2 / 4 gated at >=5", () => {
    expect(pack.items.length - tiered.length).toBe(8);
    expect(tier1).toHaveLength(3);
    expect(tier2).toHaveLength(4);
  });

  it("a worker under 1 year gets ONLY the 8 base questions", () => {
    const asked = askedFor(0);
    expect(asked).toHaveLength(8);
    for (const k of [...tier1, ...tier2]) expect(asked).not.toContain(k);
  });

  it("a 1-3 year worker gets base + tier 1, and never tier 2", () => {
    const asked = askedFor(2);
    expect(asked).toHaveLength(11);
    for (const k of tier1) expect(asked).toContain(k);
    for (const k of tier2) expect(asked).not.toContain(k);
  });

  it("a 7+ year worker gets all 15, and still fits the engine ask budget", () => {
    const asked = askedFor(10);
    expect(asked).toHaveLength(15);
    expect(asked.length + UNIVERSAL_ASKS).toBeLessThanOrEqual(ENGINE_ASK_BUDGET);
  });

  it("an unanswered gate asks nothing tiered — it fails closed, not open", () => {
    expect(askedFor(undefined)).toHaveLength(8);
  });
});
