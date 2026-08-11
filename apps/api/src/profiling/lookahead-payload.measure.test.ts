/**
 * #766 item 1 — MEASURE the lookahead's payload cost against the shipped corpus.
 *
 * Not a test: a measurement script, run on demand, whose output is the number the decision in
 * #766 needs. The review estimated "~4-8x" growth and a reviewer argued most entries are
 * redundant; both were unmeasured, and #766 says the answer may change the contract, so it has
 * to be measured before #761 makes a client depend on the shape.
 *
 * Run:  pnpm --filter @badabhai/api exec tsx src/profiling/lookahead-payload.measure.ts
 *
 * WHAT IT MEASURES, and why each choice:
 *   - The REAL corpus (`packages/db/data/question-packs/packs`), not a fixture — the redundancy
 *     claim is a property of the authored content, so a fixture cannot answer it.
 *   - The REAL wire shape from `chat.dto.ts` (snake_case, the same fields), because that is what
 *     is actually serialized. Measuring the internal camelCase `LookaheadEntry` would understate
 *     the keys, which are a real part of the bytes.
 *   - GZIPPED as well as raw. The transport compresses, and the redundancy argument is precisely
 *     the kind that gzip eats — a claim of "the same prompt serialized once per branch" is only
 *     a cost if it survives compression. Raw bytes alone would overstate the problem.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import type { QuestionPack, QuestionPackItem } from "@badabhai/ai-contracts";

import { computeLookahead, type Lookahead } from "./lookahead";
import type { EnginePacks, EngineState } from "./next-question";
import type { AnswerMap } from "./answer-map";

// Anchored to THIS FILE, not `process.cwd()`: the sibling corpus test uses cwd and therefore
// only resolves when vitest is invoked from `apps/api`, which is a trap for anyone running the
// suite from the repo root.
const PACK_DIR = join(__dirname, "../../../../packages/db/data/question-packs/packs");

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
    family_id: "fam_measure",
    locale: "hi-IN",
    status: "active",
    content_hash: "measure",
    items: [...items],
  } as QuestionPack;
}

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

/** The internal entry map → the exact `chat.dto.ts` wire shape. */
function toWire(lookahead: Lookahead): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, e] of Object.entries(lookahead)) {
    out[key] = {
      question_key: e.questionKey,
      question_kind: e.kind,
      prompt_text: e.promptText,
      why_text: e.whyText,
      answer_type: e.answerType,
      options: e.options.map((o) => ({
        option_key: o.option_key,
        label_text: o.label_text,
        is_none_of_above: o.is_none_of_above,
      })),
      progress: e.progress,
    };
  }
  return out;
}

/** The turn body WITHOUT the lookahead — the baseline a client saw before #765. */
function baseBody(item: QuestionPackItem): Record<string, unknown> {
  return {
    reply: item.prompt_text,
    asked_question_id: item.question_key,
    suggested_options: item.options.map((o) => ({
      option_key: o.option_key,
      label_text: o.label_text,
      is_none_of_above: o.is_none_of_above,
    })),
  };
}

const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), "utf8");
const gz = (v: unknown): number => gzipSync(Buffer.from(JSON.stringify(v), "utf8")).length;

interface Row {
  pack: string;
  questionKey: string;
  branches: number;
  distinctTargets: number;
  baseRaw: number;
  fullRaw: number;
  baseGz: number;
  fullGz: number;
}

