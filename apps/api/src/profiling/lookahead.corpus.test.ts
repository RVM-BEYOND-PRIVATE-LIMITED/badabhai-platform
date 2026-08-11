/**
 * The lookahead, checked against EVERY single-select chip in EVERY shipped pack.
 *
 * WHY A CORPUS TEST AND NOT MORE UNIT TESTS. The unit suite builds its own packs, so it can only
 * ever check the cases someone thought to write down — and the defect this file exists to prevent
 * was invisible to exactly that: the first implementation hand-folded `recordAnswer(option.value)`
 * instead of running the real capture path, and the unit oracle folded the same way, so the two
 * agreed by construction and the suite went green.
 *
 * The corpus disagreed. `captureAnswer` classifies an utterance BEFORE it normalizes, so a chip
 * whose label reads as "nahi pata" is recorded DECLINED, and one the item's normalizer refuses
 * yields no value at all — leaving the question unsettled so the engine asks it AGAIN. Five of 453
 * shipped chips behave that way, and three of them are on `qp_universal/relocation`, a question
 * every worker in the platform reaches.
 *
 * This is a GOLDEN test in the same spirit as `pack-served-text.golden.test.ts`: it reads the
 * committed corpus rather than a fixture, so authoring a chip whose label the capture path refuses
 * fails here rather than mispredicting on a worker's phone.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { QuestionPack, QuestionPackItem } from "@badabhai/ai-contracts";

import { captureAnswer } from "./answer-capture";
import { recordAnswer, recordDeclined, type AnswerMap } from "./answer-map";
import { computeLookahead } from "./lookahead";
import { nextQuestion, type Decision, type EnginePacks, type EngineState } from "./next-question";

// Anchored to THIS FILE rather than `process.cwd()`: with cwd it resolves only when vitest is
// invoked from `apps/api`, so running the suite from the repo root failed on an ENOENT that reads
// like a missing corpus rather than a wrong working directory.
const PACK_DIR = join(__dirname, "../../../../packages/db/data/question-packs/packs");

/** A corpus row → the contract's item. The JSON omits every field it leaves null. */
function toItem(raw: Record<string, unknown>): QuestionPackItem {
  return {
    ...raw,
    options: raw.options ?? [],
    why_text: raw.why_text ?? null,
    retry_text: raw.retry_text ?? null,
    target_field: raw.target_field ?? null,
    target_skill_id: raw.target_skill_id ?? null,
    min_turn: raw.min_turn ?? null,
    max_turn: raw.max_turn ?? null,
    ask_if: raw.ask_if ?? null,
    skip_if: raw.skip_if ?? null,
    parent_item_key: raw.parent_item_key ?? null,
  } as QuestionPackItem;
}

function toPack(packId: string, items: readonly QuestionPackItem[]): QuestionPack {
  return {
    pack_id: packId,
    version: 1,
    family_id: "fam_corpus",
    locale: "hi-IN",
    status: "active",
    content_hash: "corpus",
    items: [...items],
  } as QuestionPack;
}

/** The state a turn that just served `questionKey` leaves behind. */
function afterServing(questionKey: string): EngineState {
  return {
    phase: "occupation_specific",
    turn: 3,
    engineAsks: 1,
    askCounts: { [questionKey]: 1 },
    answers: {} as AnswerMap,
    occupation: null,
    servedQuestionKey: questionKey,
    clarifyCount: 0,
    abusiveTurns: 0,
    silentTurns: 0,
    hardshipTurns: 0,
    needsDisambiguation: false,
  };
}

/**
 * The oracle: the worker's TEXT through the real capture path, then the real engine — exactly what
 * `ProfilingOrchestrator.decide` does between one turn and the next.
 */
function actuallyServed(
  before: EngineState,
  packs: EnginePacks,
  item: QuestionPackItem,
  text: string,
): Decision {
  const capture = captureAnswer(text, item);
  let answers: AnswerMap = before.answers;
  if (capture.declined) {
    answers = recordDeclined(answers, item.question_key, 4);
  } else {
    for (const value of capture.values) answers = recordAnswer(answers, value, 4);
  }
  return nextQuestion(
    {
      ...before,
      turn: 4,
      answers,
      clarifyCount: 0,
      silentTurns: 0,
      hardshipTurns: 0,
      needsDisambiguation: false,
    },
    packs,
  );
}

describe("the lookahead against the shipped corpus", () => {
  it("predicts what the engine actually serves, for every single-select chip authored", () => {
    const universalRaw = JSON.parse(
      readFileSync(join(PACK_DIR, "qp_universal.json"), "utf8"),
    ) as { items: Record<string, unknown>[] };
    const universal = toPack("qp_universal", [toItem(universalRaw.items[0] as never)]);

    let checked = 0;
    const mispredicted: string[] = [];

    for (const file of readdirSync(PACK_DIR).filter((name) => name.endsWith(".json"))) {
      const raw = JSON.parse(readFileSync(join(PACK_DIR, file), "utf8")) as {
        pack_id: string;
        items: Record<string, unknown>[];
      };
      const items = (raw.items ?? []).map(toItem);
      const packs: EnginePacks = { occupation: toPack(raw.pack_id, items), universal };
      const all = [...items, ...universal.items];

      for (const item of items) {
        if (item.answer_type !== "single_select") continue;
        const before = afterServing(item.question_key);
        const predicted = computeLookahead({
          decision: {
            kind: "ask",
            questionKey: item.question_key,
            promptText: item.prompt_text,
            options: item.options,
            phase: "occupation_specific",
            completionReason: null,
            progress: { answered: 0, total: 0 },
            isReserve: false,
          },
          state: before,
          packs,
          items: all,
          nextTurn: 4,
        });

        for (const option of item.options) {
          const real = actuallyServed(before, packs, item, option.label_text);
          checked++;
          if (predicted?.[option.option_key]?.questionKey !== real.questionKey) {
            mispredicted.push(
              `${raw.pack_id}/${item.question_key}/${option.option_key}: ` +
                `predicted=${predicted?.[option.option_key]?.questionKey} real=${real.questionKey}`,
            );
          }
        }
      }
    }

    // A guard on the guard: if the corpus stops being readable this test must fail rather than
    // pass vacuously over zero chips.
    expect(checked).toBeGreaterThan(400);
    expect(mispredicted).toEqual([]);
  });
});
