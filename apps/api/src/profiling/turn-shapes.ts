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

import { DISAMBIGUATION_ESCAPE_KEY, DISAMBIGUATION_ESCAPE_LABEL } from "@badabhai/config";

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
import { TRADE_CONFIRM_OPTIONS, TRADE_DESIRED_PROMPT, tradeConfirmPrompt } from "./trade-confirm";
import { FORM_OFFER_OPTIONS, offerPrompt } from "./trade-form-offer";

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
 * The trade-form offer, still on screen for a session being REOPENED (#2245).
 *
 * THE FIFTH MEMBER OF THE SAME PRECEDENCE. The offer belongs to no pack, and until this existed it
 * was redrawn only by {@link outstandingLlmAsk} replaying `lastTurn` — which reads nothing once
 * `leads()` is false. Two offers are served with `leads()` false: the one served on the turn Phase
 * A falls back, and the one served on a led `done`. A cold start on either re-served a pack
 * question while the offer stayed pending, so the worker's next "haan" to that question was read
 * as accepting the form; and `viewSession` reported no chips, so a voice-form tap on
 * `form_offer_yes` was refused as an unknown option.
 *
 * REBUILT FROM `formOfferPrompt`, not `lastTurn`: the kind is stored precisely so the offer honours
 * the trade it was made for, and the copy is ours — the same line and chips a fresh offer serves.
 */
export function outstandingFormOffer(envelope: ProfilingEnvelope): {
  prompt: string;
  options: readonly QuestionPackOption[];
  answerType: AnswerType;
} | null {
  const pending = envelope.formOfferPrompt;
  if (pending?.state !== "pending") return null;
  return {
    prompt: offerPrompt(pending.kind),
    options: [...FORM_OFFER_OPTIONS],
    answerType: "single_select",
  };
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
 * Whether a closed-option select may hide the composer.
 *
 * THE SAFE SETS ONLY (owner ruling 2026-10-20): a locked turn takes away the typed "nahi
 * pata", so a select is locked only when a chip says it for the worker — an `is_none_of_above`
 * option (availability's "Abhi pata nahi"). The 310 selects without one (education,
 * salary_period, languages, …) keep the composer: locking them would trap a worker who does
 * not know into picking or abandoning, against the "Nahi pata is a complete answer" law.
 * Booleans, numbers and free text never lock — there is nothing to tap.
 */
export function optionsOnlyForSelect(
  answerType: string | null,
  options: readonly { readonly is_none_of_above: boolean }[],
): boolean {
  return (
    (answerType === "single_select" || answerType === "multi_select") &&
    options.length > 0 &&
    options.some((option) => option.is_none_of_above)
  );
}

/**
 * The server's own "type your own answer" chip (#1506): keyed `kuch_aur` and flagged
 * `is_none_of_above`, so a shipped client renders it as "Kuch aur — khud likhein" and opens the
 * composer, whatever the label says. Never a pack option, so never matched as an answer.
 */
export const TYPED_ESCAPE_OPTION: QuestionPackOption = {
  option_key: DISAMBIGUATION_ESCAPE_KEY,
  label_text: DISAMBIGUATION_ESCAPE_LABEL,
  value: DISAMBIGUATION_ESCAPE_LABEL,
  implies_skill_id: null,
  is_none_of_above: true,
};

/**
 * The chips a pack question is SERVED with: its own, plus the typed escape on availability.
 *
 * #2467 (owner ruling 2026-10-28) — availability's chips stop at a month, and a worker with a
 * 3-month notice had nothing to tap ("vahan per koi option nahin tha"). The escape lets them type
 * it; `captureAnswer` reads "3 mahine" / "3 mahine ka notice" as a notice period on that question.
 * Server-side and serve-time only, the precedent the model chips set: no pack version, no seed,
 * and no change to what the pack's own options mean ("Abhi pata nahi" still declines). Every
 * place a pack question is put on screen goes through here, so a re-serve, a replay, the free
 * chat's resume and the edit gate's "sahi … bataiye" all show the same chips.
 */
export function servedOptions(
  item: Pick<QuestionPackItem, "target_field"> | null | undefined,
  options: readonly QuestionPackOption[],
): QuestionPackOption[] {
  if (item?.target_field !== "availability" || options.length === 0) return [...options];
  if (options.some((option) => option.option_key === TYPED_ESCAPE_OPTION.option_key)) return [...options];
  return [...options, TYPED_ESCAPE_OPTION];
}

/**
 * The composer's mode for a pack question on screen — the live-turn twin of
 * {@link optionsOnlyForSelect}, read off the authored row rather than the cached turn.
 */
export function packQuestionInputMode(
  item: Pick<QuestionPackItem, "answer_type" | "options"> | null | undefined,
): InputMode {
  if (!item) return "text";
  return optionsOnlyForSelect(item.answer_type, item.options) ? "options_only" : "text";
}

/**
 * Is the cached turn a résumé-confirm bubble — the identity "Kya ye aap hi hain?" or the
 * batch "Sahi hai?" (the chips, not merely their words)?
 *
 * The replay clamp's allow-list, beside the gates: both bubbles are served `options_only`,
 * and a retried submit must redraw the lock it repeats, not a composer the live turn never
 * offered. Recognised by the first chip's key — the same shape `showsEditConfirm` uses —
 * because the reply embeds the worker's own staged values and cannot be compared.
 */
const RESUME_CONFIRM_BUBBLE_KEYS: ReadonlySet<string> = new Set([
  RESUME_IDENTITY_OPTIONS[0]!.option_key,
  RESUME_CONFIRM_OPTIONS[0]!.option_key,
]);

export function showsResumeConfirmBubble(
  options: readonly { readonly option_key: string }[],
): boolean {
  return options.some((option) => RESUME_CONFIRM_BUBBLE_KEYS.has(option.option_key));
}

/**
 * The identity turn's wire fields, from a resolved line.
 *
 * ONE BUILDER FOR THREE SERVE SITES — the open path's re-serve, its first-turn offer,
 * and the turn path's offer block all render byte-identical bubbles, and a second copy
 * of this literal is how a re-serve would one day disagree with the offer about what
 * "is this you?" says. `ask`, not a new kind (`TURN_KINDS` is pinned to what shipped
 * clients render), `single_select` with the two reviewed chips.
 *
 * `options_only`: the question is genuinely binary (Haan / Nahi) and typed replies stay
 * readable server-side (`readIdentityReply`) — the lock is the affordance, not the contract.
 *
 * #2366 — `facts` are the same `confirmableFacts` the batch-confirm would have served
 * (same import, resolved against the same pack and answers), rendered through
 * `identityPrompt` ahead of the "Kya ye aap hi hain?" question. The chips and the
 * question stay the identity turn's — only the listed information grows, so the Haan/Nahi
 * handling is untouched. Empty by default, so a caller with nothing to confirm serves
 * byte-for-byte the old bubble.
 */
export function identityTurnFields(
  line: IdentitySummary,
  items: readonly QuestionPackItem[],
  answers: AnswerMap,
  progressItems: readonly QuestionPackItem[],
  replayed: boolean,
  facts: readonly ResumeConfirmFact[] = [],
): TurnResult {
  return {
    reply: identityPrompt(
      line,
      facts.map((fact) => fact.display),
    ),
    kind: "ask",
    questionKey: null,
    options: [...RESUME_IDENTITY_OPTIONS],
    whyText: null,
    answerType: "single_select",
    inputMode: "options_only",
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
 * The confirmable facts that belong on an identity bubble (#2366).
 *
 * SAME IMPORT ONLY: the Haan autofills (and labels `resume_upload` for) the identity
 * line's import, so facts staged under any other import must never be listed on its
 * bubble. A `null` pending, an id mismatch, or an empty fact list all read as "no facts"
 * and the caller serves the short bubble exactly as before.
 */
export function identityFactsFor(
  line: IdentitySummary,
  pending: { importId: string; facts: ResumeConfirmFact[] } | null,
): readonly ResumeConfirmFact[] {
  if (!pending || pending.importId !== line.importId) return [];
  return pending.facts;
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
 *
 * `options_only`, like the identity bubble: Haan / Nahi, typed replies still readable
 * server-side (`readConfirmReply`).
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
    inputMode: "options_only",
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
 *
 * #2366 — when an identity turn IS served, the pending import is still read (once) to enrich
 * its bubble with every confirmable fact from the SAME import. The batch-confirm precedence
 * is unchanged: the confirm branch still runs only when no identity turn is served.
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
    // #2366 — the facts the batch-confirm would have listed, same import only
    // (`identityFactsFor` drops any other import's facts). Read here so the "is this
    // you?" bubble lists ALL parsed information on landing; the confirm branch below
    // still owns the batch-confirm turn itself.
    const pending = confirmOf(await reads.pendingImport(), items, answers);
    const facts = identityFactsFor(line, pending);
    return {
      envelope: {
        ...base,
        resumeIdentity: { importId: line.importId, state: "pending" },
        engineAsks: base.engineAsks + 1,
        servedQuestionKey: null,
        clarifyCount: 0,
      },
      fields: identityTurnFields(line, items, answers, progressItems, false, facts),
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
