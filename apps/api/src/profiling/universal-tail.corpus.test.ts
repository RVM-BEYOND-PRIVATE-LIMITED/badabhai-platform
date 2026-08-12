import { describe, expect, it } from "vitest";
import type { QuestionPack, QuestionPackItem } from "@badabhai/ai-contracts";
import { loadQuestionPackCorpus, type PackRecord } from "@badabhai/db";

import { recordAnswer, toAnswerMap, type AnswerMap } from "./answer-map";
import { emptyProfilingEnvelope, toEngineState, withAnswers } from "./conversation-state";
import { nextQuestion } from "./next-question";

/**
 * WHAT THE TEMPLATE TAIL ACTUALLY ASKS, walked against the REAL corpus.
 *
 * WHY THIS IS NOT A UNIT TEST WITH A HAND-BUILT PACK. Every other test in this directory builds
 * its own two-item pack, which is right for testing the ENGINE. This one tests the authored DATA:
 * the question set a worker gets is a property of `qp_universal`, of `display_order`, of the turn
 * windows, and of what Phase A has already settled — and not one of those is visible in a
 * hand-built fixture. The owner ruling (2026-08-11) is a statement about the corpus: the template
 * tail is SIX questions. Only a walk over the corpus can hold that.
 *
 * IT ALSO CATCHES THE DEFECT THAT MADE v2 NECESSARY. `current_city` is mandatory and carried
 * `max_turn: 5` in v1, so an interview that reached the tail after turn 5 could never ask it and
 * closed `complete` without the strongest matching signal there is. The LLM-led opening reaches
 * the tail late BY CONSTRUCTION, so what was a long-interview edge case became the normal path.
 * The late-start case below is that regression, pinned.
 */

/**
 * The corpus record → the engine's item shape.
 *
 * NOT A CAST. The JSON omits every field it does not need (`parent_item_key`, `ask_if`,
 * `options`, …) and the engine reads them as `null`/`[]` — `PackRepository` does this mapping
 * when it loads from Postgres. Casting instead makes `item.parent_item_key` `undefined`, which
 * `isServable` compares `!== null` and then treats as a follow-up whose parent is unanswered:
 * EVERY item becomes unservable and the walk closes on turn one with `complete`. That is a
 * silently green test, so the mapping is written out rather than asserted away.
 */
function toItem(raw: Record<string, unknown>, displayOrder: number): QuestionPackItem {
  const options = (raw.options as Array<Record<string, unknown>> | undefined) ?? [];
  return {
    question_key: raw.question_key as string,
    prompt_text: raw.prompt_text as string,
    display_order: displayOrder,
    target_kind: (raw.target_kind as QuestionPackItem["target_kind"]) ?? "none",
    target_field: (raw.target_field as string | undefined) ?? null,
    target_skill_id: (raw.target_skill_id as string | undefined) ?? null,
    // The corpus carries three authoring types the contract does not (`city`, `salary`,
    // `duration`); the seed path narrows them the same way. Only `select` matters to selection.
    answer_type: (["city", "salary", "duration"].includes(raw.answer_type as string)
      ? "text"
      : raw.answer_type) as QuestionPackItem["answer_type"],
    is_mandatory: (raw.is_mandatory as boolean | undefined) ?? false,
    is_core: (raw.is_core as boolean | undefined) ?? false,
    max_asks: (raw.max_asks as number | undefined) ?? 2,
    min_turn: (raw.min_turn as number | undefined) ?? null,
    max_turn: (raw.max_turn as number | undefined) ?? null,
    ask_if: (raw.ask_if as QuestionPackItem["ask_if"]) ?? null,
    skip_if: (raw.skip_if as QuestionPackItem["skip_if"]) ?? null,
    parent_item_key: (raw.parent_item_key as string | undefined) ?? null,
    retry_text: (raw.retry_text as string | undefined) ?? null,
    why_text: (raw.why_text as string | undefined) ?? null,
    options: options.map((o) => ({
      option_key: o.option_key as string,
      label_text: o.label_text as string,
      value: (o.value_text ?? o.value_bool ?? null) as QuestionPackItem["options"][number]["value"],
      implies_skill_id: null,
      is_none_of_above: (o.is_none_of_above as boolean | undefined) ?? false,
    })),
  };
}

