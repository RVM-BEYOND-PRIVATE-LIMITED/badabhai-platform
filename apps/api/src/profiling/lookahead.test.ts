import { describe, expect, it } from "vitest";

import type { QuestionPack, QuestionPackItem, QuestionPackOption } from "@badabhai/ai-contracts";

import { recordAnswer, recordDeclined, type AnswerMap } from "./answer-map";
import {
  computeLookahead,
  LOOKAHEAD_DECLINED,
  LOOKAHEAD_MAX_BRANCHES,
  type LookaheadEntry,
} from "./lookahead";
import {
  CLOSING_REPLY_TEXT,
  MAX_ASKS_PER_QUESTION,
  nextQuestion,
  type Decision,
  type EnginePacks,
  type EngineState,
} from "./next-question";

// ---------------------------------------------------------------------------
// Builders — mirrored from next-question.test.ts so the two suites describe the
// same engine rather than two subtly different ones.
// ---------------------------------------------------------------------------

let order = 0;

function item(partial: Partial<QuestionPackItem> & { question_key: string }): QuestionPackItem {
  return {
    prompt_text: `${partial.question_key}?`,
    display_order: order++,
    target_kind: "rfs",
    target_field: null,
    target_skill_id: null,
    answer_type: "text",
    is_mandatory: false,
    is_core: false,
    max_asks: MAX_ASKS_PER_QUESTION,
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

function option(key: string, over: Partial<QuestionPackOption> = {}): QuestionPackOption {
  return {
    option_key: key,
    label_text: key.toUpperCase(),
    value: key,
    implies_skill_id: null,
    is_none_of_above: false,
    ...over,
  };
}

function pack(id: string, items: QuestionPackItem[]): QuestionPack {
  return {
    pack_id: id,
    version: 1,
    family_id: "fam_cnc_machining",
    locale: "hi",
    status: "active",
    content_hash: `hash_${id}`,
    items,
  };
}

function state(overrides: Partial<EngineState> = {}): EngineState {
  return {
    phase: "occupation_specific",
    turn: 1,
    engineAsks: 0,
    askCounts: {},
    answers: {} as AnswerMap,
    occupation: null,
    servedQuestionKey: null,
    clarifyCount: 0,
    abusiveTurns: 0,
    silentTurns: 0,
    hardshipTurns: 0,
    needsDisambiguation: false,
    ...overrides,
  };
}

function ask(questionKey: string, options: readonly QuestionPackOption[] = []): Decision {
  return {
    kind: "ask",
    questionKey,
    promptText: `${questionKey}?`,
    options,
    phase: "occupation_specific",
    completionReason: null,
    progress: { answered: 0, total: 0 },
    isReserve: false,
  };
}

/**
 * WHAT THE ENGINE ACTUALLY DOES on the next turn — the oracle every prediction is judged against.
 *
 * Deliberately re-implements the ONE thing the orchestrator does between turns (record the answer,
 * advance the turn, reset the consecutive-run counters) and then calls the real `nextQuestion`.
 * If this helper and `computeLookahead` ever disagree, one of them is wrong about the engine, and
 * that is exactly the failure this suite exists to catch.
 */
function actuallyServed(
  before: EngineState,
  packs: EnginePacks,
  answers: AnswerMap,
  nextTurn: number,
): Decision {
  return nextQuestion(
    {
      ...before,
      turn: nextTurn,
      answers,
      clarifyCount: 0,
      silentTurns: 0,
      hardshipTurns: 0,
      needsDisambiguation: false,
    },
    packs,
  );
}

const UNIVERSAL = pack("qp_universal", [item({ question_key: "city" })]);

describe("the prediction equals what the engine really serves", () => {
  /**
   * THE WHOLE CORRECTNESS CLAIM, and the only assertion that matters. A lookahead that is merely
   * plausible is worse than none: the client renders it without a round trip, so a wrong entry
   * reaches a worker's screen with nothing downstream to catch it.
   */
  it("for EVERY option of a single-select, matches the engine turn-for-turn", async () => {
    const machine = item({
      question_key: "machine_type",
      answer_type: "single_select",
      options: [option("lathe"), option("cnc_turning"), option("vmc")],
    });
    // A follow-up that only exists for one of those answers — the case a prediction can get wrong.
    const cncOnly = item({
      question_key: "programming",
      // The real AST shape: `field` addresses a QUESTION KEY in the answer map, and reads
      // `value_normalized` — never the worker's raw wording.
      ask_if: { op: "eq", left: { field: "machine_type" }, right: { const: "cnc_turning" } },
    });
    const occupation = pack("qp_machining", [machine, cncOnly, item({ question_key: "tools" })]);
    const packs: EnginePacks = { occupation, universal: UNIVERSAL };
    const items = [...occupation.items, ...UNIVERSAL.items];

    const before = state({ engineAsks: 1, askCounts: { machine_type: 1 }, turn: 3 });
    const predicted = computeLookahead({
      decision: ask("machine_type", machine.options),
      state: before,
      packs,
      items,
      nextTurn: 4,
    });
    expect(predicted).not.toBeNull();

    for (const opt of machine.options) {
      const real = actuallyServed(
        before,
        packs,
        recordAnswer(
          before.answers,
          {
            questionKey: "machine_type",
            targetField: machine.target_field,
            valueRaw: opt.label_text,
            valueNormalized: opt.value,
            evidence: null,
          },
          4,
        ),
        4,
      );
      expect(predicted?.[opt.option_key]?.questionKey).toBe(real.questionKey);
      expect(predicted?.[opt.option_key]?.promptText).toBe(real.promptText);
    }

    // And the branch actually differs, so the test above is not passing vacuously.
    expect(predicted?.cnc_turning?.questionKey).toBe("programming");
    expect(predicted?.lathe?.questionKey).toBe("tools");
  });

  it("matches the engine on the DECLINE branch too", () => {
    const machine = item({
      question_key: "machine_type",
      answer_type: "single_select",
      options: [option("lathe")],
    });
    const occupation = pack("qp_machining", [machine, item({ question_key: "tools" })]);
    const packs: EnginePacks = { occupation, universal: UNIVERSAL };
    const items = [...occupation.items, ...UNIVERSAL.items];
    const before = state({ engineAsks: 1, askCounts: { machine_type: 1 }, turn: 3 });

    const predicted = computeLookahead({
      decision: ask("machine_type", machine.options),
      state: before,
      packs,
      items,
      nextTurn: 4,
    });
    const real = actuallyServed(
      before,
      packs,
      recordDeclined(before.answers, "machine_type", 4),
      4,
    );
    expect(predicted?.[LOOKAHEAD_DECLINED]?.questionKey).toBe(real.questionKey);
  });

  it("predicts the CLOSE with the orchestrator's closing line, not an empty string", () => {
    // `nextQuestion` returns an empty `promptText` when it closes — the closing copy belongs to
    // the orchestrator. Forwarding that raw would have the client render a blank bubble on the
    // last tap of every completed interview.
    const only = item({
      question_key: "city",
      answer_type: "single_select",
      options: [option("pune")],
    });
    const packs: EnginePacks = { occupation: null, universal: pack("qp_universal", [only]) };
    const predicted = computeLookahead({
      decision: ask("city", only.options),
      state: state({ engineAsks: 1, askCounts: { city: 1 }, turn: 3 }),
      packs,
      items: [only],
      nextTurn: 4,
    });
    expect(predicted?.pune?.kind).toBe("close");
    expect(predicted?.pune?.questionKey).toBeNull();
    expect(predicted?.pune?.promptText).toBe(CLOSING_REPLY_TEXT);
  });
});

describe("what it refuses to predict", () => {
  const machine = item({
    question_key: "machine_type",
    answer_type: "single_select",
    options: [option("lathe")],
  });
  const packs: EnginePacks = {
    occupation: pack("qp_machining", [machine, item({ question_key: "tools" })]),
    universal: UNIVERSAL,
  };
  const items = [...(packs.occupation?.items ?? []), ...UNIVERSAL.items];
  const base = state({ engineAsks: 1, askCounts: { machine_type: 1 }, turn: 3 });

  it("says nothing on a close, a clarify or a disambiguation", () => {
    for (const kind of ["close", "clarify", "disambiguate"] as const) {
      const decision: Decision = { ...ask("machine_type", machine.options), kind };
      expect(
        computeLookahead({ decision, state: base, packs, items, nextTurn: 4 }),
      ).toBeNull();
    }
  });

  it("offers only DECLINE for a free-text question — the value cannot be known before it is typed", () => {
    // An `ask_if` reading that field would branch on a value we invented, so guessing one is the
    // one way this could hand a worker a confidently wrong question.
    const free = item({ question_key: "experience_years", answer_type: "text" });
    const textPacks: EnginePacks = {
      occupation: pack("qp_machining", [free, item({ question_key: "tools" })]),
      universal: UNIVERSAL,
    };
    const predicted = computeLookahead({
      decision: ask("experience_years"),
      state: state({ engineAsks: 1, askCounts: { experience_years: 1 }, turn: 3 }),
      packs: textPacks,
      items: [...(textPacks.occupation?.items ?? []), ...UNIVERSAL.items],
      nextTurn: 4,
    });
    expect(Object.keys(predicted ?? {})).toEqual([LOOKAHEAD_DECLINED]);
  });

  it("offers only DECLINE for a MULTI-select — one option is not the answer", () => {
    // A worker may tap two chips, and the resulting answer is not any single option's value. A
    // per-option prediction would be right most of the time and quietly wrong the rest, which is
    // the worst available behaviour for something rendered without a round trip.
    const multi = item({
      question_key: "machine_type",
      answer_type: "multi_select",
      options: [option("lathe"), option("vmc")],
    });
    const multiPacks: EnginePacks = {
      occupation: pack("qp_machining", [multi, item({ question_key: "tools" })]),
      universal: UNIVERSAL,
    };
    const predicted = computeLookahead({
      decision: ask("machine_type", multi.options),
      state: base,
      packs: multiPacks,
      items: [...(multiPacks.occupation?.items ?? []), ...UNIVERSAL.items],
      nextTurn: 4,
    });
    expect(Object.keys(predicted ?? {})).toEqual([LOOKAHEAD_DECLINED]);
  });

  it("caps the branches it will compute", () => {
    const many = item({
      question_key: "machine_type",
      answer_type: "single_select",
      options: Array.from({ length: LOOKAHEAD_MAX_BRANCHES + 4 }, (_, i) => option(`o${i}`)),
    });
    const manyPacks: EnginePacks = {
      occupation: pack("qp_machining", [many, item({ question_key: "tools" })]),
      universal: UNIVERSAL,
    };
    const predicted = computeLookahead({
      decision: ask("machine_type", many.options),
      state: base,
      packs: manyPacks,
      items: [...(manyPacks.occupation?.items ?? []), ...UNIVERSAL.items],
      nextTurn: 4,
    });
    // The cap governs OPTIONS; the decline branch rides on top of it.
    expect(Object.keys(predicted ?? {})).toHaveLength(LOOKAHEAD_MAX_BRANCHES + 1);
  });
});

describe("it cannot perturb the turn it runs beside", () => {
  it("mutates neither the state nor the answer map it was handed", () => {
    // A lookahead that corrupted engine state would be far worse than no lookahead. The recorders
    // and `nextQuestion` are all pure, and this is the assertion that keeps them that way.
    const machine = item({
      question_key: "machine_type",
      answer_type: "single_select",
      options: [option("lathe"), option("vmc")],
    });
    const packs: EnginePacks = {
      occupation: pack("qp_machining", [machine, item({ question_key: "tools" })]),
      universal: UNIVERSAL,
    };
    const before = state({
      engineAsks: 1,
      askCounts: { machine_type: 1 },
      turn: 3,
      answers: recordDeclined({} as AnswerMap, "prior", 1),
    });
    const snapshot = JSON.stringify(before);

    computeLookahead({
      decision: ask("machine_type", machine.options),
      state: before,
      packs,
      items: [...(packs.occupation?.items ?? []), ...UNIVERSAL.items],
      nextTurn: 4,
    });

    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("predicts against the POST-turn ask budget, not the pre-turn one", () => {
    // Handing the pre-turn state would predict against a budget one ask too generous, and the
    // divergence would appear only near the end of an interview — the hardest place to notice it.
    const machine = item({
      question_key: "machine_type",
      answer_type: "single_select",
      options: [option("lathe")],
    });
    const packs: EnginePacks = {
      occupation: pack("qp_machining", [machine, item({ question_key: "tools" })]),
      universal: UNIVERSAL,
    };
    const items = [...(packs.occupation?.items ?? []), ...UNIVERSAL.items];

    // One ask left in the budget: the next turn must CLOSE rather than serve `tools`.
    const atBudget = state({
      engineAsks: 24,
      askCounts: { machine_type: 1 },
      turn: 3,
    });
    const predicted = computeLookahead({
      decision: ask("machine_type", machine.options),
      state: atBudget,
      packs,
      items,
      nextTurn: 4,
    });
    const entry = predicted?.lathe as LookaheadEntry;
    expect(entry.kind).toBe("close");
  });
});
