/**
 * THE PROFILING-STAGE FREE CHAT'S TURNS (ADR-0051) — the routing and serving of a free-chat aside,
 * split out of `ProfilingOrchestrator` (#2052) and moved verbatim, with ONE exception:
 * `serveImportOpening` now goes through `importOpening` (`turn-shapes.ts`), the résumé-import
 * opening it shares with the identity intake's handoff.
 *
 * The orchestrator keeps the ONE branch in `decide` that hands a message here, the CAS, and the
 * effects that follow a landed write (the mode-change event, the lock, the served-turn event, the
 * summary's fold). This class decides only: it SERVES the message as an aside or PASSES it to the
 * interview, and is re-run from scratch on a lost CAS like the rest of `decide` — its model calls and
 * résumé reads are memoised on the turn's {@link FreeChatRefs}, declared outside the CAS loop.
 *
 * Built by the orchestrator from services it already holds, only when the free chat is wired, so
 * every construction keeps working without a new parameter.
 *
 * THE MODULE ALSO EXPORTS the free chat's pure pieces the ORCHESTRATOR reads in its greeting opening
 * and its post-CAS effects — `greetingTurn`, `GREETING_SERVED`, `resumeEntry`, `isFreeChatOpen`,
 * `foldsAfter`, `modeChangeOf`, `openRefOf` — so every free-chat shape lives in one place.
 */

import type {
  FreeChatCategory,
  FreeChatDecidedBy,
  FreeChatMode,
  FreeChatModeTrigger,
  FreeChatOutcome,
  FreeChatReplyCategory,
} from "@badabhai/types";
import type { Logger } from "@nestjs/common";
import type {
  FreeChatReplyOutput,
  QuestionPackItem,
  QuestionPackOption,
} from "@badabhai/ai-contracts";
import { classifyUtterance } from "@badabhai/profiling-lexicon";

import { CHAT_UNAVAILABLE_REPLY as UNAVAILABLE_REPLY } from "../../chat/chat-replies";
import type { TranscriptBuffer } from "../../chat/chat-transcript.buffer";
import { captureAnswer, hasFieldNormalizer, matchOptions } from "../answer-capture";
import {
  answersOf,
  stampUniversalPointer,
  toEngineState,
  type ProfilingEnvelope,
} from "../conversation-state";
import { slugIndexKey } from "../identify.service";
import {
  askCount,
  servedText,
  CLOSING_REPLY_TEXT as CLOSING_REPLY,
  DE_ESCALATION_REPLY_TEXT as DE_ESCALATION_REPLY,
  HARDSHIP_REPLY_TEXTS as HARDSHIP_REPLIES,
} from "../next-question";
import type {
  Decided,
  FreeChatTurnInput,
  OpenTurnInput,
  ResolvedPacks,
  TurnInput,
  TurnResult,
} from "../orchestrator.service";
import type { IdentitySummary } from "../resume-import/resume-identity";
import type { ResumeSuggestionReader } from "../resume-import/resume-suggestion-reader";
import {
  essentialsOf,
  importOpening,
  outstandingLlmAsk,
  outstandingOffer,
  outstandingTypeRequest,
  progressOf,
  stampLastTurn,
} from "../turn-shapes";
import { screenFreeChatAnswer } from "./free-chat-output.validator";
import {
  FREE_CHAT_COPY,
  FREE_CHAT_COPY_ENTRIES,
  FREE_CHAT_LATER_KEY,
  FREE_CHAT_LATER_LABEL,
  FREE_CHAT_REFUSAL_LINES,
  FREE_CHAT_RESUME_KEY,
  FREE_CHAT_RESUME_LABEL,
  FREE_CHAT_START_KEY,
  FREE_CHAT_START_LABEL,
  type FreeChatLine,
} from "./free-chat.copy";
import {
  confidenceBucketOf,
  isFreeChatChip,
  isResumeChip,
  matchesDistress,
  matchesOfferedOption,
  postClassifyFree,
  postClassifyResume,
  preClassifyFree,
  preClassifyResume,
  type FreeChatVerdict,
  type ResumeSkipFacts,
} from "./free-chat.router";
import {
  freeChatWorkerContextOf,
  type FreeChatCallContext,
  type FreeChatEventRef,
  type FreeChatModeChange,
  type FreeChatServed,
  type FreeChatService,
} from "./free-chat.service";
import {
  enterMode,
  FREE_CHAT_ASIDE_CAP,
  FREE_CHAT_MAX_CHIP_NO_OPS,
  FREE_CHAT_MAX_DEESCALATIONS,
  FREE_CHAT_MAX_DEFLECTS,
  FREE_CHAT_NUDGE_EVERY,
  pendingKeyOf,
  registerStrike,
  type FreeChatHeldTurn,
  type FreeChatState,
} from "./free-chat.state";

/**
 * The free chat's two model calls and two résumé reads, memoised per `takeTurn` CALL (ADR-0051
 * §3.3) — the orchestrator's `CitySeedRef` shape, for its reason: declared OUTSIDE the CAS loop (in
 * `ProfilingOrchestrator.takeTurn`) and filled inside {@link FreeChatTurns}, so a lost CAS that
 * re-runs the decision reuses the call it already paid for. The spend is recorded inside the call
 * itself, so it is recorded once too.
 */
export interface FreeChatRefs {
  /**
   * KEYED BY ITS INPUTS (the mode and the pending question): a lost CAS whose reload lands on a
   * winner in another mode, or with another question on screen, must classify again rather than
   * reuse a verdict made for a different question.
   */
  classify: { readonly key: string; readonly verdict: Promise<FreeChatVerdict> } | null;
  reply: Promise<FreeChatReplyOutput | null> | null;
  /**
   * The two résumé-import reads (the staged identity line, the pending batch import). They depend
   * only on the worker, so a free-mode turn — which may look for an import at the greeting and
   * again on "Haan" — reads each once, and a lost CAS reads neither again.
   */
  identity: Promise<IdentitySummary | null> | null;
  pendingImport: ReturnType<ResumeSuggestionReader["pendingForChat"]> | null;
}