function universal(version: number): QuestionPack {
  const record = loadQuestionPackCorpus().packs.find(
    (p: PackRecord) => p.pack_id === "qp_universal" && p.version === version,
  );
  if (!record) throw new Error(`qp_universal@${version} is not in the corpus`);
  return {
    pack_id: record.pack_id,
    version: record.version,
    family_id: record.family_id,
    locale: record.locale ?? "hi-IN",
    status: (record.status ?? "active") as QuestionPack["status"],
    content_hash: `corpus_${record.pack_id}_${record.version}`,
    items: (record.items as unknown as Array<Record<string, unknown>>).map(toItem),
  };
}

/** Answer whatever the engine serves, in order, and report what it asked. */
function walk(pack: QuestionPack, startTurn: number, settled: Record<string, unknown>): string[] {
  let answers: AnswerMap = toAnswerMap([]);
  const write = (key: string, value: unknown, turn: number): void => {
    const item = pack.items.find((i) => i.question_key === key);
    answers = recordAnswer(
      answers,
      {
        questionKey: key,
        targetField: item?.target_field ?? null,
        valueRaw: String(value),
        valueNormalized: value,
        evidence: null,
      },
      turn,
    );
  };
  for (const [key, value] of Object.entries(settled)) write(key, value, 1);

  let envelope = withAnswers(emptyProfilingEnvelope(), answers);
  const asked: string[] = [];
  for (let turn = startTurn; turn < startTurn + 20; turn++) {
    const decision = nextQuestion(toEngineState(envelope, turn), {
      occupation: null,
      universal: pack,
    });
    if (decision.kind !== "ask") break;
    const key = decision.questionKey as string;
    asked.push(key);
    const item = pack.items.find((i) => i.question_key === key) as QuestionPackItem;
    write(key, item.options[0]?.value ?? item.options[0]?.label_text ?? "answer", turn);
    envelope = withAnswers(
      {
        ...envelope,
        engineAsks: envelope.engineAsks + 1,
        askCounts: { ...envelope.askCounts, [key]: 1 },
        servedQuestionKey: key,
      },
      answers,
    );
  }
  return asked;
}

/** What Phase A settles before handing over — see `settleFromLlmDraft` in the orchestrator. */
const AFTER_PHASE_A = { primary_trade: "tandoor cook", experience_years: 4 };

const TAIL = [
  "current_city",
  "salary_expected",
  "preferred_locations",
  "availability",
  "education",
  "shift_preference",
];

describe("the template tail, over the REAL corpus", () => {
  it("asks exactly the SIX the owner ruled on, once Phase A has handed over", () => {
    expect(walk(universal(2), 8, AFTER_PHASE_A)).toEqual(TAIL);
  });

  it("asks the same six whether the tail is reached early or late", () => {
    // The turn number a tail is entered on depends on how long Phase A ran, how many silences the
    // worker had, and how many times they asked "why". None of that may change the question set.
    for (const startTurn of [4, 6, 8, 12]) {
      expect(walk(universal(2), startTurn, AFTER_PHASE_A), `entered at turn ${startTurn}`).toEqual(
        TAIL,
      );
    }
  });

  it("still asks the trade and the experience when the model never ran", () => {
    // The fallback path: nothing pre-settled, so the pack asks its own two as well. `current_city`
    // lands second rather than third because it is the only MANDATORY item besides the trade, and
    // `min_turn: 2` is what holds it off turn one.
    expect(walk(universal(2), 1, {})).toEqual([
      "primary_trade",
      "current_city",
      "experience_years",
      "salary_expected",
      "preferred_locations",
      "availability",
      "education",
      "shift_preference",
    ]);
  });

  it("v1 STARVED the mandatory city question on a late tail — the defect v2 exists to fix", () => {
    // Pinned as a regression rather than described in a comment. `current_city` is mandatory and
    // carried `max_turn: 5`, so a tail entered at turn 8 closed `complete` having never asked a
    // worker where they live. v1 is frozen and keeps the defect; v2 must not have it.
    const late = walk(universal(1), 8, {});
    expect(late).not.toContain("current_city");
    expect(late).not.toContain("salary_expected");

    expect(walk(universal(2), 8, {})).toContain("current_city");
    expect(walk(universal(2), 8, {})).toContain("salary_expected");
  });

  it("drops `relocation`, which `preferred_locations` subsumes", () => {
    expect(walk(universal(2), 1, {})).not.toContain("relocation");
    // v1 keeps it — a published version's question set is frozen for the sessions pinned to it.
    expect(walk(universal(1), 1, {})).toContain("relocation");
  });
});
