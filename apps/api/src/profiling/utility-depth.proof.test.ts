/**
 * The depth ladder of `qp_utility`, proven against the REAL predicate evaluator and the REAL
 * option-resolution chain — Wave 2 (#3016 step 7).
 *
 * WHY THIS TEST RESOLVES THE OPTION ITSELF instead of just handing `evaluatePredicate` a number.
 * A stray `value_text` sitting next to `value_number` on the tier gate turns every `gte` below
 * into a string compare that is false forever (#776), and a test that asserts a hand-written
 * number cannot fail on that defect. So the ladder is driven by TAPPING A CHIP (`answerFor`),
 * resolved through the registry's `??` chain, exactly like `cnc-turning-depth.proof.test.ts`.
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
  is_none_of_above?: boolean;
}
interface PackItem {
  question_key: string;
  answer_type: string;
  ask_if?: { op: string; right?: { const?: unknown }; predicates?: { right?: { const?: unknown } }[] };
  options?: PackOption[];
}

const PACK_PATH = join(
  __dirname,
  "../../../../packages/db/data/question-packs/packs/qp_utility.json",
);
const pack = JSON.parse(readFileSync(PACK_PATH, "utf8")) as { items: PackItem[] };

const GATE_KEY = "utility_experience";
const LEVEL_KEY = "utility_level";

/** EXACTLY `pack-registry.service.ts:530`. A drift here is a test that stops protecting anything. */
function resolveOptionValue(o: PackOption): unknown {
  return o.value_text ?? o.value_number ?? o.value_bool ?? null;
}

const gate = pack.items.find((i) => i.question_key === GATE_KEY);
const level = pack.items.find((i) => i.question_key === LEVEL_KEY);

/** The answer map produced by TAPPING the gate chip whose numeric band is `band`. */
function answerFor(band: number | undefined) {
  if (band === undefined) return {};
  const chip = (gate?.options ?? []).find((o) => o.value_number === band);
  if (!chip) throw new Error(`no ${GATE_KEY} chip with value_number ${band}`);
  return { [GATE_KEY]: { value_normalized: resolveOptionValue(chip) } };
}

/** The answer map produced by TAPPING the level chip `rung`. */
function levelFor(rung: string | undefined) {
  if (rung === undefined) return {};
  const chip = (level?.options ?? []).find((o) => o.value_text === rung);
  if (!chip) throw new Error(`no ${LEVEL_KEY} chip with value_text ${rung}`);
  return { [LEVEL_KEY]: { value_normalized: resolveOptionValue(chip) } };
}

/** Non-tier gates this form reads (a section opener, not the experience gate): held open. */
const SECTION_VALUES: Record<string, unknown> = {};

function ctx(band: number | undefined, rung?: string) {
  // Section openers are themselves answers: with no gate answer there are no answers at all.
  const section = band === undefined ? {} : SECTION_VALUES;
  return {
    answers: { ...answerFor(band), ...levelFor(rung), ...section },
    occupation: null,
    phase: "occupation_specific",
    turn: 5,
  } as never;
}

function askedFor(band: number | undefined, rung?: string): string[] {
  return pack.items
    .filter((i) => !i.ask_if || evaluatePredicate(i.ask_if as never, ctx(band, rung)))
    .map((i) => i.question_key);
}

/** Tier-1/2 items, detected through the `any(years OR level)` gates. */
function gteConst(i: PackItem): unknown {
  const ask = i.ask_if as
    | { op: string; right?: { const?: unknown }; predicates?: { right?: { const?: unknown } }[] }
    | undefined;
  if (ask?.op === "any") return ask.predicates?.[0]?.right?.const;
  return ask?.right?.const;
}

const fresherItems = pack.items
  .filter((i) => (i.ask_if as { op?: string } | undefined)?.op === "lte")
  .map((i) => i.question_key);
const tiered = pack.items.filter((i) => i.ask_if && !fresherItems.includes(i.question_key));
const tier1 = tiered.filter((i) => gteConst(i) === 2).map((i) => i.question_key);
const tier2 = tiered.filter((i) => gteConst(i) === 5).map((i) => i.question_key);
const ungated = pack.items.filter((i) => !i.ask_if).map((i) => i.question_key);
const topRung = (level?.options ?? []).filter((o) => !o.is_none_of_above).at(-1)
  ?.value_text as string;
/** A rung's confirm question is asked at that rung only, so the top rung skips the others'. */
const otherRungConfirms = pack.items
  .filter((i) => {
    const a = i.ask_if as { op?: string; left?: { field?: string }; right?: { const?: unknown } };
    return (
      a?.op === "in" &&
      a.left?.field === LEVEL_KEY &&
      !(a.right?.const as string[]).includes(topRung)
    );
  })
  .map((i) => i.question_key);

/**
 * The active tail's item count, pinned so a tail change shows up here too — see
 * `cnc-turning-depth.proof.test.ts` for why the number is a literal.
 */
const UNIVERSAL_ASKS = 18;

describe("qp_utility depth ladder", () => {
  it("is the active form, and opens with the experience gate then the level question", () => {
    expect((pack.items[0] as PackItem).question_key).toBe(GATE_KEY);
    expect((pack.items[1] as PackItem).question_key).toBe(LEVEL_KEY);
  });

  it("the tier gate carries a numeric value and NO value_text", () => {
    // The guard the cnc-turning proof file exists for. A `value_text` here silently disables
    // every gate below.
    expect(gate).toBeDefined();
    for (const o of gate?.options ?? []) {
      expect(typeof o.value_number).toBe("number");
      expect(o.value_text ?? null).toBeNull();
      expect(typeof resolveOptionValue(o)).toBe("number");
    }
  });

  it("a worker under 1 year gets the base questions PLUS the 3 fresher items", () => {
    expect(fresherItems).toHaveLength(3);
    const asked = askedFor(0);
    for (const k of ungated) expect(asked).toContain(k);
    for (const k of fresherItems) expect(asked).toContain(k);
    for (const k of [...tier1, ...tier2]) expect(asked).not.toContain(k);
  });

  it("a 1-3 year worker gets base + tier 1, and never tier 2", () => {
    const asked = askedFor(2);
    for (const k of tier1) expect(asked).toContain(k);
    for (const k of tier2) expect(asked).not.toContain(k);
  });

  it("level never closes a gate years already opened", () => {
    // `any` only widens: the top rung keeps every section the years open.
    const byYears = askedFor(12);
    for (const k of byYears) expect(askedFor(12, topRung)).toContain(k);
  });

  it("the most senior path asks every non-fresher question but other rungs' confirms, inside MAX_ENGINE_ASKS", () => {
    const senior = askedFor(12, topRung);
    expect(senior).toHaveLength(pack.items.length - fresherItems.length - otherRungConfirms.length);
    for (const k of otherRungConfirms) expect(senior).not.toContain(k);
    for (const k of fresherItems) expect(senior).not.toContain(k);
    // The budget holds on EVERY rung's senior path, not only the top one.
    for (const o of level?.options ?? []) {
      const rung = resolveOptionValue(o) as string;
      if (o.is_none_of_above) continue;
      const asked = askedFor(12, rung);
      expect(asked.length + UNIVERSAL_ASKS, rung).toBeLessThanOrEqual(MAX_ENGINE_ASKS);
    }
  });

  it("an unanswered gate asks nothing gated — it fails closed, not open", () => {
    expect(askedFor(undefined)).toEqual(ungated);
  });
});
