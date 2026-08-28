/**
 * A FULL SIMULATED INTERVIEW over `qp_cnc_turning` + `qp_universal`, driven through the real
 * `nextQuestion` engine.
 *
 * WHY, when the depth ladder already has a proof test. That test asks the predicate a question:
 * "would this item be eligible at experience band N?" It cannot see anything the ENGINE decides —
 * phase order, the mandatory-before-core-before-rest priority, the per-question ask ceiling, and
 * above all the ask BUDGET. A pack can have every predicate correct and still truncate a senior
 * worker's conversation before the universal tail runs, and the worker would simply never be asked
 * their city or their salary. Nothing but a full drive catches that.
 *
 * The simulation answers every question the engine serves, the way a worker tapping the first
 * chip would, and asserts on what the whole conversation looked like.
 *
 * PRIVACY: reviewed pack content and synthetic answers. No worker data.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { QuestionPackSchema, type QuestionPack } from "@badabhai/ai-contracts";

import type { AnswerMap } from "./answer-map";
import { MAX_ENGINE_ASKS, nextQuestion, type Decision, type EngineState } from "./next-question";

const PACK_DIR = join(__dirname, "../../../../packages/db/data/question-packs/packs");

/**
 * The three answer types the corpus and the DB permit that the frozen contract does not.
 *
 * MIRRORS `ANSWER_TYPE_ALIASES` in `pack-registry.service.ts`, which is the real loader. Without
 * it `qp_universal@2` does not parse at all — it authors `duration`, `city` and `salary` — and a
 * simulation that quietly dropped the universal pack would "pass" while proving nothing about the
 * tail every worker actually gets.
 */
const ANSWER_TYPE_ALIASES: Readonly<Record<string, string>> = {
  city: "text",
  salary: "number",
  duration: "number",
};

/**
 * Load a corpus pack into the runtime shape, the way `pack-registry.service.ts` does.
 *
 * The corpus spells option values as `value_text` / `value_number` / `value_bool`; the runtime
 * carries ONE `value`. This mirrors `pack-registry.service.ts:530` — `valueText ?? valueNumber ??
 * valueBool` — and it has to stay a mirror, because that `??` order is exactly what makes a stray
 * `value_text` on a numeric gate silently disable it.
 */
function loadPack(file: string): QuestionPack {
  const raw = JSON.parse(readFileSync(join(PACK_DIR, file), "utf8")) as Record<string, unknown>;
  const items = (raw.items as Record<string, unknown>[]).map((item, index) => ({
    ...item,
    display_order: index,
    answer_type: ANSWER_TYPE_ALIASES[item.answer_type as string] ?? item.answer_type,
    options: ((item.options as Record<string, unknown>[]) ?? []).map((o) => ({
      option_key: o.option_key,
      label_text: o.label_text,
      value: o.value_text ?? o.value_number ?? o.value_bool ?? null,
      implies_skill_id: o.implies_skill_id ?? null,
      is_none_of_above: o.is_none_of_above ?? false,
    })),
  }));
  return QuestionPackSchema.parse({ ...raw, content_hash: "sim", items });
}

const turning = loadPack("qp_cnc_turning.json");
const universal = loadPack("qp_universal@2.json");
const packs = { occupation: turning, universal };

function emptyState(): EngineState {
  return {
    phase: "occupation_specific",
    turn: 0,
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
  };
}

interface Transcript {
  readonly asked: string[];
  readonly decisions: Decision[];
  readonly closedBy: string | null;
}

/**
 * Drive a whole interview. `answerFor` returns the `value_normalized` a worker's tap produces —
 * `null` means "this worker declines", which leaves the question answerable again.
 */
function runInterview(answerFor: (key: string, decision: Decision) => unknown): Transcript {
  let state = emptyState();
  const asked: string[] = [];
  const decisions: Decision[] = [];
  const answers: Record<string, { value_normalized: unknown; status: string }> = {};
  const askCounts: Record<string, number> = {};

  // Bounded well above MAX_ENGINE_ASKS so a non-terminating engine fails as a loop-limit rather
  // than hanging the suite.
  for (let guard = 0; guard < 200; guard++) {
    const decision = nextQuestion(state, packs);
    decisions.push(decision);
    if (decision.kind === "close") {
      return { asked, decisions, closedBy: decision.completionReason };
    }
    const key = decision.questionKey as string;
    asked.push(key);
    askCounts[key] = (askCounts[key] ?? 0) + 1;
    const value = answerFor(key, decision);
    if (value !== null) answers[key] = { value_normalized: value, status: "answered" };
    state = {
      ...state,
      phase: decision.phase,
      turn: state.turn + 1,
      engineAsks: state.engineAsks + 1,
      askCounts: { ...askCounts },
      answers: { ...answers } as unknown as AnswerMap,
      servedQuestionKey: key,
    };
  }
  throw new Error("interview did not terminate within 200 turns");
}

