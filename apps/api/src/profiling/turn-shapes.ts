/**
 * The shapes a profiling turn is built from, shared by the orchestrator and the free chat's turns
 * (#2052).
 *
 * MOVED, NOT REWRITTEN: every function here but one was a module function or a stateless method
 * of `ProfilingOrchestrator`, carried over verbatim and still pure. The exception is NEW:
 * `importOpening`, the résumé-import opening the two callers each used to copy, which reads the
 * résumé through the thunks its caller passes. All of them live here so the orchestrator and
 * `FreeChatTurns` build the same bubbles through the same code. Its own module so the free chat
 * can reach them without a VALUE import of the orchestrator, which imports the free chat (a cycle
 * under CommonJS: see the orchestrator's note on `CHAT_UNAVAILABLE_REPLY`). Types come from the
 * orchestrator, type-only.
 */

import type {
  AnswerType,
  InputMode,
  QuestionPackItem,
  QuestionPackOption,
} from "@badabhai/ai-contracts";

import { isSettled, type AnswerMap } from "./answer-map";
import { answersOf, inboundHash, type ProfilingEnvelope } from "./conversation-state";
import { chatServableItems } from "./facts/worker-fact.ownership";
import { DISAMBIGUATION_PROMPT, IDENTIFY_TYPE_PROMPT, toPackOption } from "./identify.service";
import type { TurnInput, TurnResult } from "./orchestrator.service";
import {
  confirmableFacts,
  confirmPrompt,
  RESUME_CONFIRM_OPTIONS,
  type ResumeConfirmFact,
} from "./resume-confirm";
import {
  identityPrompt,
  RESUME_IDENTITY_OPTIONS,
  type IdentitySummary,
} from "./resume-import/resume-identity";
import type {
  ResumeSuggestion,
  ResumeSuggestionReader,
} from "./resume-import/resume-suggestion-reader";
import {
  TRADE_CONFIRM_OPTIONS,
  TRADE_DESIRED_PROMPT,
  tradeConfirmPrompt,
} from "./trade-confirm";

/**
 * The reply cache's stamp for a turn that is about to be written — `ProfilingOrchestrator`'s
 * `turn` and `intakeTurn` both stamp through this, so an intake turn replays exactly as any other.
 *
 * `lastTurn` is recorded against the rev this write PRODUCES, because that is the rev the
 * retrying reader will load. See the comment on the hash itself.
 */
export function stampLastTurn(
  envelope: ProfilingEnvelope,
  input: TurnInput,
  result: TurnResult,
): ProfilingEnvelope {
  return {
    ...envelope,
    lastTurn: {
      // HASHED AGAINST THE POST-WRITE REV (`rev + 1`), which is what a retry will READ.
      // Hashing against the rev this writer read instead makes every replay MISS: the write
      // bumps the rev, so the retrying reader computes a different key and takes a second real
      // turn on the same words — the exact failure Layer A exists to prevent.
      inboundHash: inboundHash(input.sessionId, envelope.rev + 1, input.text),
      // THE SUBMISSION THAT PRODUCED THIS REPLY (#931). Stamped beside the hash rather than
      // instead of it: the hash still proves the TEXT is identical, and the id decides the
      // VERDICT — see `replayOf`. `null` when this caller had no client submission behind it
      // (an old app build, or the finalize re-drive), which is exactly what makes the stamp
      // fall back to the hash + window path for that turn.
      submissionId: input.submissionId,
      reply: result.reply,
      kind: result.kind,
      questionKey: result.questionKey,
      at: input.now.toISOString(),
      // EVERYTHING THE CLIENT DRAWS, stamped together with the words. Taken off `result` rather
      // than recomputed, so the replayed response is the SAME response by construction and not
      // a second derivation that could disagree with the first.
      options: result.options,
      progress: result.progress,
      whyText: result.whyText,
      answerType: result.answerType,
      // See `LastTurn.formOffer`: the button is the only way out of a handover turn.
      formOffer: result.formOffer ?? null,
      // See `LastTurn.gateKind` / `LastTurn.generalFormOffer` (ADR-0045).
      gateKind: result.gateKind ?? null,
      generalFormOffer: result.generalFormOffer ?? null,
      // #766 item 2 — the prediction rides along, for the reason stated one line up: taken off
      // `result` so the replay is the SAME response rather than a second derivation. Without it
      // a retried submit replayed the words and silently dropped the instant next-question
      // render, on exactly the flaky link that caused the retry.
      lookahead: result.lookahead ?? null,
      inputMode: result.inputMode ?? "text",
      // ADR-0051 — a model-written reply is not read aloud on its replay either. ABSENT otherwise.
      ...(result.readAloud === false ? { readAloud: false as const } : {}),
      // ADR-0054 — an answered news reply's tiles, so its replay shows them. ABSENT otherwise.
      ...(result.newsLinks !== undefined && result.newsLinks.length > 0
        ? { newsLinks: [...result.newsLinks] }
        : {}),
      // A FRESH STAMP. This reply has not been served as a replay yet, so it gets the whole
      // budget — see `LastTurn.replays`.
      replays: 0,
    },
  };
}