/** One free-chat turn's working set — what `decide` already resolved, handed to the free chat. */
export interface FreeChatTurn {
  readonly buffer: TranscriptBuffer;
  readonly envelope: ProfilingEnvelope;
  readonly input: TurnInput;
  readonly fc: FreeChatTurnInput;
  readonly service: FreeChatService;
  readonly packs: ResolvedPacks;
  readonly items: readonly QuestionPackItem[];
  readonly progressItems: readonly QuestionPackItem[];
  readonly askedItem: QuestionPackItem | null;
  readonly capped: boolean;
  readonly refs: FreeChatRefs;
}

/**
 * What the free chat made of a message: SERVED it (an aside — the decision is final) or PASSED it
 * to today's interview, with the envelope it may have updated (a mode stamped, a held turn
 * cleared). A pass is today's interview exactly: nothing the classifier said changes how it reads
 * the message.
 */
export type FreeChatRouted =
  | { readonly kind: "serve"; readonly decided: Decided }
  | { readonly kind: "pass"; readonly envelope: ProfilingEnvelope };

/** The event facts a classifier verdict contributes — see `verdictFacts`. */
interface VerdictFacts {
  readonly decidedBy: FreeChatDecidedBy;
  readonly category: FreeChatCategory | null;
  readonly confidenceBucket: FreeChatServed["confidenceBucket"];
}

/** What {@link FreeChatTurns} needs from the orchestrator that builds it. */
export interface FreeChatTurnsDeps {
  /**
   * The staged identity line — the orchestrator's `resolveResumeIdentity`, the ONE resolver every
   * serve site reads it through, so the free chat and the open path can never disagree about it.
   */
  readonly identity: (workerId: string) => Promise<IdentitySummary | null>;
  /** The pending batch import (`ResumeSuggestionReader.pendingForChat`). */
  readonly pendingImport: (
    workerId: string,
  ) => ReturnType<ResumeSuggestionReader["pendingForChat"]>;
  /** `LlmTurnService.leads` — does the model lead this session's questions? */
  readonly leads: (envelope: ProfilingEnvelope) => boolean;
  /** The orchestrator's general-road stamp (ADR-0045 D7), applied where résumé mode is entered. */
  readonly stampGeneralRoad: (envelope: ProfilingEnvelope, input: TurnInput) => ProfilingEnvelope;
  /**
   * The ORCHESTRATOR'S logger, shared on purpose: every line this class writes keeps the
   * `ProfilingOrchestrator` context it had before #2052, so log searches keep working.
   */
  readonly logger: Logger;
}

/** A session with no mode yet, entering résumé mode — the lock — for `trigger`. */
export function resumeEntry(
  trigger: FreeChatModeTrigger,
  at: { readonly now: Date },
): FreeChatState {
  return enterMode(null, "resume", trigger, at.now);
}

export class FreeChatTurns {
  constructor(private readonly deps: FreeChatTurnsDeps) {}

  /**
   * The free chat's ONE ENTRY from `decide` (ADR-0051 §3.2): serve the message as an aside, or
   * pass it to today's interview.
   *
   *   - NO MODE YET (an older client, a session in flight at deploy): stamped `resume` — today's
   *     interview — and routed as résumé mode;
   *   - RÉSUMÉ MODE: the lock; the skip list, then the classifier, and an outage is today's turn;
   *   - GREETING / FREE: the deterministic rules, then the classifier, then a per-category handler.
   *
   * Never reached under the kill switch (see `decide`), which routes and writes nothing.
   */
  async route(t: FreeChatTurn): Promise<FreeChatRouted> {
    const state = t.envelope.freeChat ?? null;
    if (state === null) {
      const trigger: FreeChatModeTrigger = t.fc.sessionLocked ? "locked_at_open" : "first_turn";
      const stamped = resumeEntry(trigger, t.input);
      return this.routeResumeMode(
        { ...t, envelope: { ...t.envelope, freeChat: stamped } },
        stamped,
      );
    }
    if (state.mode === "resume") return this.routeResumeMode(t, state);
    return this.routeFreeMode(t, state);
  }

