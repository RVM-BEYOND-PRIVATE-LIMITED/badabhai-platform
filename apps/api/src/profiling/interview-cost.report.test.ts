import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { QuestionPackSchema, type QuestionPack } from "@badabhai/ai-contracts";

import type { AnswerMap } from "./answer-map";
import { nextQuestion, type Decision, type EngineState } from "./next-question";

/**
 * EMITS the real transcript of a full CNC-turner interview, so cost per profile can be PRICED
 * rather than estimated from memory.
 *
 * WHY IT IS A TEST FILE AND NOT A SCRIPT, and why it emits rather than asserts: the ask sequence
 * has to come from the REAL `nextQuestion` engine and the REAL packs — a script with its own
 * wiring is a second thing that can disagree with production about what a worker is asked, which
 * is exactly the number this is trying to establish. It writes JSON and asserts almost nothing;
 * `scripts/price-interview.py` does the pricing, using the ai-service's OWN rate table and token
 * estimator so the price is single-sourced.
 *
 * SKIPPED UNLESS ASKED, like the sheet emitter:
 *
 *   REPORT_INTERVIEW_COST=<dir> pnpm --filter @badabhai/api run test interview-cost
 *   python scripts/price-interview.py <dir>/interview.json
 *
 * PRIVACY: pack content and synthetic chip taps. No worker data, and no real transcript is ever
 * read by this file.
 */
const OUT_DIR = process.env.REPORT_INTERVIEW_COST;

const PACK_DIR = join(__dirname, "../../../../packages/db/data/question-packs/packs");

/** Mirrors `ANSWER_TYPE_ALIASES` in pack-registry.service.ts — without it qp_universal@2 fails to parse. */
const ANSWER_TYPE_ALIASES: Readonly<Record<string, string>> = {
  city: "text",
  salary: "number",
  duration: "number",
};

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
  return QuestionPackSchema.parse({ ...raw, content_hash: "cost-report", items });
}

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

interface Turn {
  readonly questionKey: string;
  /** What the worker is shown — the templated ask COST-4 serves without an LLM call. */
  readonly promptText: string;
  /** The chip labels rendered with the ask; they are part of the turn's payload. */
  readonly optionLabels: string[];
  /** What the worker's tap sends back. */
  readonly answerText: string;
}

describe.skipIf(!OUT_DIR)("emit a full turner interview for pricing", () => {
  it("writes the real ask sequence for every experience band", () => {
    const packs = {
      occupation: loadPack("qp_cnc_turning.json"),
      universal: loadPack("qp_universal@2.json"),
    };
    mkdirSync(OUT_DIR!, { recursive: true });

    // The four chips on `turning_experience`. A senior worker unlocks both depth tiers and is
    // therefore the WORST CASE for cost — which is the number worth reporting.
    const bands = [0, 2, 5, 10];
    const report: Record<string, Turn[]> = {};

    for (const band of bands) {
      let state = emptyState();
      const turns: Turn[] = [];
      const answers: Record<string, { value_normalized: unknown; status: string }> = {};
      const askCounts: Record<string, number> = {};

      for (let guard = 0; guard < 200; guard += 1) {
        const decision = nextQuestion(state, packs);
        if (decision.kind === "close") break;
        const key = decision.questionKey as string;
        const chip =
          key === "turning_experience"
            ? decision.options.find((o) => o.value === band)
            : decision.options[0];
        const value = chip ? (chip.value ?? chip.label_text) : "haan";

        turns.push({
          questionKey: key,
          promptText: decision.promptText,
          optionLabels: decision.options.map((o) => o.label_text),
          answerText: String(chip?.label_text ?? value),
        });

        askCounts[key] = (askCounts[key] ?? 0) + 1;
        answers[key] = { value_normalized: value, status: "answered" };
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
      report[`band_${band}`] = turns;
    }

    writeFileSync(`${OUT_DIR}/interview.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    // The only assertion: a band that produced no turns would price at zero and read as cheap.
    for (const band of bands) expect(report[`band_${band}`]!.length).toBeGreaterThan(0);
  });
});