/** A worker who taps the chip carrying `band` on the gate, and the first chip on everything else. */
function tapper(band: number) {
  return (key: string, decision: Decision): unknown => {
    if (key === "turning_experience") {
      const chip = decision.options.find((o) => o.value === band);
      if (!chip) throw new Error(`no gate chip with value ${band}`);
      return chip.value;
    }
    const first = decision.options[0];
    return first ? (first.value ?? first.label_text) : "haan";
  };
}

const TIER1 = ["setting_operation", "tolerance_band", "sector_worked"];
const TIER2 = ["programming_level", "advanced_capability", "quality_work", "troubleshooting"];
const UNIVERSAL_KEYS = universal.items.map((i) => i.question_key);

describe("qp_cnc_turning — a full simulated interview", () => {
  it("the fixtures are the real packs, not empty — else every assertion is vacuous", () => {
    // 15 trade items + 3 fresher items (R10 §2.6, gated `lte 0` and disjoint from tiers 1-2).
    expect(turning.items.length).toBe(18);
    expect(universal.items.length).toBeGreaterThan(0);
    expect(turning.items[0]?.question_key).toBe("turning_experience");
  });

  it("a JUNIOR turner completes, and is never asked a tier-1 or tier-2 question", () => {
    const t = runInterview(tapper(0));
    expect(t.closedBy).toBe("complete");
    for (const k of [...TIER1, ...TIER2]) expect(t.asked).not.toContain(k);
  });

  it("a SENIOR turner completes without the budget truncating the conversation", () => {
    const t = runInterview(tapper(10));
    // `ask_budget` here would mean the engine ran out of asks before it was done — the senior
    // worker's interview cut short, which is the exact failure the pack's _budget note guards.
    expect(t.closedBy).toBe("complete");
    for (const k of [...TIER1, ...TIER2]) expect(t.asked).toContain(k);
  });

  it("EVERY worker still reaches the universal tail — trade depth never crowds it out", () => {
    // The one that matters most. Trade questions are useless if the worker is never asked their
    // city, their salary or when they can start: those are what a job is matched on.
    for (const band of [0, 2, 5, 10]) {
      const t = runInterview(tapper(band));
      for (const k of UNIVERSAL_KEYS) {
        expect(t.asked, `band ${band} never reached universal question ${k}`).toContain(k);
      }
    }
  });

  it("the gate is asked FIRST, before anything it gates", () => {
    for (const band of [0, 10]) {
      const t = runInterview(tapper(band));
      expect(t.asked[0]).toBe("turning_experience");
    }
  });

  it("no question is asked more times than its max_asks allows", () => {
    for (const band of [0, 2, 5, 10]) {
      const t = runInterview(tapper(band));
      const counts = new Map<string, number>();
      for (const k of t.asked) counts.set(k, (counts.get(k) ?? 0) + 1);
      for (const item of [...turning.items, ...universal.items]) {
        const seen = counts.get(item.question_key) ?? 0;
        expect(seen, `${item.question_key} asked ${seen} times`).toBeLessThanOrEqual(item.max_asks);
      }
    }
  });

  it("the whole interview stays inside MAX_ENGINE_ASKS at every band", () => {
    for (const band of [0, 2, 5, 10]) {
      const t = runInterview(tapper(band));
      expect(t.asked.length, `band ${band} spent ${t.asked.length} asks`).toBeLessThanOrEqual(
        MAX_ENGINE_ASKS,
      );
    }
  });

  it("MUTATION CHECK: a worker who declines the gate still gets a complete interview", () => {
    // Declining must not strand them in the tiered block or skip the universal tail.
    const t = runInterview((key, d) => (key === "turning_experience" ? null : tapper(0)(key, d)));
    expect(t.closedBy).not.toBe(null);
    for (const k of TIER2) expect(t.asked).not.toContain(k);
  });
});