  /**
   * RÉSUMÉ MODE — today's interview, with an off-topic message deflected (ADR-0051 §3.2, the résumé
   * table). Distress first; then every message today's interview already reads deterministically
   * passes with no model call (the skip list); then the classifier, whose UNAVAILABLE answer also
   * passes — an AI outage never degrades the interview.
   */
  private async routeResumeMode(t: FreeChatTurn, state: FreeChatState): Promise<FreeChatRouted> {
    const pass = (): FreeChatRouted => ({
      kind: "pass",
      // A pass is an interview turn: the question it answers is no longer held for a re-ask.
      envelope:
        state.held === null ? t.envelope : { ...t.envelope, freeChat: { ...state, held: null } },
    });
    const pending = this.pendingQuestion(t, state);
    const skip = this.resumeSkipFacts(t, state, pending);
    const pre = preClassifyResume(t.input.text, skip);
    if (pre.kind === "distress")
      return this.serveResumeDistress(t, state, pending, LEXICON_DISTRESS);
    // A DOUBLE-TAPPED FREE-CHAT CHIP ("Haan, shuru karein" sent twice, a stale "Resume banayein"):
    // a no-op that re-serves the pending question as it stands — never captured, never classified.
    // ONLY where nothing else owns the words: a pending offer, an open gate, the turn cap or an
    // option on screen reads them first (a typed "baad mein" is a real answer to "Resume update
    // kar doon?"). At most twice per pending question; a third passes to the interview.
    if (
      pending !== null &&
      isFreeChatChip(t.input.text) &&
      !skip.capped &&
      !skip.pendingOffer &&
      !skip.gateOpen &&
      !skip.offeredOption
    ) {
      const key = pendingKeyOf(pending);
      const count = state.chipNoOps?.key === key ? state.chipNoOps.count : 0;
      if (count >= FREE_CHAT_MAX_CHIP_NO_OPS) return pass();
      return this.serveNoOp(t, { ...state, chipNoOps: { key, count: count + 1 } }, pending);
    }
    if (pre.kind === "pass" || pending === null) return pass();

    const verdict = await this.classifyMemo(t, "resume", pending);
    const facts = verdictFacts(verdict);
    const action = postClassifyResume(verdict);
    switch (action.kind) {
      case "pass":
        return pass();
      case "de_escalate": {
        // CLASSIFIER-ONLY ABUSE (the lexicon flagged nothing): today's de-escalation line and the
        // question again, NEVER counted toward `MAX_ABUSIVE_TURNS` — a model verdict alone must not
        // close profiling (CLAUDE.md §3). Capped like a deflection: a third trash verdict for the
        // same question passes to the interview, which reads the words deterministically.
        const key = pendingKeyOf(pending);
        const count = state.deescalated?.key === key ? state.deescalated.count : 0;
        if (count >= FREE_CHAT_MAX_DEESCALATIONS) return pass();
        return this.serveReAsk(
          t,
          { ...state, deescalated: { key, count: count + 1 } },
          DE_ESCALATION_REPLY,
          pending,
          facts,
          "fixed_line",
        );
      }
      case "distress":
        return this.serveResumeDistress(t, state, pending, facts);
      case "deflect": {
        // THE STUCK-LOOP GUARD: at most twice per pending question. A worker retyping a real answer
        // the classifier keeps misreading reaches today's interview on the third try.
        const key = pendingKeyOf(pending);
        const count = state.deflected?.key === key ? state.deflected.count : 0;
        if (count >= FREE_CHAT_MAX_DEFLECTS) return pass();
        return this.serveReAsk(
          t,
          { ...state, deflected: { key, count: count + 1 } },
          FREE_CHAT_COPY.LOCK_DEFLECT.latin,
          pending,
          facts,
          "deflected",
        );
      }
      case "clarify":
        // THE CLARIFY CAP: at most once per pending question. A second unsure verdict for the same
        // question is today's interview — the deterministic path — never a clarify loop.
        if (state.clarifiedFor === pendingKeyOf(pending)) return pass();
        return this.serveReAsk(
          t,
          { ...state, clarifiedFor: pendingKeyOf(pending) },
          FREE_CHAT_COPY.LOCK_CLARIFY.latin,
          pending,
          facts,
          "clarify",
        );
    }
  }

  /**
   * GREETING AND FREE MODE (ADR-0051 §3.2, the free table). A greeting the worker typed past is
   * answered as free chat, and becomes free mode once a classifier verdict is acted on.
   */
  private async routeFreeMode(t: FreeChatTurn, state: FreeChatState): Promise<FreeChatRouted> {
    const { text, now } = t.input;
    // AN UPLOADED RÉSUMÉ IS RÉSUMÉ INTENT. A pending import (an unanswered "is this you?" line, or a
    // batch-confirm with facts to confirm) enters résumé mode and is served now, rather than hidden
    // behind "Haan" — after distress, which outranks everything.
    if (!matchesDistress(text)) {
      const imported = await this.serveImportOpening(
        t,
        { ...t.envelope, freeChat: enterMode(state, "resume", "resume_import", now) },
        servedFacts("resume", FLOW_RESUME_FACTS, "opener"),
      );
      if (imported !== null) return imported;
    }
    const pre = preClassifyFree({
      mode: state.mode === "greeting" ? "greeting" : "free",
      text,
      state,
      now,
    });
    switch (pre.kind) {
      case "start":
        return this.serveStart(t, CHIP_FACTS, "chip");
      case "later":
        return this.serveFreeLine(
          t,
          enterMode(state, "free", "chip", now),
          FREE_CHAT_COPY.LATER_ACK,
          RESUME_CHIPS,
          { decidedBy: "chip", category: null, confidenceBucket: null },
          "fixed_line",
        );
      case "distress":
        return this.serveFreeLine(
          t,
          state,
          FREE_CHAT_COPY.DISTRESS,
          [],
          LEXICON_DISTRESS,
          "fixed_line",
        );
      case "cooldown":
        return this.serveFreeLine(
          t,
          state,
          FREE_CHAT_COPY.TRASH_COOLDOWN,
          RESUME_CHIPS,
          GUARD_FACTS,
          "cooldown",
        );
      case "aside_cap":
        return this.serveFreeLine(
          t,
          state,
          FREE_CHAT_COPY.ASIDE_CAP,
          RESUME_CHIPS,
          GUARD_FACTS,
          "aside_cap",
        );
      case "strike":
        return this.serveStrike(t, state, {
          decidedBy: "lexicon",
          category: "trash",
          confidenceBucket: null,
        });
      case "classify":
        break;
    }

    const verdict = await this.classifyMemo(t, "free", null);
    const facts = verdictFacts(verdict);
    const action = postClassifyFree(verdict, text);
    const acted = action.kind !== "clarify" && action.kind !== "start";
    const current =
      state.mode === "greeting" && acted ? enterMode(state, "free", "classifier", now) : state;
    switch (action.kind) {
      case "clarify":
        return this.serveFreeLine(
          t,
          current,
          FREE_CHAT_COPY.FREE_CLARIFY,
          RESUME_CHIPS,
          facts,
          "clarify",
        );
      case "start":
        // A message that already describes the work is the interview's first answer; a bare
        // intent ("resume banana hai") gets the opener.
        return action.firstTurn ? this.passAsFirstTurn(t) : this.serveStart(t, facts, "classifier");
      case "reply":
        return this.serveReply(t, current, action.category, facts);
      case "fixed":
        return this.serveFreeLine(
          t,
          current,
          FREE_CHAT_COPY[action.line],
          action.line === "DISTRESS" ? [] : RESUME_CHIPS,
          facts,
          "fixed_line",
        );
      case "strike":
        return this.serveStrike(t, current, facts);
    }
  }

