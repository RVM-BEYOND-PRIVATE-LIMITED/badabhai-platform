import { describe, it, expect } from "vitest";
import type { QuestionPackItem } from "@badabhai/ai-contracts";
import { askCeiling, MAX_ASKS_PER_QUESTION } from "../profiling/next-question";
import { isSettled, type AnswerMap } from "../profiling/answer-map";
import {
  askCeilingOf,
  deriveStuckQuestion,
  type StuckQuestionInput,
  type StuckQuestionItem,
} from "./admin-worker-journey.stuck";

/**
 * The stuck-question derivation — "which question was the engine serving when this session
 * ended", reconstructed from `ask_counts` + the answer map + the durable answer rows.
 *
 * Every case below is a SHAPE the live interview actually produces, not a synthetic one:
 * a clean completion, an abandonment mid-question, a question that burned its `max_asks` and
 * was skipped, and the multi-candidate case that the tie-break exists for.
 */

const OCCUPATION_PACK = "qp_welding";
const UNIVERSAL_PACK = "qp_universal";

function item(
  questionKey: string,
  overrides: Partial<StuckQuestionItem> = {},
): StuckQuestionItem {
  return {
    questionKey,
    packId: OCCUPATION_PACK,
    packVersion: 1,
    displayOrder: 0,
    maxAsks: 2,
    ...overrides,
  };
}