function main(): void {
  const universalRaw = JSON.parse(readFileSync(join(PACK_DIR, "qp_universal.json"), "utf8")) as {
    items: Record<string, unknown>[];
  };
  const universal = toPack("qp_universal", [toItem(universalRaw.items[0] as never)]);

  const rows: Row[] = [];
  let predicted = 0;
  let declinedToPredict = 0;

  for (const file of readdirSync(PACK_DIR).filter((n) => n.endsWith(".json"))) {
    const raw = JSON.parse(readFileSync(join(PACK_DIR, file), "utf8")) as {
      pack_id: string;
      items: Record<string, unknown>[];
    };
    const items = (raw.items ?? []).map(toItem);
    const packs: EnginePacks = { occupation: toPack(raw.pack_id, items), universal };

    for (const item of items) {
      if (item.answer_type !== "single_select") continue;
      const before = afterServing(item.question_key);
      const lookahead = computeLookahead({
        decision: {
          kind: "ask",
          questionKey: item.question_key,
          promptText: item.prompt_text,
          options: item.options,
          phase: "occupation_specific",
          progress: { answered: 1, total: items.length },
        } as never,
        state: before,
        packs,
        items: [...items, ...universal.items],
        nextTurn: 4,
      });

      if (lookahead === null) {
        declinedToPredict++;
        continue;
      }
      predicted++;

      const wire = toWire(lookahead);
      const base = baseBody(item);
      const full = { ...base, lookahead: wire };

      // The redundancy claim: how many DISTINCT next-questions do the branches resolve to?
      // n branches collapsing to 1 target is the "same prompt serialized n times" case.
      const targets = new Set(
        Object.values(lookahead).map((e) => `${e.kind}:${e.questionKey ?? "(close)"}`),
      );

      rows.push({
        pack: raw.pack_id,
        questionKey: item.question_key,
        branches: Object.keys(lookahead).length,
        distinctTargets: targets.size,
        baseRaw: bytes(base),
        fullRaw: bytes(full),
        baseGz: gz(base),
        fullGz: gz(full),
      });
    }
  }

  const sum = (f: (r: Row) => number): number => rows.reduce((a, r) => a + f(r), 0);
  const n = rows.length;
  const ratio = (a: number, b: number): string => (b === 0 ? "n/a" : `${(a / b).toFixed(2)}x`);

  console.log(`\n=== lookahead payload cost, shipped corpus (#766 item 1) ===\n`);
  console.log(`single-select asks WITH a prediction : ${predicted}`);
  console.log(`asks that DECLINED to predict        : ${declinedToPredict}`);
  console.log(`  (null lookahead => the client falls back to today's round trip)\n`);

  console.log(`--- totals across ${n} predicted turns ---`);
  console.log(`raw   : ${sum((r) => r.baseRaw)} B -> ${sum((r) => r.fullRaw)} B   ${ratio(sum((r) => r.fullRaw), sum((r) => r.baseRaw))}`);
  console.log(`gzip  : ${sum((r) => r.baseGz)} B -> ${sum((r) => r.fullGz)} B   ${ratio(sum((r) => r.fullGz), sum((r) => r.baseGz))}`);

  console.log(`\n--- per-turn averages ---`);
  console.log(`raw   : ${(sum((r) => r.baseRaw) / n).toFixed(0)} B -> ${(sum((r) => r.fullRaw) / n).toFixed(0)} B  (+${((sum((r) => r.fullRaw) - sum((r) => r.baseRaw)) / n).toFixed(0)} B)`);
  console.log(`gzip  : ${(sum((r) => r.baseGz) / n).toFixed(0)} B -> ${(sum((r) => r.fullGz) / n).toFixed(0)} B  (+${((sum((r) => r.fullGz) - sum((r) => r.baseGz)) / n).toFixed(0)} B)`);

  // THE REDUNDANCY CLAIM, tested rather than asserted.
  const redundant = rows.filter((r) => r.distinctTargets < r.branches);
  console.log(`\n--- the "most entries are redundant" claim ---`);
  console.log(`turns where >=2 branches predict the SAME next turn: ${redundant.length}/${n}`);
  console.log(`total branches: ${sum((r) => r.branches)}   distinct targets: ${sum((r) => r.distinctTargets)}`);
  console.log(`=> ${(100 * (1 - sum((r) => r.distinctTargets) / sum((r) => r.branches))).toFixed(1)}% of branches duplicate another branch's target`);

  console.log(`\n--- worst 8 turns by ADDED gzipped bytes ---`);
  [...rows]
    .sort((a, b) => b.fullGz - b.baseGz - (a.fullGz - a.baseGz))
    .slice(0, 8)
    .forEach((r) =>
      console.log(
        `  +${String(r.fullGz - r.baseGz).padStart(5)} B gz  ${r.pack}/${r.questionKey}  ` +
          `(${r.branches} branches -> ${r.distinctTargets} distinct)`,
      ),
    );

  // The number that decides it: is the added payload cheaper than the round trip it saves?
  const addedGzAvg = (sum((r) => r.fullGz) - sum((r) => r.baseGz)) / n;
  console.log(`\n--- is it worth it on 2G? ---`);
  for (const [label, kbps, rttMs] of [
    ["2G (GPRS)   ", 40, 650],
    ["2G (EDGE)   ", 120, 450],
    ["3G (slow)   ", 400, 250],
  ] as const) {
    const txMs = (addedGzAvg * 8) / (kbps * 1000) * 1000;
    console.log(
      `  ${label} +${addedGzAvg.toFixed(0)} B gz costs ~${txMs.toFixed(0)} ms to send; ` +
        `saves ~${rttMs} ms round trip  =>  ${txMs < rttMs ? "NET WIN" : "NET LOSS"}`,
    );
  }
  console.log();
}

import { it } from "vitest";
it("measures the lookahead payload cost against the shipped corpus (#766)", () => {
  main();
});
