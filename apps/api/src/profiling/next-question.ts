/**
 * The deterministic question-selecting state machine. PURE: `(state, packs) -> Decision`.
 *
 * NO DI, NO I/O, NO CLOCK, NO RANDOMNESS. That is the single most important structural choice in
 * Phase 5, and it buys three things that are otherwise expensive:
 *
 * - the whole engine is property-testable ("same answers ⇒ same next question, always") without a
 *   database, a Redis, or a Nest test module;
 * - the CAS loser can safely RE-RUN the decision against post-winner state, because re-running has
 *   no side effects to undo;
 * - a hard case is a test, not a staging session.
 *
 * PORTED FROM `apps/ai-service/app/job_posting_chat/interview_engine.py`, algorithm AND comments —
 * those comments encode bugs already paid for. It is a SIBLING, not a parameterization: the two
 * conversations have different tone, literacy and vocabulary, and the reference file's own header
 * insists on that separation.
 */

import type {
  ProfilingPhase,
  QuestionPack,
  QuestionPackItem,
  QuestionPackOption,
} from "@badabhai/ai-contracts";

import type { AnswerMap } from "./answer-map";
import { isSettled } from "./answer-map";
import { isQuestionEligible, type EvaluationContext } from "./predicate";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * THE SAFETY PROPERTY of the re-ask. "Answered" is judged by a local detector, and a detector can
 * be wrong; an UNBOUNDED re-ask would loop a worker who is answering perfectly well in a phrasing
 * we cannot read. So a question is asked at most this many times — and the bound holds even if
 * detection is TOTALLY BLIND, which the test suite locks with a stubbed detector.
 *
 * A pack item may lower this per question via `max_asks`; it may never raise it above the ceiling.
 */
export const MAX_ASKS_PER_QUESTION = 2;

/**
 * Final backstop, counted in ENGINE ASKS — deliberately NOT in turns, because a clarify advances
 * the turn count while serving no new question, so a turn-based budget would let a confused worker
 * silently delete questions from the TAIL of the interview. Engine asks only ever grow where a
 * question is actually served, so the budget is clarify-immune by construction.
 *
 * Sized with real headroom over the worst-case blind run, and the test suite pins that arithmetic
 * against the constant rather than restating the number — so the zero-margin coupling cannot
 * silently reappear when a pack grows.
 */
export const MAX_ENGINE_ASKS = 24;

/**
 * Max CONSECUTIVE re-serves of one question after a worker asks back ("job milegi kya?"). The
 * question-back detector has false-positive classes, so an unbounded re-serve could loop; past
 * this the turn falls through to ordinary selection and the interview moves on.
 */
export const MAX_CONSECUTIVE_CLARIFIES = 2;

/**
 * Abusive turns before the interview closes. The message is still buffered — the audit stays
 * honest — but flagged so it never reaches the model.
 */
export const MAX_ABUSIVE_TURNS = 3;

/**
 * Silent or one-character turns before the engine advances past the question on screen. Consumes
 * a TURN, not an ASK: a worker whose keyboard is failing has not refused to answer.
 */
export const MAX_SILENT_TURNS = 3;

/**
 * Max CONSECUTIVE hardship acknowledgements before the interview moves on anyway.
 *
 * Acknowledging hardship without pushing a question is right — a worker describing a hard month
 * is not refusing to answer — but it is the one turn class that advances NOTHING: no ask, no
 * counter, no phase. Left unbounded it is an interview that can never end, and the hardship
 * detector's patterns are the most permissive in the lexicon, so reaching this bound by accident
 * is realistic rather than theoretical.
 */
export const MAX_CONSECUTIVE_HARDSHIP = 2;

/**
 * The final turn backstop, DERIVED rather than guessed.
 *
 * Every turn is one of exactly four things: it serves an ask (bounded by MAX_ENGINE_ASKS), it is
 * one of a bounded run of clarifies / silences / hardship acknowledgements attached to the
 * question on screen, or it is abusive (bounded by MAX_ABUSIVE_TURNS, which closes). Multiplying
 * the per-ask allowance by the ask budget therefore BOUNDS the whole interview — and because it
 * is computed from those constants, tightening any one of them tightens this automatically
 * instead of leaving a stale number behind.
 *
 * `MAX_SILENT_TURNS - 1`: the last silence in a run is what makes the engine ADVANCE, so it is
 * already counted as the ask-consuming turn rather than as a free one.
 */
export const MAX_ENGINE_TURNS =
  MAX_ENGINE_ASKS *
    (1 + MAX_CONSECUTIVE_CLARIFIES + (MAX_SILENT_TURNS - 1) + MAX_CONSECUTIVE_HARDSHIP) +
  MAX_ABUSIVE_TURNS;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * The engine's view of the conversation. Deliberately NOT the wire contract: the orchestrator
 * projects `ConversationState` into this, so a wire-format change cannot reach the pure core and
 * the core's tests never construct a Zod object.
 */