  /** The facts that decide whether résumé mode classifies a message at all. */
  private resumeSkipFacts(
    t: FreeChatTurn,
    state: FreeChatState,
    pending: FreeChatHeldTurn | null,
  ): ResumeSkipFacts {
    const env = t.envelope;
    return {
      capped: t.capped,
      pendingOffer:
        env.resumeUpdateOffer?.state === "pending" ||
        env.resumeIdentity?.state === "pending" ||
        env.resumeConfirm?.state === "pending" ||
        env.formOfferPrompt?.state === "pending",
      // THE SKILLS GATE BY ITS STATE, not by what `lastTurn` cached: a distress line served over an
      // open gate replaces it on screen, and the worker's next words are still the gate's answer.
      gateOpen: env.llmGateOpen || env.generalRoad.gateOpen,
      offeredOption: matchesOfferedOption(t.input.text, env.lastTurn?.options ?? []),
      lexiconClass: classifyUtterance(t.input.text).cls,
      typedAnswer: isTypedAnswer(t.input.text, t.askedItem),
      hasPendingQuestion: pending !== null,
      asideCapReached: state.asides >= FREE_CHAT_ASIDE_CAP,
    };
  }

  /**
   * The interview question a résumé-mode aside re-asks: what the envelope's own state names (it
   * cannot go stale), else the turn held by an earlier aside, else what `lastTurn` shows.
   */
  private pendingQuestion(t: FreeChatTurn, state: FreeChatState): FreeChatHeldTurn | null {
    return (
      structuredQuestion(t.envelope, t.progressItems, t.buffer.turnCount) ??
      state.held ??
      lastServedQuestion(t.envelope, this.deps.leads(t.envelope))
    );
  }

  /** Enter résumé mode and serve the session's next opening (the worker's "Haan"). */
  private serveStart(
    t: FreeChatTurn,
    facts: VerdictFacts,
    trigger: FreeChatModeTrigger,
  ): Promise<FreeChatRouted> {
    const entered: ProfilingEnvelope = {
      ...t.envelope,
      freeChat: enterMode(t.envelope.freeChat ?? null, "resume", trigger, t.input.now),
    };
    return this.serveOpening(t, entered, servedFacts("resume", facts, "opener"));
  }

  /**
   * The session's NEXT OPENING once résumé mode is entered — `ProfilingOrchestrator.intakeHandoff`'s order, through
   * the same resolvers and builders: the résumé "is this you?" turn, else the batch-confirm, else the
   * OPENER. The two résumé turns are their own lines (stored unflagged, an ask spent, the general
   * road left unarmed — a session that opens on a résumé turn keeps today's interview); the opener
   * is an aside that ARMS the general road exactly as today's first message would (ADR-0045 D7).
   */
  private async serveOpening(
    t: FreeChatTurn,
    entered: ProfilingEnvelope,
    served: FreeChatServed,
  ): Promise<FreeChatRouted> {
    const imported = await this.serveImportOpening(t, entered, served);
    if (imported !== null) return imported;
    const answers = answersOf(entered);
    const opener = openerTurn(progressOf(t.progressItems, answers), essentialsOf(t.items, answers));
    const state = entered.freeChat;
    const held =
      state === null ? entered : { ...entered, freeChat: { ...state, held: heldOf(opener) } };
    return this.serveAside(t, this.deps.stampGeneralRoad(held, t.input), opener, served, true);
  }

  /**
   * The résumé-import half of {@link serveOpening}: the "is this you?" turn, else the batch-confirm
   * with something to confirm — or null when no import is pending. Shared by "Haan" and by a
   * pending import found while the session is still in greeting or free mode.
   */
  private async serveImportOpening(
    t: FreeChatTurn,
    entered: ProfilingEnvelope,
    served: FreeChatServed,
  ): Promise<FreeChatRouted | null> {
    const { workerId } = t.input;
    const { deps } = this;
    // Memoised on the turn's refs: a free-mode turn may look for an import at the greeting and again
    // on "Haan", and a lost CAS reads neither again.
    const opening = await importOpening(
      entered,
      {
        identity: () => (t.refs.identity ??= deps.identity(workerId)),
        pendingImport: () => (t.refs.pendingImport ??= deps.pendingImport(workerId)),
      },
      t.items,
      t.progressItems,
    );
    return opening === null
      ? null
      : this.serveAside(t, opening.envelope, opening.fields, served, false);
  }

  /**
   * A free-mode message classified `resume` that already describes the work: résumé mode is
   * entered and the SAME message passes to today's interview as its first answer — not an aside,
   * and armed for the general road exactly as today's first message is.
   */
  private passAsFirstTurn(t: FreeChatTurn): FreeChatRouted {
    const entered: ProfilingEnvelope = {
      ...t.envelope,
      freeChat: enterMode(t.envelope.freeChat ?? null, "resume", "classifier", t.input.now),
    };
    return { kind: "pass", envelope: this.deps.stampGeneralRoad(entered, t.input) };
  }

  /** A counted trash strike (R13): the warning, or — the third today — the cool-down. */
  private serveStrike(t: FreeChatTurn, state: FreeChatState, facts: VerdictFacts): FreeChatRouted {
    const strike = registerStrike(state, t.input.now);
    return this.serveFreeLine(
      t,
      strike.state,
      strike.cooldownStarted ? FREE_CHAT_COPY.TRASH_COOLDOWN : FREE_CHAT_COPY.TRASH_WARN,
      RESUME_CHIPS,
      { ...facts, category: "trash" },
      strike.cooldownStarted ? "cooldown" : "strike",
      { strikeCount: strike.count, cooldownStarted: strike.cooldownStarted },
    );
  }

