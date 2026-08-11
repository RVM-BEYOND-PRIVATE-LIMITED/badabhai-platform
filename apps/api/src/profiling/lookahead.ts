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
 * A RE-PIN INVALIDATES EVERY PREDICTION, and this is the known way to get a wrong one (#766 item
 * 3). Predictions are computed against the pack pinned at THIS turn; `identify()` can re-pin the
 * worker's trade on the NEXT turn, and the engine then selects from a different pack entirely, so
 * every entry here is stale the moment that happens. The advisory contract bounds it — the real
 * response replaces the render — but it is stated here so the next reader meets it in the source
 * rather than while debugging a mispredicted turn.
 *
 * The cost is not symmetric across surfaces. On chat a stale prediction is a repaint. On the voice
 * form the client pre-resolves a `tts_clip_id` from it, so a stale prediction is SPOKEN to the
 * worker before the correction lands — and a worker who cannot read the screen has no way to catch
 * it. That asymmetry is why #766 item 4 wants a turn stamp on each entry: it is what would let a
 * client detect staleness instead of trusting the prediction until contradicted.
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

import { captureAnswer } from "./answer-capture";
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
 * Above this many options, the question gets NO per-option prediction at all.
 *
 * A THRESHOLD, NOT A TRUNCATION. Each branch is one `nextQuestion` call over the pack's items —
 * microseconds, no I/O — so what is being bounded is the RESPONSE SIZE, not the CPU: every entry
 * carries a prompt, a why-text and its own options, and this rides on every turn of every
 * interview to a device on 2G.
 *
 * Slicing to the cap would have been the obvious implementation and is the wrong one. Options are
 * authored in display order and `is_none_of_above` — the "kuch aur" escape — goes last by
 * convention, so a truncation drops precisely the chip whose prediction is most worth having, and
 * drops it silently. Declining the whole question instead degrades to the round trip that exists
 * today, which is a behaviour the client already handles.
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

  // NULL-PROTOTYPE, because the keys are AUTHORED CONTENT. `question_pack_option.option_key` is
  // constrained to `^[a-z0-9_]+$`, which permits `__proto__` — and `entries["__proto__"] = x` on an
  // object literal sets the prototype instead of adding a key, silently dropping that branch. A
  // pack reviewer has no reason to know that.
  const entries: Record<string, LookaheadEntry> = Object.create(null) as Record<
    string,
    LookaheadEntry
  >;

  // Declining is exact for every question — there is no value to guess.
  entries[LOOKAHEAD_DECLINED] = project(
    predict(state, packs, recordDeclined(state.answers, item.question_key, nextTurn), nextTurn),
    items,
  );

  // DECLINE TO PREDICT RATHER THAN TRUNCATE. Slicing to the cap would silently drop the tail of
  // the option list — and `is_none_of_above`, the "kuch aur" escape, is authored LAST by
  // convention, so the chip most worth predicting is the first one a truncation loses. A worker
  // tapping it would get a stale render with nothing to explain it, where an absent entry is
  // simply the round trip they have today.
  if (item.answer_type === "single_select" && item.options.length <= LOOKAHEAD_MAX_BRANCHES) {
    for (const option of item.options) {
      // `__declined` IS AUTHORABLE — `^[a-z0-9_]+$` matches it — so an option carrying that key
      // would overwrite the decline branch with an answer branch. Skipped rather than renamed:
      // the collision is a corpus defect worth leaving visible, and dropping one prediction is a
      // round trip while overwriting one is a wrong question.
      if (option.option_key === LOOKAHEAD_DECLINED) continue;

      // THE REAL CAPTURE PATH, not a hand-built answer, and this is the whole correctness of the
      // feature. `captureAnswer` classifies the utterance BEFORE it normalizes: a chip whose label
      // reads as "nahi pata" is recorded DECLINED, and one the item's normalizer refuses (or the
      // negation veto rejects) yields NO value at all — leaving the question unsettled, so the
      // engine RE-SERVES it rather than moving on.
      //
      // Measured against the shipped corpus, 5 of 453 single-select chips do exactly that — and
      // three of them are `qp_universal/relocation`, a question EVERY worker reaches. Simulating a
      // clean `recordAnswer(option.value)` predicted "next question" for all three where the real
      // turn asks the same one again.
      //
      // The label rather than the option key, because the label is what `ProfilingSessionService`
      // turns a tap into (`textFor`) before the turn ever runs — so this is the same string the
      // real capture sees.
      const capture = captureAnswer(option.label_text, item);
      let answers: AnswerMap = state.answers;
      if (capture.declined) {
        answers = recordDeclined(answers, item.question_key, nextTurn);
      } else {
        for (const value of capture.values) answers = recordAnswer(answers, value, nextTurn);
      }
      entries[option.option_key] = project(predict(state, packs, answers, nextTurn), items);
    }
  }

  return entries;
}

/** One simulated turn: the post-turn state, plus this answer, one turn later. */
function predict(
  state: EngineState,
  packs: EnginePacks,
  answers: AnswerMap,
  nextTurn: number,
): Decision {
  return nextQuestion({ ...state, turn: nextTurn, answers, ...ANSWERED_TURN }, packs);
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