export interface EngineState {
  readonly phase: ProfilingPhase;
  readonly turn: number;
  readonly engineAsks: number;
  /** `question_key` → times ASKED. Clamped on read; see {@link askCount}. */
  readonly askCounts: Readonly<Record<string, number>>;
  readonly answers: AnswerMap;
  readonly occupation: EvaluationContext["occupation"];
  /** The question currently on screen, for the re-serve path. */
  readonly servedQuestionKey: string | null;
  readonly clarifyCount: number;
  readonly abusiveTurns: number;
  readonly silentTurns: number;
  /** CONSECUTIVE hardship acknowledgements. Reset by any turn that carries an answer. */
  readonly hardshipTurns: number;
  /** True once retrieval has offered choices the worker has not yet resolved. */
  readonly needsDisambiguation: boolean;
}

/** The two packs in play. `occupation` is null until the occupation is pinned. */
export interface EnginePacks {
  readonly occupation: QuestionPack | null;
  readonly universal: QuestionPack;
}

export type DecisionKind = "ask" | "disambiguate" | "clarify" | "close";

export interface Decision {
  readonly kind: DecisionKind;
  /** Null only when closing. */
  readonly questionKey: string | null;
  readonly promptText: string;
  readonly options: readonly QuestionPackOption[];
  /** The phase AFTER this decision — the orchestrator persists this, never computes its own. */
  readonly phase: ProfilingPhase;
  /** Set only when `kind === "close"`. */
  readonly completionReason: CompletionReason | null;
  /** `{answered, total}` — the biggest completion-rate lever for low-literacy workers. */
  readonly progress: { readonly answered: number; readonly total: number };
  /** True when this decision RE-serves the question already on screen. */
  readonly isReserve: boolean;
}

export const COMPLETION_REASONS = [
  "complete",
  "ask_budget",
  "turn_cap",
  "abuse_cap",
  "no_pack",
] as const;
export type CompletionReason = (typeof COMPLETION_REASONS)[number];

// ---------------------------------------------------------------------------
// Ask accounting
// ---------------------------------------------------------------------------

/**
 * How many times `questionKey` has been ASKED.
 *
 * CLAMPED AT 0: state arrives as jsonb from Redis and may have been written by an older build or
 * mutated in-process after validation, so a stored `-1` would otherwise buy extra asks and defeat
 * the bound outright. The safety property must not depend on the caller having validated.
 *
 * A question with any record floors at 1, so a state persisted before `askCounts` existed cannot
 * hand a question a fresh budget — the bound errs toward asking LESS.
 */
export function askCount(state: EngineState, questionKey: string): number {
  const counted = Math.max(0, Math.trunc(state.askCounts[questionKey] ?? 0));
  if (counted === 0 && state.answers[questionKey] !== undefined) return 1;
  return counted;
}

/** The ceiling for one item: its own `max_asks`, never above the engine's. */
export function askCeiling(item: QuestionPackItem): number {
  return Math.min(Math.max(1, item.max_asks), MAX_ASKS_PER_QUESTION);
}

/**
 * The exact wording served for `item` on its `askNumber`-th ask.
 *
 * ONE source of truth for "which string did the worker actually see", so the ask path and the
 * re-serve path can never disagree — re-serving the ORIGINAL wording after the retry wording was
 * shown reads as the assistant going backwards.
 */