/**
 * The chips a reopened session is still waiting on, or null.
 *
 * ONE PRECEDENCE DECISION, SHARED BY BOTH READERS OF A REOPENED SESSION. `viewSession` and
 * `openTurn` each have to answer "what is this worker looking at", and they answered it
 * differently: `viewSession` returned the offer, `openTurn` re-served the stale
 * `servedQuestionKey` — which `identify()`'s offer branch never clears — as an ordinary ask. A
 * worker who reopened mid-offer got the previous pack question, and answering it 409'd against
 * the other reader's view. Two call sites of one rule is how that happened; this is the rule.
 */
export function outstandingOffer(
  envelope: ProfilingEnvelope,
): { prompt: string; options: QuestionPackOption[] } | null {
  if (!envelope.needsDisambiguation || envelope.disambiguationOffer.length === 0) return null;
  return {
    prompt: DISAMBIGUATION_PROMPT,
    options: envelope.disambiguationOffer.map((chip, index) => toPackOption(chip, index)),
  };
}

/**
 * The type-your-trade prompt a reopened session is still waiting on, or null (#1506).
 *
 * THE THIRD MEMBER OF THE SAME PRECEDENCE, and in the same place for the same reason: "Kuch aur"
 * clears the chips, so {@link outstandingOffer} no longer sees anything, while `servedQuestionKey`
 * still names the pack question from before the offer. Both readers must return this ahead of
 * that key or they re-serve — and accept answers to — a question the worker is not looking at.
 */
export function outstandingTypeRequest(
  envelope: ProfilingEnvelope,
): { prompt: string; answerType: AnswerType } | null {
  if (!envelope.identifyTypeRequested || envelope.occupation !== null) return null;
  return { prompt: IDENTIFY_TYPE_PROMPT, answerType: "text" };
}

/**
 * The trade-confirm gate or its re-ask, still on screen for a session being REOPENED.
 *
 * THE FOURTH MEMBER OF THE SAME PRECEDENCE, and in the same place for the same reason:
 * both belong to no pack, so without this a cold start mid-gate re-serves an authored
 * question the worker is not looking at. Rebuilt from envelope state rather than
 * `lastTurn`: the gate prompt embeds the gated trade, and the envelope holds which trade
 * that was.
 */
export function outstandingTradeGate(envelope: ProfilingEnvelope): {
  prompt: string;
  options: readonly QuestionPackOption[];
  answerType: AnswerType;
  inputMode: InputMode;
} | null {
  const gate = envelope.tradeConfirm;
  if (gate.open && gate.trade !== null) {
    return {
      prompt: tradeConfirmPrompt(gate.trade),
      options: [...TRADE_CONFIRM_OPTIONS],
      answerType: "single_select",
      inputMode: "options_only",
    };
  }
  if (gate.reaskOpen && !gate.open) {
    return { prompt: TRADE_DESIRED_PROMPT, options: [], answerType: "text", inputMode: "text" };
  }
  return null;
}

