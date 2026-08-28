import { describe, expect, it } from "vitest";

import type { QuestionPack, QuestionPackItem, QuestionPackOption } from "@badabhai/ai-contracts";

import { captureAnswer } from "./answer-capture";
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
  MAX_ENGINE_ASKS,
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
 * IT RUNS THE REAL CAPTURE PATH, and the first version of this file did not. It hand-folded
 * `recordAnswer(option.value)` — the identical fold the implementation used — so the two agreed by
 * construction and the suite could not detect a capture divergence of any kind. It passed green
 * against an implementation that mispredicted all three `qp_universal/relocation` chips, a question
 * every worker reaches.
 *
 * An oracle that mirrors the code it checks is not an oracle. This one starts from the worker's
 * TEXT and runs `captureAnswer`, exactly as `ProfilingOrchestrator.decide` does.
 */
function actuallyServed(
  before: EngineState,
  packs: EnginePacks,
  item: QuestionPackItem,
  text: string,
  nextTurn: number,
): Decision {
  const capture = captureAnswer(text, item);
  let answers: AnswerMap = before.answers;
  if (capture.declined) {
    answers = recordDeclined(answers, item.question_key, nextTurn);
  } else {
    for (const value of capture.values) answers = recordAnswer(answers, value, nextTurn);
  }
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
      const real = actuallyServed(before, packs, machine, opt.label_text, 4);
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
    const real = actuallyServed(before, packs, machine, "pata nahi", 4);
    expect(predicted?.[LOOKAHEAD_DECLINED]?.questionKey).toBe(real.questionKey);
  });

  it("predicts a RE-SERVE for a chip the capture path refuses — the shipped `relocation` case", () => {
    // THE DEFECT THIS SUITE ORIGINALLY SHIPPED. `captureAnswer` classifies before it normalizes, so
    // a chip whose label the item's normalizer refuses yields NO value, the question stays
    // unsettled, and the engine asks it AGAIN. Measured on the corpus: 5 of 453 single-select chips
    // behave this way, three of them on `qp_universal/relocation` — a question every worker reaches.
    //
    // The first implementation hand-folded `recordAnswer(option.value)` and predicted "next
    // question" for all three. The fix is to run the real capture; this test is what holds it.
    const relocation = item({
      question_key: "relocation",
      answer_type: "single_select",
      target_field: "relocation_willingness",
      options: [option("yes", { label_text: "Haan, jaa sakta hoon", value: true })],
    });
    const packs: EnginePacks = {
      occupation: null,
      universal: pack("qp_universal", [relocation, item({ question_key: "city" })]),
    };
    const items = [relocation, ...packs.universal.items.slice(1)];
    const before = state({ engineAsks: 1, askCounts: { relocation: 1 }, turn: 3 });

    const predicted = computeLookahead({
      decision: ask("relocation", relocation.options),
      state: before,
      packs,
      items,
      nextTurn: 4,
    });
    const real = actuallyServed(before, packs, relocation, "Haan, jaa sakta hoon", 4);

    // Whatever the engine does — re-serve or advance — the prediction must agree with it.
    expect(predicted?.yes?.questionKey).toBe(real.questionKey);
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
      expect(computeLookahead({ decision, state: base, packs, items, nextTurn: 4 })).toBeNull();
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

  it("DECLINES a question with too many options rather than truncating it", () => {
    // Slicing to the cap was the first implementation and it is the wrong one: options are
    // authored in display order and `is_none_of_above` — the "kuch aur" escape — goes last, so a
    // truncation drops precisely the chip whose prediction is most worth having, silently. An
    // absent entry is the round trip the client already handles.
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
    // Only the decline branch survives — no per-option prediction at all.
    expect(Object.keys(predicted ?? {})).toEqual([LOOKAHEAD_DECLINED]);
  });

  it("still predicts a question sitting exactly ON the cap", () => {
    // The threshold is inclusive, so the common four- and five-chip questions are unaffected.
    const atCap = item({
      question_key: "machine_type",
      answer_type: "single_select",
      options: Array.from({ length: LOOKAHEAD_MAX_BRANCHES }, (_, i) => option(`o${i}`)),
    });
    const capPacks: EnginePacks = {
      occupation: pack("qp_machining", [atCap, item({ question_key: "tools" })]),
      universal: UNIVERSAL,
    };
    const predicted = computeLookahead({
      decision: ask("machine_type", atCap.options),
      state: base,
      packs: capPacks,
      items: [...(capPacks.occupation?.items ?? []), ...UNIVERSAL.items],
      nextTurn: 4,
    });
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
    //
    // DERIVED FROM THE CONSTANT, never restated. This was the literal `24` and went red the day
    // R6 §5 lifted the cap — a test about the RELATIONSHIP between the lookahead and the budget
    // failing because the budget's value changed, which is the coupling `MAX_ENGINE_ASKS`'s own
    // docstring says the suite must not have.
    const atBudget = state({
      engineAsks: MAX_ENGINE_ASKS,
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

/**
 * #766 item 4 — every entry says which turn it was computed FOR.
 *
 * The point is detectability, not decoration. A re-pin between turns invalidates every prediction,
 * and the advisory contract only bounds that AFTER the real response arrives. On chat that is a
 * repaint; on the voice form the client pre-resolves a `tts_clip_id`, so a stale prediction is
 * SPOKEN to a worker who cannot read the screen to catch it. The stamp is what lets a client
 * compare and drop instead of trusting until contradicted.
 */
describe("the turn stamp (#766 item 4)", () => {
  const machine = item({
    question_key: "machine_type",
    answer_type: "single_select",
    options: [option("lathe"), option("cnc_turning")],
  });
  const packs: EnginePacks = {
    occupation: pack("qp_machining", [machine, item({ question_key: "tools" })]),
    universal: UNIVERSAL,
  };
  const items = [...(packs.occupation?.items ?? []), ...UNIVERSAL.items];

  it("stamps EVERY entry — the option branches and the decline — with `nextTurn`", () => {
    const predicted = computeLookahead({
      decision: ask("machine_type", machine.options),
      state: state({ engineAsks: 1, askCounts: { machine_type: 1 }, turn: 3 }),
      packs,
      items,
      nextTurn: 4,
    });

    const entries = Object.entries(predicted ?? {});
    // Vacuity guard: an empty map would satisfy the `every` below without asserting anything.
    expect(entries.length).toBeGreaterThan(1);
    expect(entries.map(([key]) => key)).toContain(LOOKAHEAD_DECLINED);
    for (const [key, entry] of entries) {
      expect(entry.turn, `entry ${key} carries the wrong turn`).toBe(4);
    }
  });

  it("tracks `nextTurn` rather than hard-coding it", () => {
    // The stamp is only useful if it MOVES with the turn — a constant would compare equal
    // forever and silently disable the client's staleness check.
    for (const nextTurn of [2, 7, 41]) {
      const predicted = computeLookahead({
        decision: ask("machine_type", machine.options),
        state: state({ engineAsks: 1, askCounts: { machine_type: 1 }, turn: nextTurn - 1 }),
        packs,
        items,
        nextTurn,
      });
      for (const entry of Object.values(predicted ?? {})) expect(entry.turn).toBe(nextTurn);
    }
  });
});