export function servedText(item: QuestionPackItem, askNumber: number): string {
  if (askNumber > 1 && item.retry_text) return item.retry_text;
  return item.prompt_text;
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

function contextOf(state: EngineState): EvaluationContext {
  return {
    answers: state.answers,
    occupation: state.occupation,
    phase: state.phase,
    turn: state.turn,
  };
}

/**
 * Is this item servable right now?
 *
 * `min_turn`/`max_turn` are how momentum-versus-loss-aversion is expressed as DATA rather than as
 * a special case in the engine: `current_city` and `salary_expected` are the strongest matching
 * signals and must survive abandonment, so a pack hoists them into the middle of the occupation
 * block with `min_turn`. Moving a question is a pack edit, not a code change.
 */
function isServable(item: QuestionPackItem, state: EngineState, answers: AnswerMap): boolean {
  if (isSettled(answers, item.question_key)) return false;
  if (askCount(state, item.question_key) >= askCeiling(item)) return false;
  if (item.min_turn !== null && state.turn < item.min_turn) return false;
  if (item.max_turn !== null && state.turn > item.max_turn) return false;
  // A follow-up (depth 1) is only reachable once its parent has a usable answer. The pack
  // validator rejects cycles and depth > 1, so one hop is the whole rule.
  if (item.parent_item_key !== null && answers[item.parent_item_key]?.status !== "answered") {
    return false;
  }
  return isQuestionEligible(item.ask_if, item.skip_if, contextOf(state));
}

/**
 * Pick the next item in STRICT priority order.
 *
 * 1. An unanswered MANDATORY item under its ask ceiling — its first ask or its bounded re-ask.
 * 2. Any other unanswered CORE item never asked (ask-once).
 * 3. Any other unanswered item never asked (ask-once).
 *
 * TWO INVARIANTS HOLD IN EVERY BRANCH, and the property tests assert them directly:
 *
 * - **A settled question is never returned.** Every branch runs through {@link isServable}.
 * - **No question is returned once asked its ceiling times**, whatever detection does — the bound
 *   is a pure function of {@link askCount}, which clamps at 0, so it holds for every state and not
 *   only for validated ones.
 */
function selectItem(
  items: readonly QuestionPackItem[],
  state: EngineState,
): QuestionPackItem | null {
  const ordered = [...items].sort((a, b) => a.display_order - b.display_order);
  const servable = ordered.filter((item) => isServable(item, state, state.answers));

  return (
    servable.find((item) => item.is_mandatory) ??
    servable.find((item) => item.is_core && askCount(state, item.question_key) === 0) ??
    servable.find((item) => askCount(state, item.question_key) === 0) ??
    null
  );
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

function progressOf(items: readonly QuestionPackItem[], answers: AnswerMap) {
  // Counts SETTLED over servable-in-principle, so a declined question advances the bar. A worker
  // who says "nahi pata" has made progress; a bar that disagreed would be telling them otherwise.
  const total = items.length;
  const answered = items.filter((item) => isSettled(answers, item.question_key)).length;
  return { answered, total };
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

function close(reason: CompletionReason, total: number, answered: number): Decision {
  return {
    kind: "close",
    questionKey: null,
    promptText: "",
    options: [],
    phase: "close",
    completionReason: reason,
    progress: { answered, total },
    isReserve: false,
  };
}

/**
 * The next thing to do, given the state and the packs. Pure.
 *
 * PHASE ORDER: `identify → disambiguate → occupation_specific → universal_tail → close`, each with
 * an explicit exit condition. The engine owns every transition; nothing else may write `phase`.
 *
 * OCCUPATION-SPECIFIC QUESTIONS COME BEFORE UNIVERSAL ONES, and that ordering is a product
 * decision with evidence behind it: workers answer about their own trade fluently, and opening
 * with salary has the highest measured abandon rate. The universal block is the tail precisely
 * because it is the part a worker is most likely to walk away from.
 */
export function nextQuestion(state: EngineState, packs: EnginePacks): Decision {
  const allItems = [...(packs.occupation?.items ?? []), ...packs.universal.items];
  const { answered, total } = progressOf(allItems, state.answers);

  // --- Hard bounds, checked before anything else can serve a question ------
  if (state.abusiveTurns >= MAX_ABUSIVE_TURNS) {
    return close("abuse_cap", total, answered);
  }
  if (state.engineAsks >= MAX_ENGINE_ASKS) {
    return close("ask_budget", total, answered);
  }
  // The derived turn backstop. Unreachable while every non-advancing turn class respects its own
  // bound — which is exactly why it is here: it is the wall that holds when one of them does not.
  if (state.turn > MAX_ENGINE_TURNS) {
    return close("turn_cap", total, answered);
  }

  // --- IDENTIFY / DISAMBIGUATE -------------------------------------------
  // Both are driven by retrieval, not by the pack: until an occupation is pinned there is no
  // occupation pack to serve from. The universal pack alone is not enough to run an interview
  // worth having, so `no_pack` closes rather than silently degrading to generic questions.
  if (state.needsDisambiguation) {
    return {
      kind: "disambiguate",
      questionKey: null,
      promptText: "",
      options: [],
      phase: "disambiguate",
      completionReason: null,
      progress: { answered, total },
      isReserve: false,
    };
  }

  const phase: ProfilingPhase = packs.occupation ? "occupation_specific" : "identify";

  // --- Selection ----------------------------------------------------------
  const occupationItem = packs.occupation ? selectItem(packs.occupation.items, state) : null;
  if (occupationItem) {
    return serve(occupationItem, state, phase, { answered, total });
  }

  const universalItem = selectItem(packs.universal.items, state);
  if (universalItem) {
    return serve(universalItem, state, "universal_tail", { answered, total });
  }

  // Drained: every question is settled, out of asks, or ineligible.
  return close("complete", total, answered);
}

function serve(
  item: QuestionPackItem,
  state: EngineState,
  phase: ProfilingPhase,
  progress: { answered: number; total: number },
): Decision {
  const askNumber = askCount(state, item.question_key) + 1;
  return {
    kind: "ask",
    questionKey: item.question_key,
    promptText: servedText(item, askNumber),
    options: item.options,
    phase,
    completionReason: null,
    progress,
    isReserve: askNumber > 1,
  };
}

/**
 * Re-serve the question already on screen after a worker asks back — "job milegi kya?".
 *
 * Serves the question's `why_text` and then the SAME question again. **Never counts as an ask**:
 * the worker asked a reasonable question and deserves an answer, not a spent budget. Bounded at
 * {@link MAX_CONSECUTIVE_CLARIFIES}; past that this returns null and the caller falls through to
 * ordinary selection.
 */
export function clarify(state: EngineState, packs: EnginePacks): Decision | null {
  if (state.servedQuestionKey === null) return null;
  if (state.clarifyCount >= MAX_CONSECUTIVE_CLARIFIES) return null;

  const items = [...(packs.occupation?.items ?? []), ...packs.universal.items];
  const item = items.find((candidate) => candidate.question_key === state.servedQuestionKey);
  if (!item) return null;

  const { answered, total } = progressOf(items, state.answers);
  return {
    kind: "clarify",
    questionKey: item.question_key,
    // why_text FIRST, then the question is re-served by the orchestrator on the same turn.
    promptText: item.why_text ?? servedText(item, askCount(state, item.question_key)),
    options: item.options,
    phase: state.phase,
    completionReason: null,
    progress: { answered, total },
    isReserve: true,
  };
}

// ---------------------------------------------------------------------------
// Served text
// ---------------------------------------------------------------------------

/**
 * The fixed replies the engine serves directly, belonging to no pack.
 *
 * HERE RATHER THAN ON THE SERVICES THAT USE THEM, so that enumerating everything a worker can
 * hear does not require booting Nest. `reply-closure.ts` feeds a batch TTS renderer; importing
 * `orchestrator.service.ts` for a string constant pulled the entire DI graph — repositories,
 * Redis, the occupation ladder — into a process whose whole job is to read JSON and hash text.
 *
 * Re-exported from their original modules, so every existing import site is unchanged.
 */

/** The fixed de-escalation line. ONE line, never varied — see the orchestrator's note. */
export const DE_ESCALATION_REPLY_TEXT =
  "Aap se vinamra rehne ki request hai. Kaam ki baat karte hain.";

/** The closed appreciation set for a hardship turn, indexed by turn — never at random. */
export const HARDSHIP_REPLY_TEXTS = [
  "Samajh sakta hoon. Aapki baat sahi hai.",
  "Aapki mehnat samajh aati hai. Thoda aur batayiye.",
  "Theek hai. Aaram se batayiye, koi jaldi nahi.",
] as const;

/** Served when the interview ends normally. */
export const CLOSING_REPLY_TEXT = "Aapki baat poori ho chuki hai. Profile taiyaar ho rahi hai.";

/** The disambiguation question, verbatim — asked ABOUT the packs, so it lives in none of them. */
export const DISAMBIGUATION_PROMPT_TEXT = "Aap in mein se kaun sa kaam karte hain?";

/**
 * `why_text`, then the question again — one message, because the client renders one bubble.
 *
 * `servedText`, NOT `prompt_text`, AND THAT IS A FIX RATHER THAN A STYLE CHOICE. The silent-turn
 * branch of the orchestrator carries a comment explaining that re-serving raw `prompt_text` walks
 * the interview BACKWARDS to the opening wording after the retry wording has already been served
 * — and then this function did exactly that. A worker who has been re-asked once (so they are
 * looking at `retry_text`) and then asks "yeh kyun poochh rahe ho?" got the explanation followed
 * by the ORIGINAL phrasing, which reads as the app forgetting the last thing it said. In a voice
 * form it is worse: they cannot scroll back to check, they just hear the question change shape.
 *
 * Blast radius today is five items — `retry_text` is authored on 5 of 466 — which is exactly why
 * it survived. The plan calls for ~20 hand-authored retries plus 8 answer-type templates.
 *
 * `Pick`, because this reads one field: a whole `Decision` would force `replyClosure` to fabricate
 * seven fields it has no opinion about just to ask what the join produces.
 */
export function joinClarify(
  decision: Pick<Decision, "promptText">,
  askedItem: QuestionPackItem | null,
  askNumber: number,
): string {
  const why = decision.promptText;
  const question = askedItem ? servedText(askedItem, askNumber) : "";
  if (!question || why === question) return why;
  return `${why} ${question}`;
}

