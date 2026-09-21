import { describe, expect, it } from "vitest";
import type { QuestionPackItem } from "@badabhai/ai-contracts";

import { recordAnswer, recordDeclined, recordUnanswered, type AnswerMap } from "../answer-map";
import {
  declinedCoreFacts,
  sessionFactOutcomes,
  unansweredFacts,
  type FactOutcomeStatus,
} from "./fact-outcomes";

/**
 * The classifier the Phase 3 settled-vs-missing view consumes (fill-gap Phase 2).
 *
 * The assertions that matter are the two the view's usefulness stands on: a SERVED question with
 * no answer is `unanswered` (not missing), and an ABSENT record is `missing` (not skipped) — and
 * a declined CORE question is reported as declined, never as a gap.
 */

const item = (
  questionKey: string,
  over: Partial<QuestionPackItem> = {},
): Pick<QuestionPackItem, "question_key" | "target_field" | "is_core"> => ({
  question_key: questionKey,
  target_field: over.target_field ?? null,
  is_core: over.is_core ?? false,
});

const TRADE = item("primary_trade", { target_field: "trade", is_core: true });
const CITY = item("current_city", { target_field: "current_city", is_core: true });
const EXPERIENCE = item("experience_years", { target_field: "experience_years" });
const UNKNOWN_ATTRIBUTE = item("welding_process", { target_field: "welding_process" });

const withAnswer = (questionKey: string, targetField: string | null, value: unknown): AnswerMap =>
  recordAnswer(
    {},
    { questionKey, targetField, valueRaw: String(value), valueNormalized: value, evidence: null },
    1,
  );

describe("sessionFactOutcomes", () => {
  it("distinguishes all four states in one session", () => {
    const answers = recordDeclined(
      recordUnanswered(withAnswer("primary_trade", "trade", "welder"), "current_city", 3),
      "experience_years",
      4,
    );

    const byFact = Object.fromEntries(
      sessionFactOutcomes([TRADE, CITY, EXPERIENCE], answers).map((o) => [o.fact, o.status]),
    );
    expect(byFact).toEqual({
      trade: "answered",
      current_city: "unanswered",
      experience: "declined",
    } satisfies Record<string, FactOutcomeStatus>);
  });

  it("reports a fact with NO record as missing, never as unanswered", () => {
    // The distinction the view exists for: `experience_years` was never reached, `current_city`
    // was served and skipped. Same empty value, different worker-facing sentence.
    const answers = recordUnanswered({}, "current_city", 3);
    const outcomes = sessionFactOutcomes([TRADE, CITY, EXPERIENCE], answers);
    const byFact = Object.fromEntries(outcomes.map((o) => [o.fact, o.status]));
    expect(byFact.experience).toBe("missing");
    expect(byFact.current_city).toBe("unanswered");
    expect(byFact.trade).toBe("missing");
  });

  it("is empty for an empty map — the classifier invents nothing", () => {
    expect(sessionFactOutcomes([TRADE, CITY], {})).toEqual([
      { fact: "trade", questionKey: "primary_trade", status: "missing", isCore: true },
      { fact: "current_city", questionKey: "current_city", status: "missing", isCore: true },
    ]);
  });

  it("skips items that name no registered fact", () => {
    const facts = sessionFactOutcomes([UNKNOWN_ATTRIBUTE], {}).map((o) => o.fact);
    expect(facts).toEqual([]);
  });

  it("lets the strongest status win when two spellings settle one fact", () => {
    // `trade` is reachable through more than one item spelling in the corpus. An answer through
    // one spelling settles the FACT; a sibling spelling's unanswered record must not drag it back.
    const alias = item("trade_current", { target_field: "trade" });
    const answers = recordAnswer(
      recordUnanswered({}, "trade_current", 2),
      {
        questionKey: "primary_trade",
        targetField: "trade",
        valueRaw: "welder",
        valueNormalized: "welder",
        evidence: null,
      },
      3,
    );

    const outcomes = sessionFactOutcomes([alias, TRADE], answers);

    expect(outcomes).toEqual([
      { fact: "trade", questionKey: "primary_trade", status: "answered", isCore: true },
    ]);
  });

  it("keeps first-appearance order", () => {
    const answers = withAnswer("experience_years", "experience_years", 4);
    expect(sessionFactOutcomes([TRADE, EXPERIENCE, CITY], answers).map((o) => o.fact)).toEqual([
      "trade",
      "experience",
      "current_city",
    ]);
  });
});

describe("unansweredFacts / declinedCoreFacts", () => {
  it("splits the finish-list feed from the declined-core set", () => {
    const answers = recordDeclined(
      recordUnanswered(recordDeclined({}, "primary_trade", 2), "current_city", 3),
      "experience_years",
      4,
    );
    const outcomes = sessionFactOutcomes([TRADE, CITY, EXPERIENCE], answers);

    // `primary_trade` was declined too, but it is core — so it lands in the declined-core set,
    // and the unanswered set holds only the served-and-skipped question.
    expect(unansweredFacts(outcomes)).toEqual(["current_city"]);
    expect(declinedCoreFacts(outcomes)).toEqual(["trade"]);
  });

  it("does not report a non-core decline as declined-core", () => {
    const answers = recordDeclined({}, "experience_years", 2);
    const outcomes = sessionFactOutcomes([EXPERIENCE], answers);
    expect(declinedCoreFacts(outcomes)).toEqual([]);
  });

  it("returns nothing for a clean session", () => {
    const answers = withAnswer("primary_trade", "trade", "welder");
    const outcomes = sessionFactOutcomes([TRADE, CITY], answers);
    expect(unansweredFacts(outcomes)).toEqual([]);
    expect(declinedCoreFacts(outcomes)).toEqual([]);
  });
});