  /**
   * A casual or career message (ADR-0051 §3.2, rules 6-7): the model's reply through the
   * deterministic gate, its refusal as reviewed copy, or the fallback line. The "Resume banayein"
   * chip is always attached, and every third casual reply carries the nudge (R9).
   */
  private async serveReply(
    t: FreeChatTurn,
    state: FreeChatState,
    category: FreeChatReplyCategory,
    facts: VerdictFacts,
  ): Promise<FreeChatRouted> {
    const out = await this.replyMemo(t, category);
    if (out === null) {
      return this.serveFreeLine(
        t,
        state,
        FREE_CHAT_COPY.REPLY_FALLBACK,
        RESUME_CHIPS,
        facts,
        "fallback",
      );
    }
    if (out.status === "refuse") {
      return this.serveFreeLine(
        t,
        state,
        FREE_CHAT_REFUSAL_LINES[out.topic],
        out.topic === "distress" ? [] : RESUME_CHIPS,
        facts,
        "refused",
        { refusalTopic: out.topic },
      );
    }
    const screened = screenFreeChatAnswer(out);
    if (screened.kind === "reject") {
      // The CLOSED reason only — never a line of the answer, which is model text.
      this.deps.logger.warn(
        `free-chat reply rejected session=${t.input.sessionId} category=${category} ` +
          `(${screened.failure}); the fallback line is served`,
      );
      return this.serveFreeLine(
        t,
        state,
        FREE_CHAT_COPY.REPLY_FALLBACK,
        RESUME_CHIPS,
        facts,
        "fallback",
      );
    }
    const casualReplies = state.casualReplies + (category === "casual" ? 1 : 0);
    const nudge = category === "casual" && casualReplies % FREE_CHAT_NUDGE_EVERY === 0;
    const lines = nudge
      ? [...screened.answer.lines, FREE_CHAT_COPY.CASUAL_NUDGE.latin]
      : [...screened.answer.lines];
    const answers = answersOf(t.envelope);
    const result: TurnResult = {
      ...freeTurnResult(
        lines.join("\n"),
        followupOptions(screened.answer.followup_chips),
        progressOf(t.progressItems, answers),
        essentialsOf(t.items, answers),
      ),
      // MODEL-WRITTEN: never read aloud, and no Devanagari twin exists for it (R17).
      readAloud: false,
    };
    return this.serveAside(
      t,
      { ...t.envelope, freeChat: { ...state, casualReplies } },
      result,
      servedFacts(state.mode, facts, "answered", { nudge }),
      true,
      true,
      // ADR-0051 §8 (R22) — the ONE exchange the rolling summary may fold: the worker's message and
      // the model-written reply. Every fixed line, fallback and refusal above is not foldable.
      true,
    );
  }

  /** One fixed line (plus its chips) as an aside, in the state the turn leaves behind. */
  private serveFreeLine(
    t: FreeChatTurn,
    state: FreeChatState,
    line: FreeChatLine,
    chips: readonly QuestionPackOption[],
    facts: VerdictFacts,
    outcome: FreeChatOutcome,
    extra: ServedExtra = {},
  ): FreeChatRouted {
    const answers = answersOf(t.envelope);
    const result = freeTurnResult(
      line.latin,
      chips,
      progressOf(t.progressItems, answers),
      essentialsOf(t.items, answers),
    );
    return this.serveAside(
      t,
      { ...t.envelope, freeChat: state },
      result,
      servedFacts(state.mode, facts, outcome, extra),
    );
  }

  /**
   * A résumé-mode deflection, clarify or de-escalation: the lead line + the pending question again,
   * in ONE bubble,
   * with the question's own chips and shape — so `lastTurn` describes the question still on screen
   * and every reader of it (the option match, the escape tap, a reopen) keeps working. No turn, no
   * ask, no model state is spent; `servedQuestionKey` is untouched, so the next answer is captured
   * against the same question.
   */
  private serveReAsk(
    t: FreeChatTurn,
    state: FreeChatState,
    lead: string,
    pending: FreeChatHeldTurn,
    facts: VerdictFacts,
    outcome: FreeChatOutcome,
  ): FreeChatRouted {
    const answers = answersOf(t.envelope);
    const result: TurnResult = {
      reply: `${lead} ${pending.reply}`,
      kind: pending.kind,
      questionKey: pending.questionKey,
      options: [...pending.options],
      whyText: pending.whyText,
      answerType: pending.answerType,
      inputMode: pending.inputMode,
      progress: progressOf(t.progressItems, answers),
      unansweredEssentials: essentialsOf(t.items, answers),
      complete: false,
      completionReason: null,
      replayed: false,
      excludeFromParse: true,
      unavailable: false,
      checkpointDue: false,
    };
    return this.serveAside(
      t,
      { ...t.envelope, freeChat: { ...state, held: pending } },
      result,
      servedFacts("resume", facts, outcome),
    );
  }

  /**
   * The distress line in résumé mode (R10): served ALONE — no question is pressed on a worker who
   * has just said this — and the pending question stays held, so the interview resumes on the next
   * message exactly where it paused.
   */
  private serveResumeDistress(
    t: FreeChatTurn,
    state: FreeChatState,
    pending: FreeChatHeldTurn | null,
    facts: VerdictFacts,
  ): FreeChatRouted {
    const answers = answersOf(t.envelope);
    const result = freeTurnResult(
      FREE_CHAT_COPY.DISTRESS.latin,
      [],
      progressOf(t.progressItems, answers),
      essentialsOf(t.items, answers),
    );
    return this.serveAside(
      t,
      { ...t.envelope, freeChat: { ...state, held: pending } },
      result,
      servedFacts("resume", facts, "fixed_line"),
    );
  }

  /**
   * A double-tapped free-chat chip in résumé mode: the pending question re-served as it stands. An
   * aside that counts only toward its own cap (`chipNoOps` — not the aside cap, not a deflect,
   * clarify or de-escalation count) and records no served-turn event — nothing was decided.
   */
  private serveNoOp(
    t: FreeChatTurn,
    state: FreeChatState,
    pending: FreeChatHeldTurn,
  ): FreeChatRouted {
    const answers = answersOf(t.envelope);
    const result: TurnResult = {
      reply: pending.reply,
      kind: pending.kind,
      questionKey: pending.questionKey,
      options: [...pending.options],
      whyText: pending.whyText,
      answerType: pending.answerType,
      inputMode: pending.inputMode,
      progress: progressOf(t.progressItems, answers),
      unansweredEssentials: essentialsOf(t.items, answers),
      complete: false,
      completionReason: null,
      replayed: false,
      excludeFromParse: true,
      unavailable: false,
      checkpointDue: false,
    };
    return this.serveAside(
      t,
      { ...t.envelope, freeChat: { ...state, held: pending } },
      result,
      null,
      true,
      false,
    );
  }