/**
 * The model's question, still on screen, for a session being REOPENED.
 *
 * THE SAME HAZARD `outstandingOffer` EXISTS FOR, and a worse version of it. A model's question
 * belongs to no pack, so `servedQuestionKey` is null for the whole LLM-led stretch — which means
 * the pack re-serve in `openTurn` finds nothing, falls through to `nextQuestion`, and answers a
 * cold start mid-Phase-A by silently serving an authored question instead. The worker's screen
 * would jump from a conversation to a form on every resume-after-kill, and `viewSession` would
 * report `served: null` for the same session at the same moment. Read from `lastTurn` because
 * that is literally what the worker was shown, verbatim, chips included.
 *
 * NULL BEFORE THE MODEL HAS SPOKEN. A brand-new session has `llmAsks: 0` and no gate, so opening
 * still serves pack question one — the model takes over from the worker's first words, which is
 * also the first thing it has anything to respond to.
 */
export function outstandingLlmAsk(
  envelope: ProfilingEnvelope,
  leads: boolean,
): {
  prompt: string;
  options: readonly QuestionPackOption[];
  answerType: AnswerType | null;
} | null {
  if (!leads) return null;
  if (envelope.llmAsks === 0 && !envelope.llmGateOpen && !onSkillsLane(envelope)) return null;
  const last = envelope.lastTurn;
  if (!last || last.reply.trim().length === 0) return null;
  return { prompt: last.reply, options: last.options, answerType: last.answerType };
}

/**
 * Is this session on the general road's skills lane, still before the handover (ADR-0045)?
 * `?.` because an envelope built by a caller that predates the field carries it as undefined.
 */
export function onSkillsLane(envelope: ProfilingEnvelope): boolean {
  const road = envelope.generalRoad;
  return road?.armed === true && road.lane === "skills" && !road.handedOver;
}

/**
 * A pending import, resolved against the pack and the current answers — the body of
 * `resolveResumeConfirm`, shared with the free chat's memoised read. `chatServableItems(items)` is
 * the same shared filter the accept path runs through (#1505 F3), so a résumé's `education` /
 * `salary_expected` / `preferred_locations` suggestions are never offered for confirmation in the
 * chat; only trade/experience/city/availability shrink the batch-confirm bubble.
 */
export function confirmOf(
  offer: { importId: string; suggestions: ReadonlyMap<string, ResumeSuggestion> } | null,
  items: readonly QuestionPackItem[],
  answers: AnswerMap,
): { importId: string; facts: ResumeConfirmFact[] } | null {
  if (!offer) return null;
  const facts = confirmableFacts(offer.suggestions, chatServableItems(items), answers);
  return { importId: offer.importId, facts };
}

/**
 * The identity turn's wire fields, from a resolved line.
 *
 * ONE BUILDER FOR THREE SERVE SITES — the open path's re-serve, its first-turn offer,
 * and the turn path's offer block all render byte-identical bubbles, and a second copy
 * of this literal is how a re-serve would one day disagree with the offer about what
 * "is this you?" says. `ask`, not a new kind (`TURN_KINDS` is pinned to what shipped
 * clients render), `single_select` with the two reviewed chips.
 */
export function identityTurnFields(
  line: IdentitySummary,
  items: readonly QuestionPackItem[],
  answers: AnswerMap,
  progressItems: readonly QuestionPackItem[],
  replayed: boolean,
): TurnResult {
  return {
    reply: identityPrompt(line),
    kind: "ask",
    questionKey: null,
    options: [...RESUME_IDENTITY_OPTIONS],
    whyText: null,
    answerType: "single_select",
    progress: progressOf(progressItems, answers),
    unansweredEssentials: essentialsOf(items, answers),
    complete: false,
    completionReason: null,
    replayed,
    excludeFromParse: false,
    unavailable: false,
    checkpointDue: false,
  };
}

/**
 * The batch-confirm turn's wire fields — "Resume se ye mila: … Sahi hai?" with its two chips.
 *
 * ONE BUILDER FOR FOUR SERVE SITES, for {@link identityTurnFields}'s reason: the open path's
 * first serve and re-serve, the turn path's offer, and the identity intake's handoff (ADR-0048)
 * all render the same bubble, and four hand-copied literals are how one of them would one day
 * drop the chips. `ask`, not a new kind — `TURN_KINDS` is pinned to what shipped clients render,
 * and this IS an ask: a question with two chips, answered like any other single-select. It
 * never crosses a checkpoint: it is an opening move, with nothing yet to checkpoint.
 */
