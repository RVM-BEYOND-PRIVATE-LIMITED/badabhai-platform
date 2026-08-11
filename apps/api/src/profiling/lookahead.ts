/**
 * What the engine WOULD serve next, computed for each answer the worker could give.
 *
 * WHY THE SERVER DOES THIS AND THE CLIENT DOES NOT. A worker on 2G waits a round trip between
 * tapping a chip and seeing the next question, and the obvious fix — let the client pick the next
 * question itself — is not available here. Selection depends on the predicate AST (`ask_if` /
 * `skip_if`), the ask ceilings, `min_turn`/`max_turn`, the settled-ness of every prior answer and
 * the engine's budgets; and the pack it would select FROM is not even known until retrieval pins
 * the worker's trade through a pgvector ladder that cannot run on a phone. Porting that to Dart
 * would be a third implementation of the engine (after TypeScript and the Python mirror), free to
 * disagree with the server silently — and `worker_pack_answer` is unique on
 * `(worker_id, pack_id, question_key)`, so a divergence writes to the wrong key rather than
 * erroring.
 *
 * {@link nextQuestion} is PURE, and the orchestrator already holds the state and the packs at the
 * moment it decides. So the same function can simply be asked the same question again, once per
 * possible answer, for nothing but CPU: no database, no Redis, no model. The client renders
 * instantly from the result and the server stays the only thing that decides.
 *
 * ADVISORY, ALWAYS. The next real turn response is authoritative; if it disagrees with what the
 * client rendered, the client replaces it. That is not a caveat bolted on — it is what makes the
 * whole thing safe to ship, because it means a wrong prediction costs a repaint and never a wrong
 * answer of record.
 *
 * EXACTNESS IS THE DESIGN CONSTRAINT, which is why this is narrower than it could be:
 *
 *   - `single_select` only, among answering shapes. The option carries the exact typed value that
 *     would be captured, so the simulated answer is the real one. `multi_select` is EXCLUDED
 *     deliberately: a worker may tap two chips and the resulting answer is not any single option's
 *     value, so a per-option prediction would be right most of the time and quietly wrong the rest
 *     — the worst available behaviour.
 *   - Free text is excluded for the same reason: the value cannot be known before it is typed, and
 *     any item whose `ask_if` reads that field would branch on a value we invented.
 *   - `declined` is included for every ask, because "nahi pata" has no value to guess.
 *   - Depth 1, never recursive: predicting two taps ahead multiplies the branches and compounds
 *     the chance of being wrong.
 */

import type { QuestionPackItem, QuestionPackOption } from "@badabhai/ai-contracts";

import { recordAnswer, recordDeclined, type AnswerMap } from "./answer-map";
import {
  CLOSING_REPLY_TEXT,
  nextQuestion,
  type Decision,
  type EngineState,
  type EnginePacks,
} from "./next-question";

/**
 * The key a `declined` branch is filed under.
 *
 * Double-underscored so it cannot collide with an `option_key`, which the pack validator
 * constrains to `^[a-z0-9_]+$` — a key starting with `__` is unreachable through authoring.
 */
export const LOOKAHEAD_DECLINED = "__declined";

/**
 * Ceiling on branches computed per turn.
 *
 * Each branch is one `nextQuestion` call over the pack's items — microseconds, no I/O — so the
 * cost being bounded is the RESPONSE SIZE, not the CPU. Every entry carries a prompt, a why-text
 * and its options, and this rides on every turn of every interview to a device on 2G. Six covers
 * the shipped corpus's select questions with room to spare; beyond that the client can wait a
 * round trip.
 */
export const LOOKAHEAD_MAX_BRANCHES = 6;

/** One predicted turn: what the worker would see next if they answered this way. */
export interface LookaheadEntry {
  /** Null when the prediction is that the interview ENDS. */
  readonly questionKey: string | null;
  readonly kind: "ask" | "close";
  readonly promptText: string;
  readonly whyText: string | null;
  /**
   * Typed as the item's own `answer_type` rather than `string`, so a surface projecting this into
   * a closed enum (the voice form's `ProfilingQuestionSchema`) is checked at compile time rather
   * than at the Zod boundary, where the failure would be a 500 mid-interview.
   */
  readonly answerType: QuestionPackItem["answer_type"] | null;
  readonly options: readonly QuestionPackOption[];
  readonly progress: { readonly answered: number; readonly total: number };
}

/** `option_key` (or {@link LOOKAHEAD_DECLINED}) → the turn it would produce. */
export type Lookahead = Readonly<Record<string, LookaheadEntry>>;