function input(overrides: Partial<StuckQuestionInput> = {}): StuckQuestionInput {
  return {
    askCounts: {},
    settledKeys: [],
    answerMapStatuses: {},
    items: [],
    pinnedPackId: OCCUPATION_PACK,
    hasConversationState: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The ceiling mirror — the ONE place this module could silently drift from the engine.
// ---------------------------------------------------------------------------

describe("askCeilingOf mirrors the engine's askCeiling (no second definition of the bound)", () => {
  it("agrees with `askCeiling` for every legal max_asks, and for the out-of-range ones", () => {
    // `qpi_max_asks_chk` permits 1..3; -1/0/9 are what a drifted row or an older build could
    // still put in front of this, and the two implementations must agree there too.
    for (const maxAsks of [-1, 0, 1, 2, 3, 9]) {
      const engine = askCeiling({ max_asks: maxAsks } as QuestionPackItem);
      expect(askCeilingOf(maxAsks), `max_asks=${maxAsks}`).toBe(engine);
    }
  });

  it("an UNRESOLVABLE item falls back to the engine ceiling (errs toward 'still on screen')", () => {
    // A retired pack version leaves an answer key with no item. Falling back to the ceiling
    // makes a once-asked question NOT exhausted, i.e. a live candidate — which can name a
    // question that had actually been skipped, but can never HIDE the one on screen.
    expect(askCeilingOf(null)).toBe(MAX_ASKS_PER_QUESTION);
  });
});

describe("'settled' means exactly what the engine's isSettled means", () => {
  it("answered and declined are settled; unanswered and absent are not", () => {
    // Pinned against the engine's own predicate rather than restated, because the derivation's
    // whole first step is "which asked keys did NOT settle". If the two definitions drifted,
    // a declined question ("nahi pata" — a COMPLETE answer) would be reported as the place a
    // worker got stuck.
    const map = {
      a: { question_key: "a", status: "answered" },
      d: { question_key: "d", status: "declined" },
      u: { question_key: "u", status: "unanswered" },
    } as unknown as AnswerMap;
    expect(isSettled(map, "a")).toBe(true);
    expect(isSettled(map, "d")).toBe(true);
    expect(isSettled(map, "u")).toBe(false);
    expect(isSettled(map, "never_asked")).toBe(false);

    // ...and this module treats the same four the same way.
    const result = deriveStuckQuestion(
      input({
        askCounts: { a: 1, d: 1, u: 1 },
        answerMapStatuses: { a: "answered", d: "declined", u: "unanswered" },
        items: [item("a"), item("d"), item("u")],
      }),
    );
    expect(result.settled_count).toBe(2);
    expect(result.candidates.map((c) => c.question_key)).toEqual(["u"]);
  });
});

// ---------------------------------------------------------------------------
// Case 1 — a clean completion has NO stuck question.
// ---------------------------------------------------------------------------

describe("a clean completion", () => {
  it("reports all_settled with no stuck question", () => {
    const result = deriveStuckQuestion(
      input({
        askCounts: { trade_years: 1, current_city: 1, salary_expected: 1 },
        settledKeys: ["trade_years", "current_city", "salary_expected"],
        answerMapStatuses: {
          trade_years: "answered",
          current_city: "answered",
          salary_expected: "declined",
        },
        items: [item("trade_years"), item("current_city"), item("salary_expected")],
      }),
    );

    expect(result.outcome).toBe("all_settled");
    expect(result.stuck_question).toBeNull();
    expect(result.candidates).toEqual([]);
    expect(result.asked_count).toBe(3);
    expect(result.settled_count).toBe(3);
  });

  it("a DECLINED answer is a completion, not a stall (the 'nahi pata' path)", () => {
    const result = deriveStuckQuestion(
      input({
        askCounts: { salary_expected: 2 },
        settledKeys: ["salary_expected"],
        answerMapStatuses: { salary_expected: "declined" },
        items: [item("salary_expected")],
      }),
    );
    expect(result.outcome).toBe("all_settled");
    expect(result.stuck_question).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Case 2 — abandonment mid-question.
// ---------------------------------------------------------------------------

describe("an abandonment mid-question", () => {
  it("names the question that was on screen — asked, unsettled, and NOT advanced past", () => {
    // The live shape: two questions answered, the third served and then the worker walked
    // away. Nothing advanced past it, so it carries no `unanswered` record.
    const result = deriveStuckQuestion(
      input({
        askCounts: { trade_years: 1, workplace_type: 1, salary_expected: 1 },
        settledKeys: ["trade_years", "workplace_type"],
        answerMapStatuses: { trade_years: "answered", workplace_type: "answered" },
        items: [
          item("trade_years", { displayOrder: 0 }),
          item("workplace_type", { displayOrder: 1 }),
          item("salary_expected", { displayOrder: 2 }),
        ],
      }),
    );

    expect(result.outcome).toBe("resolved");
    expect(result.stuck_question?.question_key).toBe("salary_expected");
    expect(result.stuck_question?.asks).toBe(1);
    expect(result.stuck_question?.ask_ceiling).toBe(2);
    expect(result.stuck_question?.exhausted).toBe(false);
    expect(result.stuck_question?.engine_advanced_past).toBe(false);
    expect(result.asked_count).toBe(3);
    expect(result.settled_count).toBe(2);
  });

  it("reports progress as asked vs settled, so 'how far did they get' is answerable", () => {
    const result = deriveStuckQuestion(
      input({
        askCounts: { q1: 1, q2: 1, q3: 1, q4: 1 },
        settledKeys: ["q1", "q2", "q3"],
        answerMapStatuses: { q1: "answered", q2: "answered", q3: "answered" },
        items: [item("q1"), item("q2"), item("q3"), item("q4")],
      }),
    );
    expect(result.asked_count).toBe(4);
    expect(result.settled_count).toBe(3);
    expect(result.stuck_question?.question_key).toBe("q4");
  });
});

// ---------------------------------------------------------------------------
// Case 3 — a question that exhausted max_asks and was skipped.
// ---------------------------------------------------------------------------

describe("a question that burned its ask budget and was skipped", () => {
  it("is NOT named as the stuck question when another candidate is still servable", () => {
    // `machine_types` was asked twice (its ceiling), the engine gave up and recorded
    // `unanswered`, and moved on to `salary_expected`, which is where the session died. The
    // exhausted one has the HIGHER ask pressure (2/2 vs 1/2) — so a ranking that led with
    // pressure would name the wrong question. It leads with the two disqualifiers instead.
    const result = deriveStuckQuestion(
      input({
        askCounts: { machine_types: 2, salary_expected: 1 },
        settledKeys: [],
        answerMapStatuses: { machine_types: "unanswered" },
        items: [
          item("machine_types", { displayOrder: 3, maxAsks: 2 }),
          item("salary_expected", { displayOrder: 9, maxAsks: 2 }),
        ],
      }),
    );

    expect(result.stuck_question?.question_key).toBe("salary_expected");
    // ...and the skipped one is still REPORTED, ranked second, flagged for what it is.
    expect(result.candidates.map((c) => c.question_key)).toEqual([
      "salary_expected",
      "machine_types",
    ]);
    const skipped = result.candidates[1]!;
    expect(skipped.exhausted).toBe(true);
    expect(skipped.engine_advanced_past).toBe(true);
    expect(skipped.asks).toBe(2);
    expect(skipped.ask_ceiling).toBe(2);
  });

  it("IS named when it is the only unsettled key (the interview ended right after it)", () => {
    const result = deriveStuckQuestion(
      input({
        askCounts: { machine_types: 2, trade_years: 1 },
        settledKeys: ["trade_years"],
        answerMapStatuses: { trade_years: "answered", machine_types: "unanswered" },
        items: [item("machine_types", { maxAsks: 2 }), item("trade_years")],
      }),
    );
    expect(result.outcome).toBe("resolved");
    expect(result.stuck_question?.question_key).toBe("machine_types");
    expect(result.stuck_question?.exhausted).toBe(true);
  });

  it("respects an item's OWN max_asks of 1 (ask-once questions exhaust at one ask)", () => {
    const result = deriveStuckQuestion(
      input({
        askCounts: { one_shot: 1, two_shot: 1 },
        items: [
          item("one_shot", { maxAsks: 1, displayOrder: 0 }),
          item("two_shot", { maxAsks: 2, displayOrder: 1 }),
        ],
      }),
    );
    expect(result.candidates[0]!.question_key).toBe("two_shot");
    expect(result.candidates[0]!.exhausted).toBe(false);
    expect(result.candidates[1]!.question_key).toBe("one_shot");
    expect(result.candidates[1]!.exhausted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Case 4 — multiple unsettled keys: the tie-break, leg by leg.
// ---------------------------------------------------------------------------

describe("multiple unsettled keys — the documented tie-break, one leg at a time", () => {
  it("leg 1: NOT engine-advanced-past beats engine-advanced-past", () => {
    const result = deriveStuckQuestion(
      input({
        askCounts: { moved_on: 1, on_screen: 1 },
        // Identical in every other respect — same asks, same ceiling, same display order —
        // so ONLY leg 1 can decide this.
        answerMapStatuses: { moved_on: "unanswered" },
        items: [
          item("moved_on", { displayOrder: 5 }),
          item("on_screen", { displayOrder: 5 }),
        ],
      }),
    );
    expect(result.stuck_question?.question_key).toBe("on_screen");
  });

  it("leg 2: NOT exhausted beats exhausted, when no answer map is available to decide", () => {
    // A session whose checkpoint predates the answer map (or lost it) still has ask_counts.
    const result = deriveStuckQuestion(
      input({
        askCounts: { burned: 2, live: 1 },
        answerMapStatuses: {},
        items: [item("burned", { displayOrder: 9 }), item("live", { displayOrder: 0 })],
      }),
    );
    // `burned` has the later display order AND the higher pressure; leg 2 outranks both.
    expect(result.stuck_question?.question_key).toBe("live");
  });

  it("a pack `max_asks` of 3 is CAPPED at the engine ceiling of 2 — the ceiling is the engine's", () => {
    // The corpus check permits `max_asks` up to 3, and `askCeiling` clamps to
    // MAX_ASKS_PER_QUESTION regardless. So a pack cannot buy a third ask, and a question
    // asked twice under `max_asks: 3` is EXHAUSTED here exactly as it is in the engine.
    const result = deriveStuckQuestion(
      input({
        askCounts: { greedy: 2 },
        items: [item("greedy", { maxAsks: 3 })],
      }),
    );
    expect(result.candidates[0]!.max_asks).toBe(3);
    expect(result.candidates[0]!.ask_ceiling).toBe(MAX_ASKS_PER_QUESTION);
    expect(result.candidates[0]!.exhausted).toBe(true);
  });

  it("leg 3: within the exhausted tail, higher ask PRESSURE first (asks / ceiling)", () => {
    // Legs 1 and 2 tie (both exhausted, neither advanced past), so leg 3 decides. `over`
    // carries an ask count ABOVE its ceiling — the real shape of an envelope written when
    // MAX_ASKS_PER_QUESTION was larger — giving it pressure 1.5 against 1.0.
    //
    // `display_order` deliberately FAVOURS the loser, so a pass cannot come from leg 5.
    const result = deriveStuckQuestion(
      input({
        askCounts: { over: 3, at_ceiling: 2 },
        items: [
          item("over", { maxAsks: 2, displayOrder: 0 }),
          item("at_ceiling", { maxAsks: 2, displayOrder: 9 }),
        ],
      }),
    );
    expect(result.candidates.map((c) => c.question_key)).toEqual(["over", "at_ceiling"]);
    expect(result.candidates[0]!.asks).toBe(3);
    expect(result.candidates[0]!.ask_ceiling).toBe(2);
  });

  it("leg 5: the UNIVERSAL tail outranks the pinned occupation pack (it serves later)", () => {
    // `nextQuestion` drains the occupation pack before the universal one, so at equal
    // pressure the universal question is the one the engine reached more recently.
    const result = deriveStuckQuestion(
      input({
        askCounts: { trade_q: 1, universal_q: 1 },
        pinnedPackId: OCCUPATION_PACK,
        items: [
          item("trade_q", { packId: OCCUPATION_PACK, displayOrder: 40 }),
          item("universal_q", { packId: UNIVERSAL_PACK, packVersion: 3, displayOrder: 0 }),
        ],
      }),
    );
    expect(result.stuck_question?.question_key).toBe("universal_q");
    expect(result.stuck_question?.pack_id).toBe(UNIVERSAL_PACK);
    expect(result.stuck_question?.pack_version).toBe(3);
  });

  it("leg 5 (cont.): within one pack, the LATER display_order wins", () => {
    const result = deriveStuckQuestion(
      input({
        askCounts: { early: 1, late: 1 },
        items: [item("early", { displayOrder: 1 }), item("late", { displayOrder: 7 })],
      }),
    );
    expect(result.stuck_question?.question_key).toBe("late");
  });

  it("leg 6: the ordering is TOTAL — two identical candidates resolve deterministically", () => {
    // No item rows at all, so every leg above ties. Without the final key leg the sort would
    // depend on object-key order and two reads of one session could disagree.
    const forward = deriveStuckQuestion(input({ askCounts: { aaa: 1, zzz: 1 } }));
    const reverse = deriveStuckQuestion(input({ askCounts: { zzz: 1, aaa: 1 } }));
    expect(forward.stuck_question?.question_key).toBe(reverse.stuck_question?.question_key);
    expect(forward.candidates.map((c) => c.question_key)).toEqual(
      reverse.candidates.map((c) => c.question_key),
    );
  });
});

// ---------------------------------------------------------------------------
// The honest-absence outcomes.
// ---------------------------------------------------------------------------

describe("honest absence — a missing measurement is never a confident answer", () => {
  it("no conversation_state ⇒ no_conversation_state, never a guessed question", () => {
    const result = deriveStuckQuestion(
      input({ hasConversationState: false, askCounts: {}, items: [item("q1")] }),
    );
    expect(result.outcome).toBe("no_conversation_state");
    expect(result.stuck_question).toBeNull();
  });

  it("state present but no asks recorded ⇒ no_asks_recorded", () => {
    const result = deriveStuckQuestion(input({ askCounts: {}, items: [item("q1")] }));
    expect(result.outcome).toBe("no_asks_recorded");
    expect(result.stuck_question).toBeNull();
  });

  it("an ask count of ZERO is not an ask (a key present with 0 does not become a candidate)", () => {
    const result = deriveStuckQuestion(input({ askCounts: { never_served: 0 } }));
    expect(result.outcome).toBe("no_asks_recorded");
    expect(result.asked_count).toBe(0);
  });

  it("a NEGATIVE or non-numeric stored count is clamped, not trusted", () => {
    // This map round-trips through jsonb written by older builds. A stored -1 must not
    // produce a negative pressure that ranks nonsensically, and a string must not become NaN.
    const result = deriveStuckQuestion(
      input({
        askCounts: { bad: -3, worse: Number.NaN, good: 1 } as unknown as Record<string, number>,
        items: [item("good")],
      }),
    );
    expect(result.asked_count).toBe(1);
    expect(result.stuck_question?.question_key).toBe("good");
  });

  it("a question settled ONLY in the answer map is excluded (the union errs toward 'not stuck')", () => {
    // An interview that ended without a flush can have a settled record in the checkpoint and
    // no `worker_pack_answer` row. Accusing that question would be worse than reporting none.
    const result = deriveStuckQuestion(
      input({
        askCounts: { flushed: 1, only_in_state: 1 },
        settledKeys: ["flushed"],
        answerMapStatuses: { flushed: "answered", only_in_state: "answered" },
        items: [item("flushed"), item("only_in_state")],
      }),
    );
    expect(result.outcome).toBe("all_settled");
    expect(result.settled_count).toBe(2);
  });

  it("a SUPERSEDED record does not settle a question (it is a history entry, not an answer)", () => {
    const result = deriveStuckQuestion(
      input({
        askCounts: { corrected: 1 },
        answerMapStatuses: { corrected: "superseded" },
        items: [item("corrected")],
      }),
    );
    expect(result.outcome).toBe("resolved");
    expect(result.stuck_question?.question_key).toBe("corrected");
  });
});