export function confirmTurnFields(
  facts: readonly ResumeConfirmFact[],
  items: readonly QuestionPackItem[],
  answers: AnswerMap,
  progressItems: readonly QuestionPackItem[],
  replayed: boolean,
): TurnResult {
  return {
    reply: confirmPrompt(facts),
    kind: "ask",
    questionKey: null,
    options: [...RESUME_CONFIRM_OPTIONS],
    whyText: null,
    answerType: "single_select",
    progress: progressOf(progressItems, answers),
    unansweredEssentials: essentialsOf(items, answers),
    complete: false,
    completionReason: null,
    replayed,
    excludeFromParse: false,
    unavailable: false,
    checkpointDue: false,
  };
}

/** The two résumé-import reads a session's opening consults, as thunks the caller may memoise. */
export interface ImportOpeningReads {
  /** The staged identity line (`ResumeSuggestionReader.identityForChat`). */
  readonly identity: () => Promise<IdentitySummary | null>;
  /** The pending batch import (`ResumeSuggestionReader.pendingForChat`). */
  readonly pendingImport: () => ReturnType<ResumeSuggestionReader["pendingForChat"]>;
}

/** The résumé-import turn a session opens on: the envelope to write and the bubble to serve. */
export interface ImportOpening {
  readonly envelope: ProfilingEnvelope;
  readonly fields: TurnResult;
}

/**
 * THE RÉSUMÉ-IMPORT HALF OF A SESSION'S NEXT OPENING (#2052) — the "is this you?" turn when a staged
 * identity line has not been asked about, else the batch-confirm when a pending import has
 * something to confirm, else null. ONE ORDER FOR TWO CALLERS: the identity intake's handoff
 * (`ProfilingOrchestrator.intakeHandoff`) and the free chat's opener (`FreeChatTurns`) each used to
 * carry a copy of these two branches. Each turn spends an ask and clears the served key, as it
 * always did; the caller decides how the turn is stored.
 *
 * `base` is the envelope the turn is written from, any mode stamp already applied. The confirm is
 * read only when no identity turn is served and `resumeConfirm` is still null, exactly as both copies read
 * it, so a caller's memoised reads are spent no more often than before.
 */
export async function importOpening(
  base: ProfilingEnvelope,
  reads: ImportOpeningReads,
  items: readonly QuestionPackItem[],
  progressItems: readonly QuestionPackItem[],
): Promise<ImportOpening | null> {
  const answers = answersOf(base);
  const line = await reads.identity();
  if (line !== null && base.resumeIdentity?.importId !== line.importId) {
    return {
      envelope: {
        ...base,
        resumeIdentity: { importId: line.importId, state: "pending" },
        engineAsks: base.engineAsks + 1,
        servedQuestionKey: null,
        clarifyCount: 0,
      },
      fields: identityTurnFields(line, items, answers, progressItems, false),
    };
  }
  if (base.resumeConfirm === null) {
    const pending = confirmOf(await reads.pendingImport(), items, answers);
    if (pending && pending.facts.length > 0) {
      return {
        envelope: {
          ...base,
          resumeConfirm: { importId: pending.importId, state: "pending" },
          engineAsks: base.engineAsks + 1,
          servedQuestionKey: null,
          clarifyCount: 0,
        },
        fields: confirmTurnFields(pending.facts, items, answers, progressItems, false),
      };
    }
  }
  return null;
}

/** The settled share of `items` — the progress bar every turn carries. */
export function progressOf(
  items: readonly QuestionPackItem[],
  answers: AnswerMap,
): { answered: number; total: number } {
  return {
    answered: items.filter((item) => isSettled(answers, item.question_key)).length,
    total: items.length,
  };
}

/**
 * The mandatory questions still unsettled.
 *
 * DECLINED COUNTS AS SETTLED (`isSettled`), and that is the plan's hardest-won rule made
 * concrete: "nahi pata" is a COMPLETE answer. Counting a declination as outstanding here would
 * put it back on the client's essentials list and invite exactly the badgering the engine already
 * refuses to do.
 *
 * Capped at the payload's own limit so this list can never be the thing that fails an emit — the
 * flush transaction carries a sibling of it, and a rejected array there costs the interview.
 */
export function essentialsOf(items: readonly QuestionPackItem[], answers: AnswerMap): string[] {
  return items
    .filter((item) => item.is_mandatory && !isSettled(answers, item.question_key))
    .map((item) => item.question_key)
    .slice(0, 50);
}