  /** Count the aside, stamp the pack pointer, and append the two flagged lines. */
  private serveAside(
    t: FreeChatTurn,
    next: ProfilingEnvelope,
    result: TurnResult,
    served: FreeChatServed | null,
    replyIsAside = true,
    counts = true,
    foldable = false,
  ): FreeChatRouted {
    const state = next.freeChat ?? null;
    const counted =
      state === null || !counts
        ? next
        : { ...next, freeChat: { ...state, asides: state.asides + 1 } };
    const pinned = stampUniversalPointer(
      { ...counted, packId: t.packs.packId, packVersion: t.packs.packVersion },
      t.packs.engine.universal,
    );
    const turned = this.asideTurn(t.buffer, pinned, t.input, result, replyIsAside, foldable);
    return { kind: "serve", decided: served === null ? turned : { ...turned, freeChat: served } };
  }

  /** The classifier call, memoised per `takeTurn` (see {@link FreeChatRefs}). */
  private classifyMemo(
    t: FreeChatTurn,
    mode: "free" | "resume",
    pending: FreeChatHeldTurn | null,
  ): Promise<FreeChatVerdict> {
    const key = `${mode}|${pending === null ? "" : pendingKeyOf(pending)}`;
    if (t.refs.classify === null || t.refs.classify.key !== key) {
      t.refs.classify = {
        key,
        verdict: t.service.classify(
          {
            text: t.input.text,
            mode,
            pendingQuestion: pending?.reply ?? null,
            messages: t.buffer.messages,
          },
          callCtxOf(t.input),
        ),
      };
    }
    return t.refs.classify.verdict;
  }

  /**
   * The reply call, memoised per `takeTurn` (see {@link FreeChatRefs}). It alone reads the rolling
   * summary (R24); a thunk that throws or rejects anyway costs the summary, never the reply.
   */
  private replyMemo(
    t: FreeChatTurn,
    category: FreeChatReplyCategory,
  ): Promise<FreeChatReplyOutput | null> {
    t.refs.reply ??= (async () =>
      t.service.reply(
        {
          category,
          text: t.input.text,
          messages: t.buffer.messages,
          workerContext: freeChatWorkerContextOf(t.envelope),
          summary: await Promise.resolve()
            .then(() => t.fc.summary?.() ?? null)
            .catch(() => null),
        },
        callCtxOf(t.input),
      ))();
    return t.refs.reply;
  }

  /**
   * `ProfilingOrchestrator.intakeTurn`'s sibling for a free-chat ASIDE, and the same three properties:
   *
   *   - `turnCount` IS NOT BUMPED — an aside spends none of the interview's turns, asks or model
   *     state, so `min_turn` windows and `MAX_ENGINE_TURNS` are exactly what they are without one;
   *   - BOTH LINES ARE KEPT VERBATIM for the worker's thread and flagged `aside`, which keeps them
   *     out of every reader of the conversation's meaning — except a résumé turn served on "Haan",
   *     which is that turn's own line and is stored as it always was;
   *   - `lastTurn` IS STAMPED THE SAME WAY, so a duplicate submit replays the reply unchanged.
   */
  private asideTurn(
    buffer: TranscriptBuffer,
    envelope: ProfilingEnvelope,
    input: TurnInput,
    result: TurnResult,
    replyIsAside: boolean,
    foldable: boolean,
  ): { buffer: TranscriptBuffer; result: TurnResult } {
    const at = input.now.toISOString();
    // ADR-0051 §8 — ABSENT, never false, on every line that is not a casual/career exchange.
    const fold = foldable ? { foldable: true as const } : {};
    return {
      buffer: {
        ...buffer,
        messages: [
          ...buffer.messages,
          {
            role: "worker" as const,
            text: input.text,
            at,
            voiceNoteId: input.voiceNoteId,
            aside: true,
            ...fold,
          },
          {
            role: "assistant" as const,
            text: result.reply,
            at,
            voiceNoteId: null,
            ...(replyIsAside ? { aside: true as const, ...fold } : {}),
          },
        ],
        profiling: stampLastTurn(envelope, input, result),
      },
      result,
    };
  }
}

// ---------------------------------------------------------------------------
// THE PROFILING-STAGE FREE CHAT (ADR-0051) — the pure halves of its turns
// ---------------------------------------------------------------------------

/** A free-chat chip in the shape the client already renders — the label IS what it posts back. */
function chipOption(key: string, label: string): QuestionPackOption {
  return {
    option_key: key,
    label_text: label,
    value: label,
    implies_skill_id: null,
    is_none_of_above: false,
  };
}

const START_OPTION = chipOption(FREE_CHAT_START_KEY, FREE_CHAT_START_LABEL);
const LATER_OPTION = chipOption(FREE_CHAT_LATER_KEY, FREE_CHAT_LATER_LABEL);
const RESUME_OPTION = chipOption(FREE_CHAT_RESUME_KEY, FREE_CHAT_RESUME_LABEL);
/** "Resume banayein" — attached to every free-mode line but the opener and distress (R9). */
const RESUME_CHIPS: readonly QuestionPackOption[] = [RESUME_OPTION];
/** The persona's chip ceiling: the model's follow-ups plus "Resume banayein". */
const FREE_CHAT_MAX_CHIPS = 4;

