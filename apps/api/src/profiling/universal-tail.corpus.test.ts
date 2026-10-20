import { describe, expect, it } from "vitest";
import type { OccupationPin, QuestionPack, QuestionPackItem } from "@badabhai/ai-contracts";

import { recordAnswer, recordDeclined, toAnswerMap, type AnswerMap } from "./answer-map";
import { universalPack } from "./corpus-packs.fixture";
import { emptyProfilingEnvelope, toEngineState, withAnswers } from "./conversation-state";
import { chatServableItems } from "./facts/worker-fact.ownership";
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
 *
 * ROUND 4 (#1505): THE OWNER'S 2026-08-11 SIX-QUESTION RULING IS SUPERSEDED, IN THE CHAT ONLY.
 * `salary_expected`, `preferred_locations`, `education` and `shift_preference` are now asked by
 * the pages that own them (résumé/preferences/qualifications), never by the chat — the same #1503
 * fix the trade form got, one layer up. The TAIL a chat session actually serves is walked through
 * `chatServableItems` (`facts/worker-fact.ownership.ts`), the exact filter `selectableEnginePacks`
 * (`orchestrator.service.ts`) applies before either of its own branches run. The v1-starvation and
 * relocation tests below stay on the RAW, unfiltered pack deliberately — they are pinning a
 * property of the corpus DATA (a mandatory item's `max_turn`, a retired item's presence in v1
 * only), not of what the chat currently chooses to ask, and filtering them would test the wrong
 * thing.
 */

/** Answer whatever the engine serves, in order, and report what it asked. */
function walk(
  pack: QuestionPack,
  startTurn: number,
  settled: Record<string, unknown>,
  declined: readonly string[] = [],
  occupation: OccupationPin | null = null,
): string[] {
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
  // A DECLINE IS A COMPLETE ANSWER — the same record the orchestrator writes on "nahi pata".
  for (const key of declined) answers = recordDeclined(answers, key, 1);

  let envelope = withAnswers({ ...emptyProfilingEnvelope(), occupation }, answers);
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

/** The pack the CHAT actually serves — `qp_universal@2`'s items, through the ownership filter. */
function chatUniversal(version: number): QuestionPack {
  const pack = universalPack(version);
  return { ...pack, items: chatServableItems(pack.items) };
}

/** #1505: pages own salary/preferred_locations/education/shift — the chat asks neither any more. */
const TAIL = ["current_city", "availability"];

describe("the template tail, over the REAL corpus", () => {
  it("asks the TWO the chat still owns, once Phase A has handed over (#1505 supersedes the SIX)", () => {
    expect(walk(chatUniversal(2), 8, AFTER_PHASE_A)).toEqual(TAIL);
  });

  it("asks the same two whether the tail is reached early or late", () => {
    // The turn number a tail is entered on depends on how long Phase A ran, how many silences the
    // worker had, and how many times they asked "why". None of that may change the question set.
    for (const startTurn of [4, 6, 8, 12]) {
      expect(
        walk(chatUniversal(2), startTurn, AFTER_PHASE_A),
        `entered at turn ${startTurn}`,
      ).toEqual(TAIL);
    }
  });

  it("still asks the trade and the experience when the model never ran", () => {
    // The fallback path: nothing pre-settled, so the pack asks its own two as well. `current_city`
    // lands second rather than third because it is the only MANDATORY item besides the trade, and
    // `min_turn: 2` is what holds it off turn one. Pages-owned items never appear here either.
    expect(walk(chatUniversal(2), 1, {})).toEqual([
      "primary_trade",
      "current_city",
      "experience_years",
      "availability",
    ]);
  });

  it("v1 STARVED the mandatory city question on a late tail — the defect v2 exists to fix", () => {
    // RAW, UNFILTERED PACKS — this pins a property of the CORPUS DATA (a mandatory item's
    // `max_turn`), not of what the chat currently chooses to ask; filtering would test the wrong
    // thing. Pinned as a regression rather than described in a comment. `current_city` is
    // mandatory and carried `max_turn: 5`, so a tail entered at turn 8 closed `complete` having
    // never asked a worker where they live. v1 is frozen and keeps the defect; v2 must not have it.
    const late = walk(universalPack(1), 8, {});
    expect(late).not.toContain("current_city");
    expect(late).not.toContain("salary_expected");

    expect(walk(universalPack(2), 8, {})).toContain("current_city");
    expect(walk(universalPack(2), 8, {})).toContain("salary_expected");
  });

  it("drops `relocation`, which `preferred_locations` subsumes", () => {
    // RAW, UNFILTERED PACKS — a retired item's presence in v1 only is a corpus-DATA fact, not a
    // chat-ownership one.
    expect(walk(universalPack(2), 1, {})).not.toContain("relocation");
    // v1 keeps it — a published version's question set is frozen for the sessions pinned to it.
    expect(walk(universalPack(1), 1, {})).toContain("relocation");
  });
});

/**
 * FILL-GAP PHASE 1 (ADR-0042 D9 amendment): `languages` and `work_types` join the tail.
 *
 * The TWO questions above are history — v2 sessions stay pinned to v2, and nothing here may
 * rewrite them. What v3 adds is a longer tail: the language LIST and the work-type multi, both
 * ATTRIBUTE multis whose chips carry the same slug vocabularies the pages write, so the chat
 * answer lands in `worker_attributes` through the existing projector. They are ungated
 * (no min_turn) and they sit at the END of the raw pack, so they run AFTER availability —
 * the explicit ordering this walk pins.
 */
describe("the fill-gap tail, over the REAL corpus (qp_universal@3)", () => {
  const V3_TAIL = ["current_city", "availability", "languages", "work_types"];

  it("asks FOUR once Phase A has handed over — the two new ones run after availability", () => {
    expect(walk(chatUniversal(3), 8, AFTER_PHASE_A)).toEqual(V3_TAIL);
  });

  it("asks the same four whether the tail is reached early or late", () => {
    for (const startTurn of [4, 6, 8, 12]) {
      expect(
        walk(chatUniversal(3), startTurn, AFTER_PHASE_A),
        `entered at turn ${startTurn}`,
      ).toEqual(V3_TAIL);
    }
  });

  it("still drops the four pages-owned settlers — v3 flips languages/work_types and nothing else", () => {
    const asked = walk(chatUniversal(3), 1, {});
    for (const pagesOwned of [
      "salary_expected",
      "preferred_locations",
      "education",
      "shift_preference",
    ]) {
      expect(asked, `${pagesOwned} must never serve through the chat`).not.toContain(pagesOwned);
    }
  });

  it("serves the two new questions on the model-less fallback path too", () => {
    // Nothing pre-settled: the pack asks its own core pair first, then the city, the experience,
    // availability, and finally the two new multis — RAW authoring order, no special casing.
    expect(walk(chatUniversal(3), 1, {})).toEqual([
      "primary_trade",
      "current_city",
      "experience_years",
      "availability",
      "languages",
      "work_types",
    ]);
  });
});

/**
 * LAYER A ELICITATION (ADR-0042 §9 amendment, 2026-09-18): eight more asks join the tail.
 *
 * `commute_max_km`, `willing_to_travel`, `notice_period_days`, `salary_period`, the training trio
 * and `secondary_occupations` are appended after `work_types` in RAW authoring order. The two
 * gated training items fire because this walk answers everything it is served; the decline case
 * below pins the gate's other half. v2/v3 sessions stay pinned to their own files and nothing
 * above moves — this describe only ADDS the active version's walk.
 */
describe("the Layer A tail, over the REAL corpus (qp_universal@4)", () => {
  const V4_TAIL = [
    "current_city",
    "availability",
    "languages",
    "work_types",
    "commute_max_km",
    "willing_to_travel",
    "notice_period_days",
    "salary_period",
    "training_name",
    "training_provider",
    "training_year",
    "secondary_occupations",
  ];

  it("asks TWELVE once Phase A has handed over — the eight new asks run after work_types", () => {
    expect(walk(chatUniversal(4), 8, AFTER_PHASE_A)).toEqual(V4_TAIL);
  });

  it("asks the same twelve whether the tail is reached early or late", () => {
    for (const startTurn of [4, 6, 8, 12]) {
      expect(
        walk(chatUniversal(4), startTurn, AFTER_PHASE_A),
        `entered at turn ${startTurn}`,
      ).toEqual(V4_TAIL);
    }
  });

  it("skips the whole training trio when the name was DECLINED — terminal, never re-asked", () => {
    // `ask_if: answered(training_name)` reads the same answer map the engine records a decline
    // into, and a decline is terminal: a worker with no course answers "nahi pata" ONCE and the
    // interview moves on. The declined-terminal rule is untouched — the question is skipped
    // because it is already settled, not because the gate guessed.
    const asked = walk(chatUniversal(4), 1, {}, ["training_name"]);
    for (const training of ["training_name", "training_provider", "training_year"]) {
      expect(asked, `${training} must not be served after its decline`).not.toContain(training);
    }
    // The rest of the tail still runs after it.
    expect(asked).toContain("secondary_occupations");
  });

  it("still drops the four pages-owned settlers — v4 flips the three extension facts and nothing else", () => {
    const asked = walk(chatUniversal(4), 1, {});
    for (const pagesOwned of [
      "salary_expected",
      "preferred_locations",
      "education",
      "shift_preference",
    ]) {
      expect(asked, `${pagesOwned} must never serve through the chat`).not.toContain(pagesOwned);
    }
  });

  it("serves all eight new asks on the model-less fallback path too", () => {
    expect(walk(chatUniversal(4), 1, {})).toEqual([
      "primary_trade",
      "current_city",
      "experience_years",
      "availability",
      "languages",
      "work_types",
      ...V4_TAIL.slice(4),
    ]);
  });
});

/**
 * THE TRAINING GATE (qp_universal@5, owner rulings 2026-10-17): one Haan/Nahi question opens the
 * trio, and it is asked only for the sixteen form families' occupations. An unpinned session and a
 * non-industrial pin both skip the gate AND the trio — `ask_if`'s fail direction IS the ruling.
 * v4 sessions keep the ungated trio; nothing above moves.
 */
describe("the training gate, over the REAL corpus (qp_universal@5)", () => {
  const V5_TAIL = [
    "current_city",
    "availability",
    "languages",
    "work_types",
    "commute_max_km",
    "willing_to_travel",
    "notice_period_days",
    "salary_period",
    "training_done",
    "training_name",
    "training_provider",
    "training_year",
    "secondary_occupations",
  ];

  /** A valid pin for one job domain — the engine reads it off `EngineState.occupation`. */
  function pin(jobDomainId: string): OccupationPin {
    return {
      job_domain_id: jobDomainId,
      label: "CNC turner",
      isco_unit_code: "7223",
      match_status: "matched_lexical",
      match_score: 1,
      match_layer: null,
      pack_id: null,
      pack_version: null,
      catalog_version: null,
    };
  }

  const INDUSTRIAL_PIN = pin("jd_nco_7223_6001"); // fam_cnc_turning
  const NON_INDUSTRIAL_PIN = pin("jd_nco_5120_0100"); // cooks — not in the 70
  const GATE_TRUE = { ...AFTER_PHASE_A, training_done: true };
  const GATE_FALSE = { ...AFTER_PHASE_A, training_done: false };

  /** The tail as served once the gate is already TRUE: every V5 item except the gate itself. */
  const V5_TAIL_GATE_SETTLED = V5_TAIL.filter((key) => key !== "training_done");

  it("an industrial pin with the gate TRUE serves the whole trio — the gate itself is already settled", () => {
    expect(walk(chatUniversal(5), 8, GATE_TRUE, [], INDUSTRIAL_PIN)).toEqual(V5_TAIL_GATE_SETTLED);
  });

  it("the gate answered FALSE ends the trio — the rest of the tail still runs", () => {
    const asked = walk(chatUniversal(5), 8, GATE_FALSE, [], INDUSTRIAL_PIN);
    for (const training of ["training_name", "training_provider", "training_year"]) {
      expect(asked, `${training} must not be served after Nahi`).not.toContain(training);
    }
    expect(asked).toContain("secondary_occupations");
  });

  it("NEVER asks gate or trio without an occupation pin — the fail-closed ruling", () => {
    const asked = walk(chatUniversal(5), 8, AFTER_PHASE_A, [], null);
    for (const training of [
      "training_done",
      "training_name",
      "training_provider",
      "training_year",
    ]) {
      expect(asked, `${training} must not be served unpinned`).not.toContain(training);
    }
    expect(asked).toContain("secondary_occupations");
  });

  it("NEVER asks them for a NON-INDUSTRIAL pin — a different background skips the trio", () => {
    const asked = walk(chatUniversal(5), 8, AFTER_PHASE_A, [], NON_INDUSTRIAL_PIN);
    for (const training of [
      "training_done",
      "training_name",
      "training_provider",
      "training_year",
    ]) {
      expect(asked, `${training} must not be served to a non-industrial worker`).not.toContain(
        training,
      );
    }
    expect(asked).toContain("secondary_occupations");
  });

  it("serves the gate itself when the pin is industrial and the gate is unanswered — the trio stays away", () => {
    const asked = walk(chatUniversal(5), 1, {}, [], INDUSTRIAL_PIN);
    expect(asked).toContain("training_done");
    expect(asked).not.toContain("training_name");
  });

  it("a DECLINED provider exits the rest of the trio — the year is skipped too", () => {
    const asked = walk(
      chatUniversal(5),
      8,
      { ...AFTER_PHASE_A, training_done: true, training_name: "ITI" },
      ["training_provider"],
      INDUSTRIAL_PIN,
    );
    expect(asked).not.toContain("training_provider");
    expect(asked).not.toContain("training_year");
    expect(asked).toContain("secondary_occupations");
  });

  it("v4 sessions keep the UNGATED trio — a frozen version is not retold", () => {
    const asked = walk(chatUniversal(4), 8, AFTER_PHASE_A);
    expect(asked).toContain("training_name");
    expect(asked).not.toContain("training_done");
  });
});

/**
 * TRAVEL FIRST, KM ONLY ON HAAN (qp_universal@6, owner ruling 2026-10-19). v5 asked the km
 * number BEFORE the Haan/Nahi travel gate, so a worker answering Nahi, "pata nahi", declining
 * or skipping still paid for the km question. v6 moves `willing_to_travel` IMMEDIATELY BEFORE
 * `commute_max_km` and gates the km on the gate's TRUE answer — the same `eq` shape the
 * training trio's name already uses on its gate. Haan and "haan ji" read as TRUE in
 * `packages/profiling-lexicon/src/values/affirmation.test.ts`; this block pins the DATA half:
 * what a TRUE / FALSE / declined / unanswered gate serves. v5 sessions keep the old order;
 * nothing above moves.
 */
describe("travel first, km only on Haan, over the REAL corpus (qp_universal@6)", () => {
  const TRAVEL_TRUE = { ...AFTER_PHASE_A, willing_to_travel: true };
  const TRAVEL_FALSE = { ...AFTER_PHASE_A, willing_to_travel: false };

  /** The tail once the gate is already TRUE: the km in the gate's slot, the gate settled. */
  const V6_TAIL_GATE_SETTLED = [
    "current_city",
    "availability",
    "languages",
    "work_types",
    "commute_max_km",
    "notice_period_days",
    "salary_period",
    "secondary_occupations",
  ];

  it("serves willing_to_travel IMMEDIATELY BEFORE commute_max_km — the reorder itself", () => {
    const items = chatUniversal(6).items;
    const keys = items.map((i) => i.question_key);
    const travel = keys.indexOf("willing_to_travel");
    const km = keys.indexOf("commute_max_km");
    expect(travel).toBeGreaterThanOrEqual(0);
    expect(km).toBe(travel + 1);
    expect(items[km]?.ask_if).toEqual({
      op: "eq",
      left: { field: "willing_to_travel" },
      right: { const: true },
    });
  });

  it("Haan on the gate serves the km next — directly after work_types", () => {
    expect(walk(chatUniversal(6), 8, TRAVEL_TRUE)).toEqual(V6_TAIL_GATE_SETTLED);
  });

  it("Nahi on the gate never serves the km — notice_period_days follows work_types", () => {
    const asked = walk(chatUniversal(6), 8, TRAVEL_FALSE);
    expect(asked).not.toContain("willing_to_travel");
    expect(asked).not.toContain("commute_max_km");
    expect(asked.indexOf("notice_period_days")).toBe(asked.indexOf("work_types") + 1);
    expect(asked).toContain("secondary_occupations");
  });

  it("a DECLINED gate never serves the km either — 'pata nahi' is terminal for the pair", () => {
    const asked = walk(chatUniversal(6), 8, AFTER_PHASE_A, ["willing_to_travel"]);
    expect(asked).not.toContain("commute_max_km");
    expect(asked.indexOf("notice_period_days")).toBe(asked.indexOf("work_types") + 1);
  });

  it("an UNANSWERED gate serves the gate but never the km — a skip pays nothing", () => {
    // Nothing pre-settled: the engine serves the gate, this walk answers it with a value no
    // boolean parser would produce, and the gate's fail direction (unevaluatable → false) skips
    // the km. "pata nahi" in production records a decline (covered above); this pins the third
    // case, the worker who never answers at all.
    const asked = walk(chatUniversal(6), 8, AFTER_PHASE_A);
    expect(asked).toContain("willing_to_travel");
    expect(asked).not.toContain("commute_max_km");
    expect(asked.indexOf("notice_period_days")).toBe(asked.indexOf("willing_to_travel") + 1);
  });

  it("v5 sessions keep the OLD order — a frozen version is not retold", () => {
    const items = chatUniversal(5).items;
    const keys = items.map((i) => i.question_key);
    expect(keys.indexOf("commute_max_km")).toBeLessThan(keys.indexOf("willing_to_travel"));
    expect(items[keys.indexOf("commute_max_km")]?.ask_if).toBeNull();
  });
});

/**
 * SECONDARY OCCUPATIONS OUT OF THE CHAT (qp_universal@7, owner ruling 2026-10-20). The
 * 13-option `secondary_occupations` multi at the end of the tail read as a second trade
 * interrogation after the profile was complete, so v7 removes that ONE item and nothing else:
 * every other v6 item is byte-identical and v6 is deprecated in place. Pinned v6 sessions keep
 * resolving through `loadPinned` (and their answers still land through the untouched
 * `worker_occupation` write leg); the occupations page remains the capture surface.
 */
describe("no end-of-interview trade list, over the REAL corpus (qp_universal@7)", () => {
  const TRAVEL_TRUE = { ...AFTER_PHASE_A, willing_to_travel: true };
  const TRAVEL_FALSE = { ...AFTER_PHASE_A, willing_to_travel: false };

  it("never serves secondary_occupations once Phase A has handed over", () => {
    expect(walk(chatUniversal(7), 8, TRAVEL_TRUE)).not.toContain("secondary_occupations");
    expect(walk(chatUniversal(7), 8, TRAVEL_FALSE)).not.toContain("secondary_occupations");
    expect(walk(chatUniversal(7), 8, AFTER_PHASE_A)).not.toContain("secondary_occupations");
  });

  it("serves the v6 tail minus that one item — Haan on the travel gate", () => {
    expect(walk(chatUniversal(7), 8, TRAVEL_TRUE)).toEqual([
      "current_city",
      "availability",
      "languages",
      "work_types",
      "commute_max_km",
      "notice_period_days",
      "salary_period",
    ]);
  });

  it("Nahi on the travel gate still skips the km — notice_period_days follows work_types", () => {
    const asked = walk(chatUniversal(7), 8, TRAVEL_FALSE);
    expect(asked).not.toContain("willing_to_travel");
    expect(asked).not.toContain("commute_max_km");
    expect(asked.indexOf("notice_period_days")).toBe(asked.indexOf("work_types") + 1);
  });

  it("never serves it on the model-less fallback path either", () => {
    const asked = walk(chatUniversal(7), 1, {});
    expect(asked).toContain("primary_trade");
    expect(asked).not.toContain("secondary_occupations");
  });

  it("v6 sessions keep the trade list — a frozen version is not retold", () => {
    expect(walk(chatUniversal(6), 8, TRAVEL_TRUE)).toContain("secondary_occupations");
  });
});