/**
 * Everything the simulation needs, all of which the orchestrator already has in hand.
 *
 * `state` MUST be the POST-turn state — the one carrying this turn's incremented `engineAsks` and
 * `askCounts` — because that is what the next turn will actually start from. Handing the pre-turn
 * state instead would predict against a budget one ask too generous, and the divergence would
 * appear only near the end of an interview, which is the hardest place to notice it.
 */
export interface LookaheadInput {
  readonly decision: Decision;
  readonly state: EngineState;
  readonly packs: EnginePacks;
  readonly items: readonly QuestionPackItem[];
  /** The turn number the NEXT turn will carry. */
  readonly nextTurn: number;
}

/**
 * Predict the next turn for each answer the worker could give, or `null` when prediction is not
 * exact enough to be worth making.
 *
 * PURE. It calls `nextQuestion` and the answer-map recorders, all of which return new values
 * rather than mutating — so this cannot perturb the real turn it is running alongside. That
 * property is asserted directly by the tests, because a lookahead that corrupted engine state
 * would be far worse than no lookahead at all.
 */
export function computeLookahead(input: LookaheadInput): Lookahead | null {
  const { decision, state, packs, items, nextTurn } = input;

  // ONLY AN ASK IS PREDICTABLE. A `close` has no next turn; a `disambiguate` is answered against a
  // retrieval offer rather than a pack item, so its "options" are not pack options and the engine
  // is not what resolves them; a `clarify` re-serves what is already on screen, so there is
  // nothing new to render early.
  if (decision.kind !== "ask" || decision.questionKey === null) return null;

  const item = items.find((candidate) => candidate.question_key === decision.questionKey);
  if (!item) return null;

  const entries: Record<string, LookaheadEntry> = {};

  // Declining is exact for every question — there is no value to guess.
  entries[LOOKAHEAD_DECLINED] = project(
    nextQuestion(
      { ...state, turn: nextTurn, answers: recordDeclined(state.answers, item.question_key, nextTurn), ...ANSWERED_TURN },
      packs,
    ),
    items,
  );

  if (item.answer_type === "single_select") {
    for (const option of item.options.slice(0, LOOKAHEAD_MAX_BRANCHES)) {
      const answers: AnswerMap = recordAnswer(
        state.answers,
        {
          questionKey: item.question_key,
          targetField: item.target_field,
          // The label is what a worker's answer READS as; the option's typed value is what the
          // engine stores. Both are the pack's own reviewed content — no worker text is involved,
          // which is what keeps this branch free of anything that would need masking.
          valueRaw: option.label_text,
          // `?? option.label_text` mirrors `answer-capture`'s own fallback: an option with all
          // three typed value columns null answers with its label. Using `??` and not `||` is
          // load-bearing — `false` and `0` are answers.
          valueNormalized: option.value ?? option.label_text,
          evidence: null,
        },
        nextTurn,
      );
      entries[option.option_key] = project(
        nextQuestion({ ...state, turn: nextTurn, answers, ...ANSWERED_TURN }, packs),
        items,
      );
    }
  }

  return entries;
}

/**
 * The counters a turn CARRYING AN ANSWER resets.
 *
 * Not cosmetic: `clarifyCount`, `silentTurns` and `hardshipTurns` are all documented as
 * consecutive runs broken by a real answer, and `needsDisambiguation` cannot still be set on a
 * turn that answered a pack question. Leaving any of them at their current value would predict
 * against a state the next turn will never be in — for instance letting a stale `hardshipTurns`
 * push the simulation over `MAX_CONSECUTIVE_HARDSHIP`.
 */
const ANSWERED_TURN = {
  clarifyCount: 0,
  silentTurns: 0,
  hardshipTurns: 0,
  needsDisambiguation: false,
} as const;

/** A decision → the wire-ready entry, resolving the item for its shape fields. */
function project(decision: Decision, items: readonly QuestionPackItem[]): LookaheadEntry {
  const item =
    decision.questionKey === null
      ? undefined
      : items.find((candidate) => candidate.question_key === decision.questionKey);
  const closing = decision.kind === "close";
  return {
    questionKey: decision.questionKey,
    kind: closing ? "close" : "ask",
    // `nextQuestion` returns an EMPTY `promptText` on the close branch — the closing line is the
    // ORCHESTRATOR's, substituted at `decide`. Predicting an empty string here would have the
    // client render a blank bubble on the last tap of every completed interview, which is exactly
    // the failure `decide`'s own "refusing to serve an empty reply" guard exists to prevent. The
    // same constant is used, so the predicted close and the real one cannot drift.
    promptText: closing ? CLOSING_REPLY_TEXT : decision.promptText,
    whyText: item?.why_text ?? null,
    answerType: item?.answer_type ?? null,
    options: decision.options,
    progress: decision.progress,
  };
}