/**
 * The model's follow-up chips, then "Resume banayein". KEYED `fcq_a`, `fcq_b`… through
 * {@link slugIndexKey}: digit-free slugs, so `narrowLastTurn` keeps them on a replay, never `llm_*`
 * (the interview's model chips) and never an app-reserved key. A model chip that IS the résumé
 * chip is dropped rather than shown twice.
 */
function followupOptions(chips: readonly string[]): QuestionPackOption[] {
  const kept = chips.filter((chip) => !isResumeChip(chip)).slice(0, FREE_CHAT_MAX_CHIPS - 1);
  return [...kept.map((chip, i) => chipOption(slugIndexKey("fcq", i), chip)), RESUME_OPTION];
}

/** The extras one served turn may carry beyond its verdict facts. */
type ServedExtra = Partial<
  Pick<FreeChatServed, "refusalTopic" | "strikeCount" | "cooldownStarted" | "nudge">
>;

/** One served turn's event facts — every field the payload's refines read, defaulted honestly. */
function servedFacts(
  mode: FreeChatMode,
  facts: VerdictFacts,
  outcome: FreeChatOutcome,
  extra: ServedExtra = {},
): FreeChatServed {
  return {
    mode,
    ...facts,
    outcome,
    refusalTopic: null,
    strikeCount: null,
    cooldownStarted: false,
    nudge: false,
    ...extra,
  };
}

/** The greeting, as opened — decided by the flow itself, with no category. */
export const GREETING_SERVED: FreeChatServed = servedFacts(
  "greeting",
  { decidedBy: "flow", category: null, confidenceBucket: null },
  "greeting",
);
/** A chip (or a typed Haan) decided it — the start chip's category is `resume`. */
const CHIP_FACTS: VerdictFacts = { decidedBy: "chip", category: "resume", confidenceBucket: null };
/** A deterministic pre-emption decided it (the cool-down, the cap). */
const GUARD_FACTS: VerdictFacts = { decidedBy: "guard", category: null, confidenceBucket: null };
/** The flow itself decided it: a pending résumé import found at the greeting or in free mode. */
const FLOW_RESUME_FACTS: VerdictFacts = {
  decidedBy: "flow",
  category: "resume",
  confidenceBucket: null,
};

/**
 * Does a served turn feed the rolling summary (ADR-0051 §8)? Only a free-mode casual or career
 * reply the model wrote and the gate passed — `answered`. A fallback, a refusal, a fixed line and
 * every résumé-mode aside never fold.
 */
export function foldsAfter(served: FreeChatServed): boolean {
  return (
    served.mode === "free" &&
    served.outcome === "answered" &&
    (served.category === "casual" || served.category === "career")
  );
}

/** A free chat still in greeting or free mode — before résumé mode, the lock. */
export function isFreeChatOpen(envelope: ProfilingEnvelope | null | undefined): boolean {
  const mode = envelope?.freeChat?.mode;
  return mode === "greeting" || mode === "free";
}

/** The distress word list decided it. */
const LEXICON_DISTRESS: VerdictFacts = {
  decidedBy: "lexicon",
  category: "distress",
  confidenceBucket: null,
};

/**
 * What a classifier answer contributes to the event: a REAL verdict is `classifier` with its
 * category and bucket (recorded even below the floor); an unavailable one is `fallback` with
 * neither — the payload's refine allows a bucket only when the classifier decided.
 */
function verdictFacts(verdict: FreeChatVerdict): VerdictFacts {
  return verdict.kind === "unavailable"
    ? { decidedBy: "fallback", category: null, confidenceBucket: null }
    : {
        decidedBy: "classifier",
        category: verdict.category,
        confidenceBucket: confidenceBucketOf(verdict.confidence),
      };
}

/**
 * A free-chat line as a turn. `ask` with no question key (the line belongs to no pack), the chips
 * as a single-select when there are any, and typing always open — the worker may always type.
 */
function freeTurnResult(
  reply: string,
  options: readonly QuestionPackOption[],
  progress: { readonly answered: number; readonly total: number },
  unansweredEssentials: readonly string[],
): TurnResult {
  return {
    reply,
    kind: "ask",
    questionKey: null,
    options: [...options],
    whyText: null,
    answerType: options.length > 0 ? "single_select" : "text",
    inputMode: "text",
    progress,
    unansweredEssentials: [...unansweredEssentials],
    complete: false,
    completionReason: null,
    replayed: false,
    excludeFromParse: true,
    unavailable: false,
    checkpointDue: false,
  };
}

/** The greeting with its two chips (ADR-0051 §5.1). */
export function greetingTurn(
  progress: { readonly answered: number; readonly total: number },
  unansweredEssentials: readonly string[],
): TurnResult {
  return freeTurnResult(
    FREE_CHAT_COPY.GREETING.latin,
    [START_OPTION, LATER_OPTION],
    progress,
    unansweredEssentials,
  );
}

/** The first résumé question after "Haan" — the composite opener, as an aside. */
function openerTurn(
  progress: { readonly answered: number; readonly total: number },
  unansweredEssentials: readonly string[],
): TurnResult {
  return freeTurnResult(FREE_CHAT_COPY.OPENER.latin, [], progress, unansweredEssentials);
}

/** A served turn, held for a later re-ask. */
function heldOf(result: TurnResult): FreeChatHeldTurn {
  return {
    reply: result.reply,
    kind: result.kind === "disambiguate" ? "disambiguate" : "ask",
    questionKey: result.questionKey,
    options: [...result.options],
    answerType: result.answerType,
    whyText: result.whyText,
    inputMode: result.inputMode ?? "text",
  };
}

/**
 * Replies that put NO question on screen — re-serving one as "the pending question" would answer a
 * deflection with a de-escalation or a closing line. A pending question resolved to one of these is
 * no pending question at all, and the message passes to the interview.
 */
const NON_QUESTION_REPLIES: ReadonlySet<string> = new Set([
  DE_ESCALATION_REPLY,
  ...HARDSHIP_REPLIES,
  CLOSING_REPLY,
  UNAVAILABLE_REPLY,
  // ADR-0051 — every free-chat fixed line but the OPENER (a real interview question): the
  // helpline, the cap, the strikes, the per-category lines, the clarify and deflect leads.
  ...FREE_CHAT_COPY_ENTRIES.filter(([key]) => key !== "OPENER").map(([, line]) => line.latin),
]);

