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
 * a clean completion, a COMPLETED interview that failed a question on the way, an
 * abandonment mid-question, a question that burned its `max_asks`, and the multi-candidate
 * case that the tie-break exists for.
 */

const OCCUPATION_PACK = "qp_welding";
const UNIVERSAL_PACK = "qp_universal";

/**
 * A pack item. The defaults describe the MODAL corpus row — non-mandatory, non-core — because
 * 606 of the corpus's 611 items are non-mandatory and 487 declare `max_asks: 1`. A test that
 * wants the re-askable shape must say `isMandatory: true` explicitly, which is the point.
 */
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
    isMandatory: false,
    isCore: false,
    ...overrides,
  };
}

/** The 5-of-611 shape: the engine may re-serve this one, up to its ceiling. */
function mandatory(
  questionKey: string,
  overrides: Partial<StuckQuestionItem> = {},
): StuckQuestionItem {
  return item(questionKey, { isMandatory: true, ...overrides });
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
    // makes a once-asked question NOT exhausted — but `unservable` does NOT follow it there,
    // because `is_mandatory` (the input it needs) has no defensible default. See the
    // three-valued leg-2 tests below.
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
// Case 1b — a COMPLETED interview that failed a question. The modal shape, and the one
// that used to render as "stuck on" the question the worker got past.
// ---------------------------------------------------------------------------

describe("a COMPLETED interview containing an unsettled question", () => {
  /**
   * ⚠ THE DEFECT THIS BLOCK PINS.
   *
   * `orchestrator.service.ts` records `unanswered` whenever the new decision's `questionKey`
   * differs from what was on screen — and a `close` decision carries `questionKey: null`,
   * which ALWAYS differs. So on every session the engine closed, EVERY unsettled asked key is
   * engine-advanced-past and there is no candidate the engine was still serving. Naming one
   * anyway reported a worker who FINISHED the interview as stuck on the one question they
   * failed, which is the opposite of the truth and the modal case for `max_asks: 1` items.
   */
  it("names NO stuck question when the engine had advanced past every unsettled key", () => {
    const result = deriveStuckQuestion(
      input({
        askCounts: { trade_years: 1, machine_types: 1, salary_expected: 1 },
        settledKeys: ["trade_years", "salary_expected"],
        answerMapStatuses: {
          trade_years: "answered",
          salary_expected: "answered",
          // The engine asked it, could not use the answer, and moved on — then closed.
          machine_types: "unanswered",
        },
        items: [item("machine_types", { maxAsks: 1 }), item("trade_years"), item("salary_expected")],
      }),
    );

    expect(result.outcome).toBe("engine_advanced_past_all");
    expect(result.stuck_question).toBeNull();
    // ...and the candidate is STILL reported, flagged for exactly what it is. "Which questions
    // did this worker never settle" is the useful question in this shape.
    expect(result.candidates.map((c) => c.question_key)).toEqual(["machine_types"]);
    expect(result.candidates[0]!.engine_advanced_past).toBe(true);
    expect(result.asked_count).toBe(3);
    expect(result.settled_count).toBe(2);
  });

  it("is DISTINCT from a clean completion — the two outcomes are not collapsed", () => {
    const clean = deriveStuckQuestion(
      input({
        askCounts: { q1: 1 },
        settledKeys: ["q1"],
        answerMapStatuses: { q1: "answered" },
        items: [item("q1")],
      }),
    );
    const withFailure = deriveStuckQuestion(
      input({
        askCounts: { q1: 1, q2: 1 },
        settledKeys: ["q1"],
        answerMapStatuses: { q1: "answered", q2: "unanswered" },
        items: [item("q1"), item("q2")],
      }),
    );
    // "Everything settled" and "finished, but one question never landed" are different facts
    // and must not render identically.
    expect(clean.outcome).toBe("all_settled");
    expect(withFailure.outcome).toBe("engine_advanced_past_all");
    expect(clean.candidates).toEqual([]);
    expect(withFailure.candidates).toHaveLength(1);
    expect(withFailure.stuck_question).toBeNull();
  });

  it("ONE not-advanced-past candidate among many flips it back to resolved", () => {
    // The contrast case: the abandonment sweep persists the live envelope with
    // `servedQuestionKey` unadvanced, so the question on screen carries no `unanswered`
    // record even when everything around it does.
    const result = deriveStuckQuestion(
      input({
        askCounts: { skipped_a: 1, skipped_b: 1, on_screen: 1 },
        answerMapStatuses: { skipped_a: "unanswered", skipped_b: "unanswered" },
        items: [item("skipped_a"), item("skipped_b"), item("on_screen")],
      }),
    );
    expect(result.outcome).toBe("resolved");
    expect(result.stuck_question?.question_key).toBe("on_screen");
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
// `unservable` — the engine's ACTUAL re-serve rule, which is not the ask ceiling.
// ---------------------------------------------------------------------------

describe("`unservable` is `is_mandatory`-aware, because `selectItem` is", () => {
  /**
   * ⚠ WHY THIS IS NOT `asks >= ask_ceiling`.
   *
   * `selectItem` runs three passes. Only the FIRST re-serves — the other two both require
   * `askCount(state, key) === 0`. So a NON-MANDATORY item is never served twice, whatever its
   * `max_asks` says, and 606 of the corpus's 611 items are non-mandatory. Ranking on the
   * ceiling alone therefore had leg 2 backwards for essentially the whole corpus: it treated
   * the 119 non-mandatory `max_asks: 2` items as "still servable" forever, and every
   * `max_asks: 1` item — including the one actually on screen — as un-servable from its FIRST
   * ask.
   */
  it("a NON-mandatory item is un-servable after ONE ask, even under max_asks: 2", () => {
    const result = deriveStuckQuestion(
      input({ askCounts: { experience_years: 1 }, items: [item("experience_years", { maxAsks: 2 })] }),
    );
    const c = result.candidates[0]!;
    expect(c.asks).toBe(1);
    expect(c.ask_ceiling).toBe(2);
    // The literal ceiling test still says "budget left"...
    expect(c.exhausted).toBe(false);
    // ...and the engine still can never serve it again.
    expect(c.unservable).toBe(true);
    expect(c.is_mandatory).toBe(false);
  });

  it("a MANDATORY item at the same ask count is still servable (the 5-of-611 shape)", () => {
    const result = deriveStuckQuestion(
      input({ askCounts: { primary_trade: 1 }, items: [mandatory("primary_trade", { maxAsks: 2 })] }),
    );
    const c = result.candidates[0]!;
    expect(c.asks).toBe(1);
    expect(c.unservable).toBe(false);
    expect(c.is_mandatory).toBe(true);
  });

  it("a mandatory item AT its ceiling is un-servable — the ceiling still binds pass 1", () => {
    const result = deriveStuckQuestion(
      input({ askCounts: { primary_trade: 2 }, items: [mandatory("primary_trade", { maxAsks: 2 })] }),
    );
    expect(result.candidates[0]!.unservable).toBe(true);
    expect(result.candidates[0]!.exhausted).toBe(true);
  });

  it("an UNRESOLVED item reports null — `is_mandatory` is unknown, so this is too", () => {
    const result = deriveStuckQuestion(input({ askCounts: { orphan: 1 }, items: [] }));
    const c = result.candidates[0]!;
    expect(c.unservable).toBeNull();
    expect(c.is_mandatory).toBeNull();
    expect(c.is_core).toBeNull();
    expect(c.max_asks).toBeNull();
    expect(result.unresolved_count).toBe(1);
  });

  it("...but an unresolved item AT the fallback ceiling is un-servable whatever it is", () => {
    const result = deriveStuckQuestion(input({ askCounts: { orphan: 2 }, items: [] }));
    expect(result.candidates[0]!.unservable).toBe(true);
  });
});

describe("leg 2 ranks servable > unknown > un-servable (the three-valued order)", () => {
  it("a provably-servable mandatory item beats an unresolved one", () => {
    const result = deriveStuckQuestion(
      input({
        askCounts: { orphan: 1, primary_trade: 1 },
        // display_order deliberately favours the loser, so a pass cannot come from leg 5.
        items: [mandatory("primary_trade", { displayOrder: 0 })],
      }),
    );
    expect(result.candidates.map((c) => c.question_key)).toEqual(["primary_trade", "orphan"]);
  });

  it("an unresolved item beats a provably UN-servable one", () => {
    // The old behaviour ranked an unresolved key as `exhausted: false`, i.e. it beat every
    // resolved candidate outright — which is how the universal tail systematically won leg 2
    // in a text-mode session. It now sits BETWEEN the two provable answers.
    const result = deriveStuckQuestion(
      input({
        askCounts: { orphan: 1, burned: 2 },
        items: [item("burned", { maxAsks: 2, displayOrder: 9 })],
      }),
    );
    expect(result.candidates.map((c) => c.question_key)).toEqual(["orphan", "burned"]);
  });

  it("counts every unresolved candidate, so the blindness is REPORTED not absorbed", () => {
    const result = deriveStuckQuestion(
      input({
        askCounts: { known: 1, orphan_a: 1, orphan_b: 1 },
        items: [mandatory("known")],
      }),
    );
    expect(result.unresolved_count).toBe(2);
    expect(result.candidates).toHaveLength(3);
  });

  it("unresolved_count is 0 when every candidate resolved", () => {
    const result = deriveStuckQuestion(
      input({ askCounts: { known: 1 }, items: [mandatory("known")] }),
    );
    expect(result.unresolved_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Case 3 — a question that exhausted max_asks and was skipped.
// ---------------------------------------------------------------------------

describe("a question that burned its ask budget and was skipped", () => {
  it("is NOT named as the stuck question when another candidate is still servable", () => {
    // `welding_process` (mandatory) was asked twice — its ceiling — the engine gave up and
    // recorded `unanswered`, and moved on to `primary_trade`, where the session died. The
    // exhausted one has the HIGHER ask pressure (2/2 vs 1/2), so a ranking that led with
    // pressure would name the wrong question. It leads with the two disqualifiers instead.
    const result = deriveStuckQuestion(
      input({
        askCounts: { welding_process: 2, primary_trade: 1 },
        settledKeys: [],
        answerMapStatuses: { welding_process: "unanswered" },
        items: [
          mandatory("welding_process", { displayOrder: 3, maxAsks: 2 }),
          mandatory("primary_trade", { displayOrder: 9, maxAsks: 2 }),
        ],
      }),
    );

    expect(result.stuck_question?.question_key).toBe("primary_trade");
    // ...and the skipped one is still REPORTED, ranked second, flagged for what it is.
    expect(result.candidates.map((c) => c.question_key)).toEqual([
      "primary_trade",
      "welding_process",
    ]);
    const skipped = result.candidates[1]!;
    expect(skipped.exhausted).toBe(true);
    expect(skipped.unservable).toBe(true);
    expect(skipped.engine_advanced_past).toBe(true);
    expect(skipped.asks).toBe(2);
    expect(skipped.ask_ceiling).toBe(2);
  });

  it("is NOT named even as the ONLY unsettled key — the engine had moved on from it too", () => {
    // ⚠ THIS TEST USED TO ASSERT THE OPPOSITE, under a title claiming "the interview ended
    // right after it" while asserting `engine_advanced_past: true` — which is the engine
    // saying it did NOT end right after it. An `unanswered` record is a disqualification, and
    // being the last candidate standing does not undo it.
    const result = deriveStuckQuestion(
      input({
        askCounts: { machine_types: 2, trade_years: 1 },
        settledKeys: ["trade_years"],
        answerMapStatuses: { trade_years: "answered", machine_types: "unanswered" },
        items: [item("machine_types", { maxAsks: 2 }), item("trade_years")],
      }),
    );
    expect(result.outcome).toBe("engine_advanced_past_all");
    expect(result.stuck_question).toBeNull();
    expect(result.candidates[0]!.question_key).toBe("machine_types");
    expect(result.candidates[0]!.exhausted).toBe(true);
  });

  it("respects an item's OWN max_asks of 1 (ask-once questions exhaust at one ask)", () => {
    const result = deriveStuckQuestion(
      input({
        askCounts: { one_shot: 1, two_shot: 1 },
        items: [
          mandatory("one_shot", { maxAsks: 1, displayOrder: 0 }),
          mandatory("two_shot", { maxAsks: 2, displayOrder: 1 }),
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

  it("leg 2: still-servable beats un-servable, when no answer map is available to decide", () => {
    // A session whose checkpoint predates the answer map (or lost it) still has ask_counts.
    const result = deriveStuckQuestion(
      input({
        askCounts: { burned: 2, live: 1 },
        answerMapStatuses: {},
        items: [
          mandatory("burned", { displayOrder: 9 }),
          mandatory("live", { displayOrder: 0 }),
        ],
      }),
    );
    // `burned` has the later display order AND the higher pressure; leg 2 outranks both.
    expect(result.stuck_question?.question_key).toBe("live");
  });

  it("a `max_asks` of 3 would be CAPPED at the engine ceiling of 2 — the ceiling is the engine's", () => {
    // NOT a corpus observation: no pack row declares 3 today (the distribution is 487×1 and
    // 124×2). `qpi_max_asks_chk` PERMITS 1..3 while `askCeiling` clamps to
    // MAX_ASKS_PER_QUESTION, so this pins the clamp for the row a future author could write —
    // a pack cannot buy a third ask.
    const result = deriveStuckQuestion(
      input({
        askCounts: { greedy: 2 },
        items: [mandatory("greedy", { maxAsks: 3 })],
      }),
    );
    expect(result.candidates[0]!.max_asks).toBe(3);
    expect(result.candidates[0]!.ask_ceiling).toBe(MAX_ASKS_PER_QUESTION);
    expect(result.candidates[0]!.exhausted).toBe(true);
  });

  it("leg 3: within the un-servable tail, higher ask PRESSURE first (asks / ceiling)", () => {
    // Legs 1 and 2 tie (both un-servable, neither advanced past), so leg 3 decides. `over`
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
          mandatory("trade_q", { packId: OCCUPATION_PACK, displayOrder: 40 }),
          mandatory("universal_q", {
            packId: UNIVERSAL_PACK,
            packVersion: 3,
            displayOrder: 0,
          }),
        ],
      }),
    );
    expect(result.stuck_question?.question_key).toBe("universal_q");
    expect(result.stuck_question?.pack_id).toBe(UNIVERSAL_PACK);
    expect(result.stuck_question?.pack_version).toBe(3);
  });

  it("leg 5 (cont.): a LATER selectItem PASS beats a lower display_order", () => {
    /**
     * ⚠ THE PROPERTY `display_order` ALONE GOT BACKWARDS. `selectItem` picks in three passes —
     * mandatory, then core-never-asked, then any-never-asked — and only sorts by
     * `display_order` WITHIN a pass. So a non-core item at `display_order: 1` is reached AFTER
     * a core item at `display_order: 9`, and "later engine position" has to mean the later
     * PASS. The orders here are set to favour the loser under the old model.
     */
    const result = deriveStuckQuestion(
      input({
        askCounts: { core_late: 1, plain_early: 1 },
        items: [
          item("core_late", { isCore: true, displayOrder: 9 }),
          item("plain_early", { displayOrder: 1 }),
        ],
      }),
    );
    expect(result.stuck_question?.question_key).toBe("plain_early");
  });

  it("leg 5 (cont.): a MANDATORY item is the EARLIEST position, not the latest", () => {
    // Pass 1 runs first, so a mandatory item entered the conversation BEFORE a core one.
    // Both carry `max_asks: 1` so legs 2, 3 and 4 all tie (un-servable, pressure 1.0, one
    // ask), and `display_order` favours the loser — leg 5's PASS term is the only thing left.
    const result = deriveStuckQuestion(
      input({
        askCounts: { must_ask: 1, core_q: 1 },
        items: [
          mandatory("must_ask", { maxAsks: 1, displayOrder: 9 }),
          item("core_q", { isCore: true, maxAsks: 1, displayOrder: 0 }),
        ],
      }),
    );
    expect(result.candidates.map((c) => c.question_key)).toEqual(["core_q", "must_ask"]);
  });

  it("leg 2 still outranks leg 5: a servable mandatory item beats a later-pass un-servable one", () => {
    /**
     * ⚠ THIS IS THE RANKING CONSEQUENCE OF `unservable` BEING `is_mandatory`-AWARE, and it is
     * built so the CEILING-ONLY reading loses. Both items carry `max_asks: 2` and one ask, so
     * `asks >= ask_ceiling` is false for BOTH and legs 3 and 4 tie — under that reading leg 5
     * decides and `core_q` (a later `selectItem` pass, later display order) wins. Only the
     * engine's real rule — one ask is permanent for a NON-mandatory item — puts `must_ask`
     * first, and `must_ask` is the one the engine could genuinely still have been serving.
     */
    const result = deriveStuckQuestion(
      input({
        askCounts: { must_ask: 1, core_q: 1 },
        items: [
          mandatory("must_ask", { maxAsks: 2, displayOrder: 0 }),
          item("core_q", { isCore: true, maxAsks: 2, displayOrder: 9 }),
        ],
      }),
    );
    expect(result.stuck_question?.question_key).toBe("must_ask");
    expect(result.candidates.map((c) => c.unservable)).toEqual([false, true]);
  });

  it("leg 5 (cont.): within one pass, the LATER display_order wins", () => {
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