/**
 * The leads a résumé-mode re-ask puts in front of the question. A cached reply that STARTS with
 * one is a re-ask bubble, not a question — re-serving it would stack a lead on a lead.
 */
const RE_ASK_LEADS: readonly string[] = [
  FREE_CHAT_COPY.LOCK_DEFLECT.latin,
  FREE_CHAT_COPY.LOCK_CLARIFY.latin,
  DE_ESCALATION_REPLY,
].map((lead) => `${lead} `);

function isReAskable(reply: string): boolean {
  return (
    reply.trim().length > 0 &&
    !NON_QUESTION_REPLIES.has(reply) &&
    !RE_ASK_LEADS.some((lead) => reply.startsWith(lead))
  );
}

/**
 * THE INTERVIEW QUESTION ON SCREEN THAT THE ENVELOPE'S OWN STATE NAMES — the disambiguation offer,
 * the type-your-trade prompt, the pack question (narrowed to what the engine still selects): the
 * precedence `ProfilingOrchestrator.openTurn` re-serves a reopened session under, so a deflection re-asks exactly
 * what a reopen would redraw. Read FIRST, before any held turn, because it cannot go stale: a held
 * turn is a copy, while this is the state the next answer will be captured against.
 */
function structuredQuestion(
  envelope: ProfilingEnvelope,
  progressItems: readonly QuestionPackItem[],
  turnCount: number,
): FreeChatHeldTurn | null {
  const offer = outstandingOffer(envelope);
  if (offer) {
    return {
      reply: offer.prompt,
      kind: "disambiguate",
      questionKey: null,
      options: offer.options,
      answerType: "single_select",
      whyText: null,
      inputMode: "text",
    };
  }
  const typePrompt = outstandingTypeRequest(envelope);
  if (typePrompt) {
    return {
      reply: typePrompt.prompt,
      kind: "ask",
      questionKey: null,
      options: [],
      answerType: typePrompt.answerType,
      whyText: null,
      inputMode: "text",
    };
  }
  const served = progressItems.find((item) => item.question_key === envelope.servedQuestionKey);
  if (served) {
    return {
      reply: servedText(served, askCount(toEngineState(envelope, turnCount), served.question_key)),
      kind: "ask",
      questionKey: served.question_key,
      options: [...served.options],
      answerType: served.answer_type,
      whyText: served.why_text ?? null,
      inputMode: "text",
    };
  }
  return null;
}

/**
 * THE QUESTION ON SCREEN THAT ONLY `lastTurn` KNOWS — the model's question (it belongs to no pack)
 * or the bare line the intake's handoff served. Read only when no held turn exists: an aside
 * re-stamps `lastTurn`, which is why the first aside holds this copy for the ones after it. Null
 * when nothing is on screen (a session's first message) or what is on screen is not a question
 * (a de-escalation, a hardship line) — and then no aside is served: the interview answers it.
 */
function lastServedQuestion(envelope: ProfilingEnvelope, leads: boolean): FreeChatHeldTurn | null {
  const asked = outstandingLlmAsk(envelope, leads);
  if (asked) {
    return isReAskable(asked.prompt)
      ? {
          reply: asked.prompt,
          kind: "ask",
          questionKey: null,
          options: [...asked.options],
          answerType: asked.answerType,
          whyText: null,
          inputMode: "text",
        }
      : null;
  }
  const last = envelope.lastTurn;
  if (
    last !== null &&
    last.kind !== "close" &&
    last.questionKey === null &&
    isReAskable(last.reply)
  ) {
    return {
      reply: last.reply,
      kind: last.kind === "disambiguate" ? "disambiguate" : "ask",
      questionKey: null,
      options: [...last.options],
      answerType: last.answerType,
      whyText: last.whyText,
      inputMode: "text",
    };
  }
  return null;
}

/**
 * A TYPED answer to the question on screen — a number, a yes/no, a field with a real parser, or a
 * select whose option the words match. Today's capture reads these deterministically, so résumé
 * mode never sends them to the classifier. A free-text question is never "typed": its capture would
 * take any sentence, off-topic included, which is exactly what the classifier is for.
 */
function isTypedAnswer(text: string, item: QuestionPackItem | null): boolean {
  if (item === null) return false;
  if (
    (item.answer_type === "single_select" || item.answer_type === "multi_select") &&
    matchOptions(item, text).length > 0
  ) {
    return true;
  }
  const typed =
    hasFieldNormalizer(item.target_field) ||
    item.answer_type === "number" ||
    item.answer_type === "boolean";
  return typed && captureAnswer(text, item).values.length > 0;
}

/**
 * The mode transition between two states, or null. The greeting is opened by the flow (no
 * trigger) and is not a recorded change; every other entry carries the trigger that caused it.
 */
export function modeChangeOf(
  before: FreeChatState | null,
  after: FreeChatState | null,
): FreeChatModeChange | null {
  if (after === null || after.trigger === null || after.mode === "greeting") return null;
  const from = before?.mode ?? null;
  if (from === after.mode) return null;
  return { from, to: after.mode, trigger: after.trigger };
}

/** The attribution an opening's free-chat events carry — no submission behind an opening. */
export function openRefOf(input: OpenTurnInput): FreeChatEventRef {
  return {
    workerId: input.workerId,
    sessionId: input.sessionId,
    submissionId: null,
    turnRef: "open",
    ctx: input.ctx,
  };
}

/** What a free-chat model call carries — the session's ids and the worker's name, for G2. */
function callCtxOf(input: TurnInput): FreeChatCallContext {
  return {
    workerId: input.workerId,
    sessionId: input.sessionId,
    correlationId: input.ctx.correlationId,
    requestId: input.ctx.requestId,
    knownName: input.knownName,
  };
}
