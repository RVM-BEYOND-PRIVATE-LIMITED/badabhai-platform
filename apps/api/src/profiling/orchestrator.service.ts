/**
 * The turn driver — the ONE impure thing in the deterministic interview.
 *
 * Everything that DECIDES is pure and lives elsewhere (`next-question.ts`, `answer-capture.ts`,
 * `predicate.ts`, `answer-map.ts`). This class does only the four things a pure function cannot:
 * read Redis, resolve packs, apply the clock, and win or lose the write.
 *
 * THAT SPLIT IS WHAT MAKES THE CAS RETRY SAFE. A loser reloads and RE-RUNS the whole decision
 * against the winner's state — which is only correct because re-running has no side effects to
 * undo, no accumulated counters, and no memory of the attempt that lost.
 *
 * LIVE AS OF THE PHASE 8 CUTOVER. `ChatService.postMessage` calls {@link takeTurn} where it used
 * to call `AiService.profilingRespond`, and the model-driven path is deleted rather than flagged
 * off. The rollback unit is a `git revert` of that one PR — which is precisely why every deletion
 * landed in it.
 */

import { Injectable, Logger } from "@nestjs/common";
import type {
  AnswerRecord,
  AnswerType,
  QuestionPack,
  QuestionPackItem,
  QuestionPackOption,
} from "@badabhai/ai-contracts";

import { ChatTranscriptBuffer, type TranscriptBuffer } from "../chat/chat-transcript.buffer";
import { ChatRepository } from "../chat/chat.repository";
// FROM THE IMPORT-FREE MODULE, NOT THROUGH `chat.service`. `chat.service` imports this file, so
// reading the constant through its re-export closes a cycle — and under CommonJS the binding
// resolves to `undefined` whenever `chat.service` is required first (measured: the emitted
// `dist/chat/chat.service.js` requires the orchestrator at line 23 and `./chat-replies` only at 29).
// The real boot order happens to load the orchestrator first, so this was latent rather than live;
// `UNAVAILABLE_REPLY` is served straight to a worker on the CAS-lost path, so latent is not a
// comfortable place for it to sit.
import { CHAT_UNAVAILABLE_REPLY } from "../chat/chat-replies";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { catalogVersionForEvent } from "../occupation/occupation.repository";
import { DISAMBIGUATION_PROMPT, IdentifyService, toPackOption } from "./identify.service";
import { captureAnswer, hasFieldNormalizer, mayCommit } from "./answer-capture";
import {
  isSettled,
  recordAnswer,
  recordDeclined,
  recordUnanswered,
  toAnswerArray,
  toAnswerMap,
  toCapturedProjection,
  type AnswerMap,
} from "./answer-map";
import { packAnswerRowFor } from "./pack-answer-row";
import {
  answersOf,
  emptyProfilingEnvelope,
  inboundHash,
  narrowAnswerRecords,
  recordTurnLatency,
  REPLY_CACHE_WINDOW_MS,
  TURN_KINDS,
  toEngineState,
  withAnswers,
  type ProfilingEnvelope,
  type TurnKind,
} from "./conversation-state";
import {
  askCeiling,
  askCount,
  clarify,
  joinClarify,
  nextQuestion,
  servedText,
  CLOSING_REPLY_TEXT,
  DE_ESCALATION_REPLY_TEXT,
  HARDSHIP_REPLY_TEXTS,
  MAX_ABUSIVE_TURNS,
  MAX_CONSECUTIVE_HARDSHIP,
  MAX_ENGINE_TURNS,
  MAX_SILENT_TURNS,
  type CompletionReason,
  type EnginePacks,
} from "./next-question";
import { PackRegistryService } from "./pack-registry.service";

/**
 * The fixed de-escalation line. ONE line, never varied.
 *
 * Varying it would read as an argument; repeating it reads as a boundary. Three of these and the
 * interview closes with `abuse_cap` — the message is still buffered, because the audit stays
 * honest, but it is flagged away from the model.
 *
 * On-persona by the same rules `persona_guard.check_turn` enforces on pack copy: "aap", no
 * vocative, no exclamation, no emoji, under twenty words.
 */
export const DE_ESCALATION_REPLY = DE_ESCALATION_REPLY_TEXT;

/**
 * The closed appreciation set for a hardship turn.
 *
 * A CLOSED SET, and chosen by turn index rather than at random: the engine has no randomness by
 * construction, so the same conversation always produces the same words. Acknowledging without
 * pushing a question is the whole point — a worker describing a hard month is not refusing to
 * answer, and pressing them is the fastest way to lose the interview.
 */
export const HARDSHIP_REPLIES = HARDSHIP_REPLY_TEXTS;

/** Served when the interview ends normally. */
export const CLOSING_REPLY = CLOSING_REPLY_TEXT;

/** Re-exported: the join moved to the pure module so a TTS renderer need not boot Nest. */
export { joinClarify };

/**
 * Served when the CAS could not be won or no pack could be resolved. Nothing was written.
 *
 * THE EXISTING LINE, imported rather than re-typed. Two copies of one worker-facing string drift:
 * the next person to soften the wording changes one of them, and a worker's experience of "the
 * service is busy" then depends on which internal path produced it.
 */
export const UNAVAILABLE_REPLY = CHAT_UNAVAILABLE_REPLY;

/**
 * CAS attempts before giving up.
 *
 * TWO, not "until it succeeds". An unbounded retry against a genuinely hot key is a livelock that
 * burns a request thread; two attempts covers the realistic case (one double-submit) and the
 * third concurrent writer gets an honest "try again" having written nothing.
 */
export const MAX_CAS_ATTEMPTS = 2;

/**
 * Asks between mid-interview Postgres checkpoints (OIE Phase 9, risk #10).
 *
 * REDIS IS THE ONLY HOME OF IN-FLIGHT STATE, and its TTL is 24 h. A lapse — an eviction under
 * memory pressure, a failover, a worker who answers three questions and comes back tomorrow —
 * costs the ENTIRE interview, and the worker is asked everything again from scratch. That is the
 * single worst experience this engine can produce, because it is indistinguishable to the worker
 * from the product being broken.
 *
 * FIVE IS THE COST/LOSS TRADE, not a round number. A ~12-ask interview checkpoints twice, so the
 * write amplification the buffer design exists to avoid (~150 rows per interview, four Postgres
 * writes per turn) does not come back: this is ~2 small UPDATEs of one JSONB column. In exchange
 * the worst-case loss drops from "everything" to "at most the last 4 answers".
 *
 * ASKS, NOT TURNS, and deliberately: a clarify, a hardship acknowledgement and a silent turn all
 * spend a turn without producing an answer, so pacing on turns would checkpoint hardest exactly
 * when there is nothing new to save.
 */
export const CHECKPOINT_EVERY_ASKS = 5;

/** What one turn produced. */
/**
 * Re-exported so {@link TurnResult} reads beside the type it uses. DEFINED in
 * `conversation-state.ts` because `LastTurn` persists it and that module must not import this one.
 */
export { TURN_KINDS, type TurnKind };

export interface TurnResult {
  readonly reply: string;
  /**
   * See {@link TurnKind}. REQUIRED rather than defaulted, so a new construction site cannot ship
   * without stating what it is putting on screen — which is how the disambiguation offer came to
   * be indistinguishable from an ordinary ask in the first place.
   */
  readonly kind: TurnKind;
  readonly questionKey: string | null;
  readonly options: readonly QuestionPackOption[];
  readonly progress: { readonly answered: number; readonly total: number };
  /**
   * `why_text` for the question on screen — the client's ⓘ "yeh kyun poochh rahe hain" affordance.
   *
   * NOT the same thing as a clarify TURN, and the difference matters. A clarify turn happens when
   * the worker ASKS, spends a turn, and gets the explanation read aloud followed by the question
   * again. This field lets the client offer the same explanation on a tap without spending
   * anything — which on a voice surface is the difference between a worker who does not
   * understand a question quietly declining it and one who can find out what it means.
   *
   * Null when the question has no `why_text` (the majority) or when nothing is on screen.
   */
  readonly whyText: string | null;
  /**
   * How the question on screen is ANSWERED — the one thing a client cannot infer from the rest.
   *
   * `options` being empty does not mean "speak your answer": all 236 `boolean` pack items carry
   * ZERO options (measured), so a client keying chips off `options.length` renders a mic for
   * "Kya aapke paas certificate hai?" and then has no path from a spoken "haan" to a stored
   * `true`. `single_select` and `multi_select` differ from each other too — one submit per tap
   * versus accumulate-then-submit. Null when nothing pack-shaped is on screen.
   */
  readonly answerType: AnswerType | null;
  /**
   * MANDATORY pack questions still unsettled — the client's `unanswered_essentials`.
   *
   * Question keys, never values, and never PII: the same `^[a-z_]+$` closed vocabulary the pack
   * validator enforces on every authored row. Empty genuinely means "nothing essential is
   * outstanding" here, which it could not under the LLM path — the model reported a list it had
   * itself invented.
   */
  readonly unansweredEssentials: readonly string[];
  readonly complete: boolean;
  readonly completionReason: CompletionReason | null;
  /** Layer A hit: the previous reply was replayed and NOTHING was written. */
  readonly replayed: boolean;
  /** The turn is buffered for the audit but must never reach the model. */
  readonly excludeFromParse: boolean;
  /** The CAS was lost twice, or no pack resolved. Nothing was written; the worker may retry. */
  readonly unavailable: boolean;
  /**
   * This turn crossed a {@link CHECKPOINT_EVERY_ASKS} boundary — the caller should persist the
   * conversation state to Postgres (OIE Phase 9, risk #10).
   *
   * WHY THE ORCHESTRATOR DECIDES BUT DOES NOT WRITE. It holds the only honest answer — it knows
   * both the pre-turn and post-turn ask count, so it can fire on the CROSSING rather than on the
   * value. A caller testing `engineAsks % 5 === 0` itself would re-fire on every subsequent turn
   * that spends no ask (a clarify, a hardship acknowledgement, a silent turn), which on a stuck
   * conversation is an UPDATE per turn forever. But the write itself belongs to `ChatService`,
   * which owns the repository; giving the orchestrator a Postgres dependency to save one boolean
   * would put durable writes behind the Redis CAS retry loop, where a retried turn would repeat
   * them.
   */
  readonly checkpointDue: boolean;
}

export interface TurnInput {
  readonly sessionId: string;
  readonly workerId: string;
  readonly text: string;
  readonly now: Date;
  /**
   * Correlation for the two occupation events this turn may emit. Threaded through rather than
   * synthesised so a placement can be traced back to the HTTP request that produced it.
   */
  readonly ctx: RequestContext;
}

/**
 * Opening the interview — {@link TurnInput} minus the one thing that does not exist yet.
 *
 * A SEPARATE TYPE rather than `text?: string`, because an optional field would let a caller pass
 * an utterance to a method that ignores it, and "the worker's words were silently dropped" is
 * precisely the failure the voice form cannot afford.
 */
/** The question a worker is looking at right now, and how they can answer it. */
export interface ServedQuestion {
  /** Null on the disambiguation turn, whose chips come from retrieval and belong to no pack. */
  readonly questionKey: string | null;
  /** The wording last SERVED — `retry_text` when the question has been re-asked. */
  readonly promptText: string;
  readonly answerType: AnswerType | null;
  readonly options: readonly QuestionPackOption[];
  readonly whyText: string | null;
  readonly progress: { readonly answered: number; readonly total: number };
}

/** A live interview, read without taking a turn. See {@link ProfilingOrchestrator.viewSession}. */
export interface SessionView {
  readonly buffer: TranscriptBuffer;
  readonly envelope: ProfilingEnvelope;
  /** The pinned pack's rows, occupation first — the review's source of `prompt_text`. */
  readonly items: readonly QuestionPackItem[];
  /** Null when nothing is on screen: a closed interview, or one whose pack no longer resolves. */
  readonly served: ServedQuestion | null;
}

export interface OpenTurnInput {
  readonly sessionId: string;
  readonly workerId: string;
  readonly now: Date;
  readonly ctx: RequestContext;
}

/**
 * A FINISHED interview, read from Postgres rather than from Redis.
 *
 * {@link ProfilingOrchestrator.viewSession} cannot serve this. It loads the transcript buffer, and
 * the buffer is DROPPED the instant the flush transaction commits — which is the same instant the
 * review screen becomes reachable. Every fact here therefore comes from `chat_sessions`: the pack
 * pin from its columns, the answers from `conversation_state.answer_map`.
 */
export interface SettledView {
  readonly packId: string;
  readonly packVersion: number;
  /** The pinned pack's rows, occupation first — the same order the interview served them in. */
  readonly items: readonly QuestionPackItem[];
  readonly answers: AnswerMap;
  /** The whole jsonb column, so a patch can be merged over it rather than rebuilt from parts. */
  readonly state: Record<string, unknown>;
  readonly correctionCount: number;
}

export interface CorrectAnswerInput {
  readonly sessionId: string;
  readonly workerId: string;
  readonly questionKey: string;
  /** The worker's correction AS TEXT — chips already resolved to labels by the caller. */
  readonly text: string;
  /** Which affordance produced it. Recorded on the event; never the value. */
  readonly method: "chips" | "boolean" | "text" | "spoken";
  readonly profileAlreadyBuilt: boolean;
  readonly now: Date;
  readonly ctx: RequestContext;
}

export type CorrectAnswerOutcome =
  | { readonly kind: "corrected"; readonly value: unknown; readonly correctionCount: number }
  /** The words parsed to nothing for this question. Nothing was written. */
  | { readonly kind: "unreadable" }
  /** This session has changed as many answers as it may. */
  | { readonly kind: "capped"; readonly cap: number };

/**
 * How many settled answers one interview may be corrected.
 *
 * NOT a rate limit and not an abuse guess — it is the bound that replaces the one the turn loop
 * provides for free. An ordinary interview settles 12–16 questions and `MAX_ENGINE_TURNS` bounds
 * every write inside it; a correction has no such ceiling, and each one can cost a paid STT call.
 * Twenty lets a worker re-do every answer they gave and then some, and stops a loop.
 */
export const MAX_CORRECTIONS_PER_SESSION = 20;

@Injectable()
export class ProfilingOrchestrator {
  private readonly logger = new Logger(ProfilingOrchestrator.name);

  constructor(
    private readonly buffer: ChatTranscriptBuffer,
    private readonly packs: PackRegistryService,
    private readonly identify: IdentifyService,
    private readonly chat: ChatRepository,
    private readonly events: EventsService,
  ) {}

  /**
   * Run one interview turn: load, decide, write — retrying the whole thing if the write is lost.
   *
   * THE LOOP IS THE CONCURRENCY MODEL. Each attempt re-loads and re-decides from scratch, so a
   * loser never merges two states or replays a half-applied mutation; it simply asks the pure
   * function the same question about newer facts.
   */
  async takeTurn(input: TurnInput): Promise<TurnResult> {
    // OUTSIDE THE RETRY LOOP, deliberately: what this measures is what the turn COST, and a lost
    // CAS that forced a second decision genuinely cost the worker both. Timing each attempt
    // separately would report the cheap winning attempt and hide contention entirely — which is
    // the one condition a turn-latency metric exists to surface.
    //
    // `Date.now()` rather than `input.now`, because `input.now` is the injected logical clock the
    // decision is derived from; measuring elapsed time against a fixed value is measuring zero.
    const startedAt = Date.now();

    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const loaded = await this.buffer.load(input.sessionId);
      const buffer = loaded ?? ChatTranscriptBuffer.create(input.workerId, "", input.now);
      const envelope =
        loaded === null
          ? await this.restorePin(input.sessionId, emptyProfilingEnvelope())
          : (buffer.profiling ?? emptyProfilingEnvelope());

      // LAYER A — the reply cache. Checked on EVERY attempt, not only the first: the writer who
      // beat us may have been this same worker's duplicate submit, in which case the right answer
      // is their own previous reply rather than a second turn spent on the same words.
      const replay = replayOf(envelope, input);
      if (replay) return replay;

      const decided = await this.decide(buffer, envelope, input);
      if (!decided) return unavailable();

      // Stamp the histogram onto the buffer that is about to be written. Done HERE rather than
      // inside `decide` so there is exactly one measurement point covering the whole decision —
      // answer capture, retrieval, pack resolution and question selection together, which is the
      // unit the plan's "p95 deterministic turn ≤ 400 ms" is about.
      const measured = withTurnLatency(decided.buffer, Date.now() - startedAt);

      // LAYER B — the CAS. A loss is not an error: reload and re-run.
      const won = await this.buffer.saveWithCas(input.sessionId, measured, envelope.rev);
      if (won) {
        // AFTER the CAS, never before. A turn that loses the write did not happen, and pinning a
        // pack for it would durably commit the interview a discarded decision chose.
        //
        // Handed `measured.profiling` rather than `decided.buffer.profiling` — the envelope that
        // actually landed. The two differ only by the latency histogram today, so nothing turns
        // on it now; passing the value that was written is what keeps that true if a later stamp
        // touches something the pin reads.
        await this.persistPin(envelope, measured.profiling, input);
        return decided.result;
      }

      this.logger.log(
        `CAS lost session=${input.sessionId} rev=${envelope.rev} attempt=${attempt + 1}; ` +
          `reloading and re-running the decision against the winner's state`,
      );
    }

    // Exhausted. WRITE NOTHING and say so — a third concurrent writer on one session is either a
    // client bug or an attack, and inventing a turn for it would corrupt a real interview.
    this.logger.warn(
      `CAS exhausted after ${MAX_CAS_ATTEMPTS} attempts session=${input.sessionId}; ` +
        `nothing was written and the worker is asked to retry`,
    );
    return unavailable();
  }

  /**
   * Put the FIRST question on screen without consuming a worker turn.
   *
   * WHY THIS IS NOT `takeTurn("")`. It nearly is, and that near-miss is the trap. Since #641 an
   * empty utterance on a session with no question served falls through the silent-turn branch to
   * the engine, so `takeTurn("")` does return question one — but it also does three things a
   * start route has no business doing: it appends a `{role: "worker", text: ""}` line to the
   * transcript that the end-of-interview parse call will read as the worker having said nothing,
   * it runs occupation retrieval against the empty string, and it spends a turn from
   * `MAX_ENGINE_TURNS`. On the chat surface none of that ever happens, because there the first
   * question is a REPLY to something the worker typed. A voice form has no such thing: the screen
   * has to speak first.
   *
   * IDEMPOTENT, AND NOT VIA THE REPLY CACHE. `start()` is called again on every cold app start,
   * every resume-after-kill and every retry of a request that timed out after the write landed.
   * Layer A cannot serve those — it is keyed on the inbound text, which here is nothing, and its
   * window is ten seconds. So the test is `servedQuestionKey`: a question already on screen is
   * RE-SERVED verbatim with nothing written and no ask spent, which is both stronger than the
   * cache (it holds for the whole session) and the honest answer to "what should the worker see?".
   *
   * Fails closed exactly as {@link takeTurn} does: no pack, or a decision whose text is empty,
   * writes nothing and returns the retryable unavailable line.
   */
  async openTurn(input: OpenTurnInput): Promise<TurnResult> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const loaded = await this.buffer.load(input.sessionId);
      const buffer = loaded ?? ChatTranscriptBuffer.create(input.workerId, "", input.now);
      const envelope =
        loaded === null
          ? await this.restorePin(input.sessionId, emptyProfilingEnvelope())
          : (buffer.profiling ?? emptyProfilingEnvelope());

      const packs = await this.resolvePacks(envelope, input.now.getTime());
      if (!packs) {
        this.logger.error(
          `no question pack resolved opening session ${input.sessionId}; the universal pack is ` +
            `missing, which db:verify:packs is supposed to make impossible`,
        );
        return unavailable();
      }
      const items = [...(packs.engine.occupation?.items ?? []), ...packs.engine.universal.items];
      const answers = answersOf(envelope);

      // CHIPS ON SCREEN OUTRANK THE PACK QUESTION, before the re-serve below can find a stale key.
      //
      // `identify()`'s offer branch patches `needsDisambiguation`, `disambiguationOffer`, `phase`
      // and `catalogVersion` — it does NOT clear `servedQuestionKey`, so a session mid-offer still
      // carries the pack key from the turn before. Without this, reopening re-served that question
      // as an ordinary ask and silently replaced the pending offer, while `viewSession` (which has
      // applied this precedence all along) reported `questionKey: null` for the same session. The
      // two readers disagreed about what the worker was looking at, and answering the re-served
      // question 409'd on the stale-answer guard. `openTurn` runs on every cold start and
      // resume-after-kill, which is exactly when a worker returns to an offer they never answered.
      const offer = outstandingOffer(envelope);
      if (offer) {
        return {
          reply: offer.prompt,
          kind: "disambiguate",
          questionKey: null,
          options: offer.options,
          whyText: null,
          answerType: "single_select",
          progress: progressOf(items, answers),
          unansweredEssentials: essentialsOf(items, answers),
          complete: false,
          completionReason: null,
          replayed: true,
          excludeFromParse: false,
          unavailable: false,
          checkpointDue: false,
        };
      }

      // ALREADY OPEN. Re-serve, write nothing. `servedText` rather than `prompt_text`, so a
      // session reopened after a re-ask hears the wording it last heard and not the opening
      // phrasing from two turns ago — the regression `servedText` exists to prevent, and one a
      // voice surface makes audible rather than merely visible.
      const served = items.find((item) => item.question_key === envelope.servedQuestionKey);
      if (served) {
        const text = servedText(
          served,
          askCount(toEngineState(envelope, buffer.turnCount), served.question_key),
        );
        return {
          reply: text,
          // A re-serve of a PACK question, and now genuinely only that: an outstanding offer was
          // returned above, so reaching here means `servedQuestionKey` is the live question.
          kind: "ask",
          questionKey: served.question_key,
          options: served.options,
          ...shapeOf(items, served.question_key),
          progress: progressOf(items, answers),
          unansweredEssentials: essentialsOf(items, answers),
          complete: false,
          completionReason: null,
          replayed: true,
          excludeFromParse: false,
          unavailable: false,
          checkpointDue: false,
        };
      }

      // `buffer.turnCount` UNCHANGED, deliberately: `toEngineState`'s turn argument is what the
      // hard turn cap is judged against, and opening the screen is not a turn the worker spent.
      const decision = nextQuestion(toEngineState(envelope, buffer.turnCount), packs.engine);
      const reply = decision.kind === "close" ? CLOSING_REPLY : decision.promptText;
      if (reply.trim().length === 0) {
        this.logger.error(
          `refusing to open session ${input.sessionId} with an empty reply kind=${decision.kind} ` +
            `phase=${decision.phase}; nothing was written`,
        );
        return unavailable();
      }

      const next: ProfilingEnvelope = {
        ...envelope,
        packId: packs.packId,
        packVersion: packs.packVersion,
        phase: decision.phase,
        ...(decision.kind === "ask" && decision.questionKey
          ? {
              engineAsks: envelope.engineAsks + 1,
              askCounts: {
                ...envelope.askCounts,
                [decision.questionKey]: (envelope.askCounts[decision.questionKey] ?? 0) + 1,
              },
              servedQuestionKey: decision.questionKey,
            }
          : { servedQuestionKey: decision.questionKey }),
      };

      // ONLY THE ASSISTANT LINE. There is no worker message to record, and inventing an empty one
      // to keep the transcript alternating would put a silence into the record of what the worker
      // said. `turnCount` is not bumped for the same reason.
      const at = input.now.toISOString();
      const opened: TranscriptBuffer = {
        ...buffer,
        messages: [...buffer.messages, { role: "assistant" as const, text: reply, at }],
        profiling: next,
      };

      if (await this.buffer.saveWithCas(input.sessionId, opened, envelope.rev)) {
        await this.persistPin(envelope, next, {
          sessionId: input.sessionId,
          workerId: input.workerId,
          text: "",
          now: input.now,
          ctx: input.ctx,
        });
        return {
          reply,
          // Opening the screen never disambiguates: retrieval has not run, because the worker has
          // not said anything for it to run on.
          kind: decision.kind === "close" ? "close" : "ask",
          questionKey: decision.questionKey,
          options: decision.options,
          ...shapeOf(items, decision.questionKey),
          progress: decision.progress,
          unansweredEssentials: essentialsOf(items, answers),
          complete: decision.kind === "close",
          completionReason: decision.completionReason,
          replayed: false,
          excludeFromParse: false,
          unavailable: false,
          // An opening ask cannot cross a checkpoint boundary: it is ask one.
          checkpointDue: false,
        };
      }

      this.logger.log(
        `CAS lost opening session=${input.sessionId} rev=${envelope.rev} ` +
          `attempt=${attempt + 1}; reloading — the winner may already have served question one`,
      );
    }

    this.logger.warn(
      `CAS exhausted opening session=${input.sessionId} after ${MAX_CAS_ATTEMPTS} attempts; ` +
        `nothing was written and the worker is asked to retry`,
    );
    return unavailable();
  }

  /**
   * The whole turn as a value: the buffer to write and the result to return, or `null` when no
   * pack could be resolved.
   *
   * Separated from `takeTurn` so the retry loop has exactly one thing to repeat, and so every
   * branch below is reachable from a test without a Redis.
   */
  private async decide(
    buffer: TranscriptBuffer,
    envelope: ProfilingEnvelope,
    input: TurnInput,
  ): Promise<{ buffer: TranscriptBuffer; result: TurnResult } | null> {
    const packs = await this.resolvePacks(envelope, input.now.getTime());
    if (!packs) {
      this.logger.error(
        `no question pack resolved for session ${input.sessionId}; the universal pack is ` +
          `missing, which db:verify:packs is supposed to make impossible`,
      );
      return null;
    }

    const turn = buffer.turnCount + 1;
    // `let`, because a MID-TURN RE-PIN replaces the pack this was built from. See the reassignment
    // below the identify step.
    let items = [...(packs.engine.occupation?.items ?? []), ...packs.engine.universal.items];
    const askedItem =
      items.find((item) => item.question_key === envelope.servedQuestionKey) ?? null;

    // THE TURN CAP OUTRANKS EVERY NON-ADVANCING BRANCH BELOW, and the order is the whole point:
    // clarify, silence and hardship all return early WITHOUT consulting the engine, so testing the
    // cap after them would let a worker who only ever triggers those paths run forever. Past the
    // cap every turn class falls through to `nextQuestion`, which closes with `turn_cap`.
    const capped = turn > MAX_ENGINE_TURNS;

    const capture = captureAnswer(input.text, askedItem);
    let answers = answersOf(envelope);
    let next: ProfilingEnvelope = {
      ...envelope,
      packId: packs.packId,
      packVersion: packs.packVersion,
      catalogVersion: envelope.occupation?.catalog_version ?? envelope.catalogVersion,
    };

    // --- Turn classes that do not advance the interview ---------------------
    if (capture.turnClass === "abusive") {
      next = { ...next, abusiveTurns: next.abusiveTurns + 1, silentTurns: 0, clarifyCount: 0 };
      if (next.abusiveTurns < MAX_ABUSIVE_TURNS && !capped) {
        return this.turn(buffer, next, input, {
          reply: DE_ESCALATION_REPLY,
          // The question on screen is unchanged and still answered the ordinary way; only the
          // words above it differ.
          kind: "ask",
          questionKey: envelope.servedQuestionKey,
          options: askedItem?.options ?? [],
          ...shapeOf(items, envelope.servedQuestionKey),
          progress: progressOf(items, answers),
          unansweredEssentials: essentialsOf(items, answers),
          complete: false,
          completionReason: null,
          replayed: false,
          excludeFromParse: true,
          unavailable: false,
          checkpointDue: false,
        });
      }
      // The cap fired. Fall through to the engine, which closes with `abuse_cap` — the reason
      // lives in ONE place (`nextQuestion`'s hard bounds) rather than being restated here.
    }

    if (capture.turnClass === "empty") {
      next = { ...next, silentTurns: next.silentTurns + 1 };
      // THE WORDING THE WORKER LAST SAW, not the question's original phrasing. Reading
      // `prompt_text` directly walked the interview BACKWARDS to the opening wording after the
      // retry wording had already been served — the exact regression `servedText` exists to
      // prevent, and one a voice session makes audible rather than merely visible.
      const reserved = askedItem
        ? servedText(askedItem, askCount(toEngineState(next, turn), askedItem.question_key))
        : "";
      // A RE-SERVE NEEDS SOMETHING TO RE-SERVE. With no question on screen — the state of every
      // NEW session — there was nothing, and the old `?? ""` COMMITTED a blank assistant bubble:
      // this branch returns before the empty-reply guard below, so that guard never saw it. The
      // blank was also cached as the replay reply, so a duplicate submit served it again.
      //
      // `classifyUtterance` calls anything under two trimmed characters `empty` and the wire
      // validator demands only one, so a first message of "k" or "." reached exactly this line.
      // Falling through instead lets the engine choose the first question, which is what the
      // worker needed anyway — and it matters most for the voice form, where a one-character
      // transcript is simply what a noisy environment produces.
      if (reserved.trim().length > 0 && next.silentTurns < MAX_SILENT_TURNS && !capped) {
        // A TURN, not an ASK. A worker whose keyboard is failing has not refused to answer, so
        // the question is re-served with no budget spent and no counter advanced.
        return this.turn(buffer, next, input, {
          reply: reserved,
          // A re-serve of the same question — same kind it had.
          kind: "ask",
          questionKey: envelope.servedQuestionKey,
          options: askedItem?.options ?? [],
          ...shapeOf(items, envelope.servedQuestionKey),
          progress: progressOf(items, answers),
          unansweredEssentials: essentialsOf(items, answers),
          complete: false,
          completionReason: null,
          replayed: false,
          excludeFromParse: false,
          unavailable: false,
          checkpointDue: false,
        });
      }
      // Three silences: ADVANCE, and advancing has to be made real. Resetting the counter alone
      // would leave the question with ask budget remaining, so the engine would simply serve it
      // again and the worker would sit on the same question forever. Spending the question's
      // remaining asks is what "advance" means here; the `unanswered` record follows below,
      // through the same path every other advance uses.
      next = {
        ...next,
        silentTurns: 0,
        ...(askedItem
          ? {
              askCounts: {
                ...next.askCounts,
                [askedItem.question_key]: askCeiling(askedItem),
              },
            }
          : {}),
      };
    }

    if (capture.turnClass === "hardship") {
      next = { ...next, silentTurns: 0, hardshipTurns: next.hardshipTurns + 1 };
      if (next.hardshipTurns <= MAX_CONSECUTIVE_HARDSHIP && !capped) {
        return this.turn(buffer, next, input, {
          // Indexed by TURN, never at random: the engine has no randomness by construction, so
          // the same conversation must always produce the same words.
          reply: HARDSHIP_REPLIES[turn % HARDSHIP_REPLIES.length] as string,
          // An acknowledgement above the question that is still on screen.
          kind: "ask",
          questionKey: envelope.servedQuestionKey,
          options: askedItem?.options ?? [],
          ...shapeOf(items, envelope.servedQuestionKey),
          progress: progressOf(items, answers),
          unansweredEssentials: essentialsOf(items, answers),
          complete: false,
          completionReason: null,
          replayed: false,
          excludeFromParse: false,
          unavailable: false,
          checkpointDue: false,
        });
      }
      // Past the bound: fall through and let the engine move the interview on. Acknowledging
      // forever is not kindness, it is an interview that never produces a profile.
    }

    if (capture.turnClass === "question_back") {
      const state = toEngineState({ ...next, silentTurns: 0 }, turn);
      const clarified = clarify(state, packs.engine);
      if (clarified) {
        // NEVER counts as an ask. The worker asked a reasonable question and deserves an answer,
        // not a spent budget — `why_text` first, then the same question again on the same turn.
        next = { ...next, clarifyCount: next.clarifyCount + 1, silentTurns: 0 };
        return this.turn(buffer, next, input, {
          reply: joinClarify(
            clarified,
            askedItem,
            askedItem ? askCount(state, askedItem.question_key) : 0,
          ),
          // `ask`, NOT the wire enum's `clarify`. The explanation and the question arrive in one
          // bubble, and the question is answered exactly as it was before the worker asked why —
          // so a client that branched on `clarify` would be re-rendering an unchanged affordance.
          // Emitting the value would be a visible change to a shipped client, which is #695's
          // scope to widen, not this change's.
          kind: "ask",
          questionKey: clarified.questionKey,
          options: clarified.options,
          ...shapeOf(items, clarified.questionKey),
          checkpointDue: false,
          progress: clarified.progress,
          unansweredEssentials: essentialsOf(items, answers),
          complete: false,
          completionReason: null,
          replayed: false,
          excludeFromParse: false,
          unavailable: false,
        });
      }
      // Past the clarify bound: fall through to ordinary selection and move the interview on.
    }

    // --- Answer classes: write what the worker said -------------------------
    next = { ...next, silentTurns: 0, clarifyCount: 0, hardshipTurns: 0 };

    if (capture.turnClass === "dont_know" && envelope.servedQuestionKey) {
      // A COMPLETE answer, not a gap. Never re-asked, never blocks completion.
      answers = recordDeclined(answers, envelope.servedQuestionKey, turn);
    }
    for (const value of capture.values) {
      answers = recordAnswer(answers, value, turn);
    }
    answers = this.fillCrossQuestion(
      items,
      input.text,
      envelope,
      answers,
      capture.correcting,
      turn,
    );

    // --- IDENTIFY: the worker's words become an occupation -------------------
    //
    // AFTER the answer is recorded and BEFORE the engine is consulted, and both halves of that
    // sandwich are load-bearing. After, because "silai ka kaam karta hoon" is simultaneously the
    // answer to the trade question and the phrase retrieval runs on — recording it second would
    // let a pin that changes the pack decide whether the worker's own sentence was ever written
    // down. Before, because a pin CHANGES WHICH QUESTIONS EXIST, and asking the universal pack's
    // next question on the very turn we learned the trade wastes the turn the worker just spent
    // telling us.
    next = withAnswers(next, answers);
    const identified = await this.identify.identify(next, input.text, {
      ...input.ctx,
      sessionId: input.sessionId,
      workerId: input.workerId,
    });
    next = { ...next, ...identified.patch };

    // Chips are on screen. That IS the turn — there is no pack question to ask until the worker
    // resolves the ambiguity, and asking one anyway would put two questions in one bubble.
    if (identified.offer) {
      return this.turn(buffer, next, input, {
        reply: identified.offer.prompt,
        // THE ONE SITE THAT KNOWS. Everything downstream had to guess before #695: the fact was
        // available exactly here and thrown away one layer up, so a real disambiguation offer
        // reached the worker app as an ordinary ask and rendered in the horizontal chip scroller
        // — the failure #649 was raised to fix, with its vertical single-select correct, merged
        // and unreachable.
        kind: "disambiguate",
        // NO QUESTION KEY. This question belongs to no pack, and claiming a pack's key for it
        // would make the next turn's `askedItem` lookup capture a chip tap as that question's
        // answer.
        questionKey: null,
        options: identified.offer.options,
        // NOT `shapeOf`, and this is the one site where the shape is asserted rather than looked
        // up: these chips come from RETRIEVAL, so there is no pack row to read an `answer_type`
        // off. It is nonetheless a single-select — the worker picks the one trade they do — and
        // saying so is what stops a client from rendering the trade list as a mic prompt.
        whyText: null,
        answerType: "single_select",
        // A disambiguation turn spends no ask, so it can never cross a checkpoint boundary.
        checkpointDue: false,
        progress: progressOf(items, answers),
        unansweredEssentials: essentialsOf(items, answers),
        complete: false,
        completionReason: null,
        replayed: false,
        excludeFromParse: false,
        unavailable: false,
      });
    }

    // A pin THIS TURN means the occupation pack was not loaded when `packs` was resolved above.
    // Re-resolving now is what lets the very next question come from the worker's own trade.
    let engine = packs.engine;
    if (identified.pinned) {
      const repinned = await this.resolvePacks(next, input.now.getTime());
      if (repinned) {
        engine = repinned.engine;
        next = { ...next, packId: repinned.packId, packVersion: repinned.packVersion };
        // AND THE ITEM LIST WITH IT. Measured live: the turn that pins "main welder hoon" serves
        // `welding_process` — a row that exists only in the pack just resolved — while `items`
        // still held the universal pack's eight. So `shapeOf` found nothing and the client was
        // handed `answer_type: null` for the first question of the worker's own trade, which on a
        // select question means no chips and a worker who cannot type has no way to answer.
        // `essentialsOf` read the same stale list, and reported the universal pack's mandatory
        // questions as the outstanding ones on exactly the turn the real pack arrived.
        items = [...(repinned.engine.occupation?.items ?? []), ...repinned.engine.universal.items];
      }
    }

    // --- The decision -------------------------------------------------------
    const decision = nextQuestion(toEngineState(next, turn), engine);

    // ADVANCING PAST A QUESTION IS WHAT RECORDS `unanswered`. Judged by comparing what the engine
    // chose against what was on screen, rather than by re-deriving the ask ceiling here — one
    // definition of "the engine moved on", owned by the engine.
    if (
      envelope.servedQuestionKey &&
      decision.questionKey !== envelope.servedQuestionKey &&
      !isSettled(answers, envelope.servedQuestionKey)
    ) {
      answers = recordUnanswered(answers, envelope.servedQuestionKey, turn);
    }

    next = withAnswers(next, answers);
    if (decision.kind === "ask") {
      const key = decision.questionKey as string;
      next = {
        ...next,
        phase: decision.phase,
        engineAsks: next.engineAsks + 1,
        askCounts: { ...next.askCounts, [key]: (next.askCounts[key] ?? 0) + 1 },
        servedQuestionKey: key,
      };
    } else {
      next = { ...next, phase: decision.phase, servedQuestionKey: decision.questionKey };
    }

    // A TURN THAT WOULD SHOW THE WORKER NOTHING IS NOT A TURN WORTH COMMITTING.
    //
    // `disambiguate` is how this WAS reached: `nextQuestion` returns it with an empty
    // `promptText`, because chips come from retrieval and not from a pack row. The identify step
    // above now serves that turn itself and returns before ever consulting the engine, so this
    // branch should be unreachable — the guard stays because "should be unreachable" is a claim
    // about today's control flow and the failure it prevents is silent.
    // Committing an empty reply anyway appended an empty assistant bubble to the transcript,
    // cached "" as the replay reply, and — because a non-ask spends no budget and nothing clears
    // the flag — emitted another blank every turn until MAX_ENGINE_TURNS closed the interview.
    //
    // Failing closed instead writes NOTHING and returns a line the worker can retry into. That is
    // recoverable; a wall of empty bubbles is not. The guard is on the TEXT rather than on the
    // kind, so a pack whose prompt is whitespace cannot reintroduce this either.
    const reply = decision.kind === "close" ? CLOSING_REPLY : decision.promptText;
    if (reply.trim().length === 0) {
      this.logger.error(
        `refusing to serve an empty reply session=${input.sessionId} kind=${decision.kind} ` +
          `phase=${decision.phase}; nothing was written` +
          (decision.kind === "disambiguate"
            ? " — a disambiguation offer needs Phase 7 retrieval to supply the chips"
            : ""),
      );
      return null;
    }

    // The CROSSING, computed from the pre-turn and post-turn ask counts. `next.engineAsks` was
    // incremented above only on the `ask` branch, so this is true exactly once per boundary —
    // never twice at the same count, however many non-ask turns follow.
    const checkpointDue =
      next.engineAsks > envelope.engineAsks && next.engineAsks % CHECKPOINT_EVERY_ASKS === 0;

    return this.turn(buffer, next, input, {
      reply,
      // The engine's own verdict, not a re-derivation of it: `close` is the decision that ended
      // the interview, and every other decision put a pack question on screen.
      kind: decision.kind === "close" ? "close" : "ask",
      questionKey: decision.questionKey,
      options: decision.options,
      ...shapeOf(items, decision.questionKey),
      progress: decision.progress,
      unansweredEssentials: essentialsOf(items, answers),
      complete: decision.kind === "close",
      completionReason: decision.completionReason,
      replayed: false,
      excludeFromParse: capture.excludeFromParse,
      unavailable: false,
      checkpointDue,
    });
  }

  /**
   * Free information: a value the worker mentioned while answering a DIFFERENT question.
   *
   * Gated three ways, because this is the path most able to do damage. Only fields with a TYPED
   * normalizer participate (`hasFieldNormalizer` — a free-text item's "normalizer" is the identity
   * and would swallow the whole message); only unsettled questions are considered; and
   * {@link mayCommit} enforces first-write-wins, so a city mentioned while answering the salary
   * question can FILL an empty slot but can never overwrite one the worker already established.
   */
  private fillCrossQuestion(
    items: readonly QuestionPackItem[],
    text: string,
    envelope: ProfilingEnvelope,
    answers: AnswerMap,
    correcting: boolean,
    turn: number,
  ): AnswerMap {
    let filled = answers;
    for (const item of items) {
      if (item.question_key === envelope.servedQuestionKey) continue;
      if (!hasFieldNormalizer(item.target_field)) continue;
      if (isSettled(filled, item.question_key)) continue;
      if (!mayCommit(filled, item.question_key, envelope.servedQuestionKey, correcting)) continue;

      // The SAME capture path as the asked question, deliberately: the normalizers, the chip
      // handling and the negation veto must not have a second implementation that is free to
      // disagree with the first about what a worker said.
      //
      // `crossQuestion` IS THE ONE DIFFERENCE, and it is the same rule the `hasFieldNormalizer`
      // gate above encodes: only a TYPED parser may claim a value nobody asked for. The yes/no
      // fallback (#713) is not one — a bare "haan" means whatever the question on screen asked,
      // so letting it run here would record a worker answering the EXPERIENCE question as willing
      // to relocate.
      const capture = captureAnswer(text, item, { crossQuestion: true });
      for (const value of capture.values) {
        filled = recordAnswer(filled, value, turn);
      }
    }
    return filled;
  }

  /**
   * Rebuild a lost envelope's pack pin from Postgres.
   *
   * THE ONE FACT ABOUT A SESSION THAT CANNOT BE RE-DERIVED. Everything else in the envelope is
   * either recoverable (the answers are rows in `worker_pack_answer`) or cheap to lose (counters,
   * the reply cache). The pin is neither: re-running retrieval on a resumed conversation is not
   * idempotent — the catalogue may have moved, the worker's first words are gone, and the ladder
   * can legitimately land somewhere else — so without this read a 24h TTL lapse silently changes
   * which questions a half-finished interview asks.
   *
   * ONLY on the lost-buffer path. When the envelope loaded it already holds the pin, and a query
   * here would buy nothing but a round trip on every turn of every interview.
   *
   * A failure degrades rather than breaks: the interview restarts on the universal pack, which is
   * exactly what it did before this existed. Loud, because a resumed session quietly changing its
   * questions is the failure this whole path is here to prevent.
   */
  /**
   * READ-ONLY: everything a surface needs to know about a live interview without taking a turn.
   *
   * WHY THIS EXISTS AT ALL. Two routes need facts the engine holds and nothing else does. The
   * answer route has to turn the `option_key` a worker tapped into the LABEL that is their answer
   * of record — server-side, always, because letting the client send the label makes the stored
   * answer a thing the client chose. And the review screen has to pair each captured value with
   * the question that produced it, which means the pinned pack's rows.
   *
   * ONE METHOD RATHER THAN TWO, because both need the same two loads (the envelope, then the
   * packs it pins) and doing them separately would mean a review rendered against a pack the
   * answer route had already re-resolved.
   *
   * IT TAKES NO WORKER ID AND CHECKS NO OWNERSHIP. That is deliberate and is the caller's job:
   * ownership is decided against the `chat_sessions` ROW, never against a cache key, so a route
   * that authorized on this would be authorizing on Redis.
   *
   * Returns null when there is no buffer — an interview that has not started, or whose TTL lapsed.
   */
  async viewSession(sessionId: string, now: Date): Promise<SessionView | null> {
    const buffer = await this.buffer.load(sessionId);
    if (buffer === null) return null;
    const envelope = buffer.profiling ?? emptyProfilingEnvelope();

    const packs = await this.resolvePacks(envelope, now.getTime());
    const items = packs
      ? [...(packs.engine.occupation?.items ?? []), ...packs.engine.universal.items]
      : [];
    const answers = answersOf(envelope);

    // THE DISAMBIGUATION OFFER OUTRANKS THE PACK QUESTION — see {@link outstandingOffer}, which
    // both readers of a reopened session share so they cannot answer this differently again.
    const offer = outstandingOffer(envelope);
    if (offer) {
      return {
        buffer,
        envelope,
        items,
        served: {
          questionKey: null,
          promptText: offer.prompt,
          answerType: "single_select",
          options: offer.options,
          whyText: null,
          progress: progressOf(items, answers),
        },
      };
    }

    const item = items.find((candidate) => candidate.question_key === envelope.servedQuestionKey);
    return {
      buffer,
      envelope,
      items,
      served: item
        ? {
            questionKey: item.question_key,
            promptText: servedText(
              item,
              askCount(toEngineState(envelope, buffer.turnCount), item.question_key),
            ),
            answerType: item.answer_type,
            options: item.options,
            whyText: item.why_text ?? null,
            progress: progressOf(items, answers),
          }
        : null,
    };
  }

  /**
   * A finished interview's record, for the correction path. See {@link SettledView}.
   *
   * NO OWNERSHIP CHECK, matching {@link viewSession}: ownership is decided against the
   * `chat_sessions` ROW by the caller, never in here.
   *
   * Returns null when the session has no pack pin — an interview that never resolved one has no
   * questions to correct against, and guessing the pack here would let a correction be written
   * against a question the worker was never asked.
   */
  async viewSettled(sessionId: string, now: Date): Promise<SettledView | null> {
    const session = await this.chat.findSession(sessionId);
    if (!session?.packId || session.packVersion === null) return null;

    const universal = await this.packs.loadUniversal(now.getTime());
    if (!universal) return null;
    let occupation = await this.packs.loadPinned(
      session.packId,
      session.packVersion,
      now.getTime(),
    );
    if (occupation && occupation.pack_id === universal.pack_id) occupation = null;

    const state = (session.conversationState ?? {}) as Record<string, unknown>;
    const rawCount = state.correction_count;

    return {
      packId: session.packId,
      packVersion: session.packVersion,
      items: [...(occupation?.items ?? []), ...universal.items],
      answers: toAnswerMap(narrowAnswerRecords(state.answer_map)),
      state,
      correctionCount: typeof rawCount === "number" && rawCount > 0 ? Math.trunc(rawCount) : 0,
    };
  }

  /**
   * Change a SETTLED answer, deliberately outside the turn loop.
   *
   * THIS IS THE ONE WRITE IN THE INTERVIEW THAT `nextQuestion` DOES NOT AUTHORIZE, and the ruling
   * that asked for it (#700) named that as the reason it needs its own proof. What the turn loop
   * hands a caller for free, and where each of those guarantees is re-established:
   *
   * | the turn loop gives | here |
   * |---|---|
   * | the session is this worker's | the CALLER, against the `chat_sessions` row |
   * | the question is real and pinned | {@link viewSettled} → `items`, then the lookup below |
   * | the chips belong to THIS question | the caller, resolving `option_key` → `label_text` |
   * | the words become a typed value | `captureAnswer` — the SAME function, not a second one |
   * | never store what we could not read | the `unreadable` outcome; nothing is written |
   * | first-write-wins | DELIBERATELY BYPASSED, via {@link mayCommit}'s `correcting` escape, and
   * |                  | asserted below rather than assumed |
   * | a bounded number of writes | {@link MAX_CORRECTIONS_PER_SESSION} |
   * | atomicity (the CAS) | one transaction — the envelope is gone, so Redis cannot provide it |
   *
   * `recordAnswer` supersedes rather than replaces: the previous value moves onto `history` with
   * status `superseded`, which is what makes a correction auditable and what the parse call reads
   * to know which of two wordings won.
   *
   * BOTH DURABLE STORES, IN ONE TRANSACTION. `worker_pack_answer` is what the review screen and
   * every later reader see; `conversation_state.answer_map` is what the EXTRACTION PROCESSOR reads
   * to build the profile. Writing only the first would leave a correction the worker can see and
   * the profile can never reflect.
   */
  async correctAnswer(input: CorrectAnswerInput): Promise<CorrectAnswerOutcome> {
    const view = await this.viewSettled(input.sessionId, input.now);
    if (!view) throw new Error(`session ${input.sessionId} has no pinned pack to correct against`);

    const item = view.items.find((candidate) => candidate.question_key === input.questionKey);
    if (!item) throw new Error(`question ${input.questionKey} is not in this session's pack`);

    if (view.correctionCount >= MAX_CORRECTIONS_PER_SESSION) {
      return { kind: "capped", cap: MAX_CORRECTIONS_PER_SESSION };
    }

    // THE SAME CAPTURE PATH AS A TURN. Every normalizer, the negation veto, the chip matching and
    // the typed-value rules run here exactly as they do on the asked question — a second
    // implementation would be free to disagree with the first about what the worker said, on the
    // one write whose entire purpose is to be more correct than the first attempt.
    const capture = captureAnswer(input.text, item);
    const value = capture.values.find((candidate) => candidate.questionKey === input.questionKey);
    if (!value) {
      // FAIL CLOSED. The turn loop can re-ask; this path cannot, and storing an unparsed sentence
      // where a typed value belongs is how the review screen would confirm a correction that
      // corrected nothing.
      return { kind: "unreadable" };
    }

    // The escape being taken ON PURPOSE. Rule 2 of the overwrite rule — "an explicit correction
    // commits, whatever question is on screen" — is what this whole path rests on, so it is
    // asserted rather than implied. `askedQuestionKey` is null because nothing is on screen.
    if (!mayCommit(view.answers, input.questionKey, null, true)) {
      throw new Error(`the overwrite rule refused a correction for ${input.questionKey}`);
    }

    const answers = recordAnswer(view.answers, value, 0);
    const correctionCount = view.correctionCount + 1;
    const record = answers[input.questionKey] as AnswerRecord;

    const patched: Record<string, unknown> = {
      ...view.state,
      answer_map: toAnswerArray(answers),
      // The flattened projection every pre-cutover reader still uses. Rebuilt from the SAME map,
      // so the two halves of the column cannot disagree about a corrected value.
      captured: toCapturedProjection(answers),
      correction_count: correctionCount,
    };

    const row = packAnswerRowFor({
      workerId: input.workerId,
      sessionId: input.sessionId,
      packId: view.packId,
      packVersion: view.packVersion,
      record,
      // `form`, not `chat`. This is the one write where the affordance IS known — the review
      // screen is a form — and the vocabulary already carries the value.
      source: "form",
    });

    await this.chat.withTransaction(async (tx) => {
      await this.chat.saveConversationState(input.sessionId, patched, input.now, tx);
      // Upsert on `(worker_id, pack_id, question_key)` — the same statement the flush uses, so a
      // correction updates the row the interview wrote rather than racing it.
      if (row) await this.chat.insertPackAnswers(tx, [row]);
      await this.events.emit({
        event_name: "profile.answer_corrected",
        actor: { actor_type: "worker", actor_id: input.workerId },
        subject: { subject_type: "chat_session", subject_id: input.sessionId },
        payload: {
          worker_id: input.workerId,
          session_id: input.sessionId,
          question_key: input.questionKey,
          pack_id: view.packId,
          pack_version: view.packVersion,
          method: input.method,
          profile_already_built: input.profileAlreadyBuilt,
          correction_count: correctionCount,
        },
        // Per correction, not per session: a worker may legitimately fix the same question twice.
        idempotencyKey: `profile.answer_corrected:${input.sessionId}:${input.questionKey}:${correctionCount}`,
        correlationId: input.ctx.correlationId,
        requestId: input.ctx.requestId,
        tx,
      });
    });

    return { kind: "corrected", value: record.value_normalized, correctionCount };
  }

  private async restorePin(
    sessionId: string,
    envelope: ProfilingEnvelope,
  ): Promise<ProfilingEnvelope> {
    try {
      const pin = await this.chat.findPackPin(sessionId);
      if (!pin) return envelope;
      this.logger.log(
        `envelope for session ${sessionId} was gone; restored pack pin ` +
          `${pin.packId}:${pin.packVersion} from chat_sessions so the resumed interview asks ` +
          `the same questions`,
      );
      return { ...envelope, packId: pin.packId, packVersion: pin.packVersion };
    } catch (error) {
      this.logger.error(
        `could not read the pack pin for session ${sessionId}; the resumed interview will ` +
          `re-resolve and may land on a different pack: ${(error as Error).message}`,
      );
      return envelope;
    }
  }

  /**
   * Make the pack pin durable, and emit the audit event — on the transition only.
   *
   * WHAT "THE TRANSITION" MEANS: the envelope that came out of this turn names a pack and the one
   * that went in did not. Every later turn re-derives the same `packId` from the same pin, so
   * writing on each of them would be twelve UPDATEs to store one immutable fact.
   *
   * THE EVENT FOLLOWS THE WRITE, NOT THE DECISION. `pinPack` returns whether its
   * `WHERE pack_id IS NULL` won, so a session that somehow reaches here twice emits once and the
   * audit trail never claims a pin Postgres does not hold.
   *
   * BEST-EFFORT, DELIBERATELY. The worker's turn is already committed to Redis and their reply is
   * owed; throwing here would turn a durability problem into a lost answer. The cost of the
   * failure is bounded and named in the log: this session loses the resume guarantee, and
   * nothing else. It is not retried on a later turn because the transition has passed — a
   * self-healing write would have to run on every turn, which is the cost this method exists to
   * avoid.
   */
  private async persistPin(
    before: ProfilingEnvelope,
    after: ProfilingEnvelope | null | undefined,
    input: TurnInput,
  ): Promise<void> {
    if (before.packId !== null || !after?.packId || !after.packVersion) return;
    const occupation = after.occupation;
    if (!occupation) return;

    try {
      const won = await this.chat.pinPack(input.sessionId, after.packId, after.packVersion);
      if (!won) {
        this.logger.warn(
          `session ${input.sessionId} already holds a pack pin; keeping it and NOT repinning ` +
            `to ${after.packId}:${after.packVersion}`,
        );
        return;
      }
      await this.events.emit({
        event_name: "profile.pack_pinned",
        actor: { actor_type: "worker", actor_id: input.workerId },
        subject: { subject_type: "chat_session", subject_id: input.sessionId },
        payload: {
          worker_id: input.workerId,
          session_id: input.sessionId,
          pack_id: after.packId,
          pack_version: after.packVersion,
          job_domain_id: occupation.job_domain_id,
          catalog_version: catalogVersionForEvent(occupation.catalog_version),
        },
        // The SQL guard already makes this once-per-session; the key is the backstop for the
        // at-least-once delivery retry, matching `profile.occupation_identified`.
        idempotencyKey: `profile.pack_pinned:${input.sessionId}`,
        correlationId: input.ctx.correlationId,
        requestId: input.ctx.requestId,
      });
    } catch (error) {
      this.logger.error(
        `pack pin ${after.packId}:${after.packVersion} did not become durable for session ` +
          `${input.sessionId}; the interview continues but a Redis eviction will restart it on ` +
          `the universal pack: ${(error as Error).message}`,
      );
    }
  }

  /**
   * The occupation pack (pinned if the conversation already has one) and the universal tail.
   *
   * PINNING HAPPENS ONCE. If `packId` is already set the pinned version is loaded verbatim; a
   * pack release mid-interview must never change what a worker is being asked (risk #13).
   */
  private async resolvePacks(
    envelope: ProfilingEnvelope,
    now: number,
  ): Promise<{ engine: EnginePacks; packId: string | null; packVersion: number | null } | null> {
    const universal = await this.packs.loadUniversal(now);
    if (!universal) return null;

    let occupation: QuestionPack | null = null;
    if (envelope.packId && envelope.packVersion) {
      occupation = await this.packs.loadPinned(envelope.packId, envelope.packVersion, now);
    } else if (envelope.occupation) {
      occupation = await this.packs.resolveForOccupation(envelope.occupation, now);
    }

    // The universal pack resolving as the "occupation" pack is not an occupation pack. Treated as
    // absent so the engine runs one universal block rather than the same questions twice.
    if (occupation && occupation.pack_id === universal.pack_id) occupation = null;

    return {
      engine: { occupation, universal },
      packId: occupation?.pack_id ?? envelope.packId,
      packVersion: occupation?.version ?? envelope.packVersion,
    };
  }

  /**
   * Stamp the reply cache and hand back the buffer to write.
   *
   * `lastTurn` is recorded against the rev this write PRODUCES, because that is the rev the
   * retrying reader will load. See the comment on the hash itself.
   */
  private turn(
    buffer: TranscriptBuffer,
    envelope: ProfilingEnvelope,
    input: TurnInput,
    result: TurnResult,
  ): { buffer: TranscriptBuffer; result: TurnResult } {
    const stamped: ProfilingEnvelope = {
      ...envelope,
      lastTurn: {
        // HASHED AGAINST THE POST-WRITE REV (`rev + 1`), which is what a retry will READ.
        // Hashing against the rev this writer read instead makes every replay MISS: the write
        // bumps the rev, so the retrying reader computes a different key and takes a second real
        // turn on the same words — the exact failure Layer A exists to prevent.
        inboundHash: inboundHash(input.sessionId, envelope.rev + 1, input.text),
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
      },
    };
    const at = input.now.toISOString();
    return {
      buffer: {
        ...buffer,
        turnCount: buffer.turnCount + 1,
        messages: [
          ...buffer.messages,
          // BOTH SIDES, VERBATIM — including an abusive turn. `excludeFromParse` keeps it away
          // from the model; it must still reach the audit, or the record of what a worker was
          // asked and answered has a hole in it exactly where a dispute would look.
          { role: "worker" as const, text: input.text, at },
          { role: "assistant" as const, text: result.reply, at },
        ],
        profiling: stamped,
        ...(result.complete ? { completedAt: at } : {}),
        ...(result.completionReason ? { completionReason: result.completionReason } : {}),
      },
      result,
    };
  }
}

/**
 * Fold this turn's elapsed time into the buffer's histogram.
 *
 * A buffer with no envelope is returned untouched: `saveWithCas` rejects one anyway, and
 * inventing an envelope here to hold a metric would hand a CAS token to a value that never had
 * one.
 */
function withTurnLatency(buffer: TranscriptBuffer, elapsedMs: number): TranscriptBuffer {
  const envelope = buffer.profiling;
  if (!envelope) return buffer;
  return {
    ...buffer,
    profiling: { ...envelope, turnLatency: recordTurnLatency(envelope.turnLatency, elapsedMs) },
  };
}

/** Layer A: the same message, at the same rev, inside the window. */
function replayOf(envelope: ProfilingEnvelope, input: TurnInput): TurnResult | null {
  const last = envelope.lastTurn;
  if (!last) return null;
  if (last.inboundHash !== inboundHash(input.sessionId, envelope.rev, input.text)) return null;
  const age = input.now.getTime() - new Date(last.at).getTime();
  // A NEGATIVE age is not a hit. Clock skew between instances would otherwise make a stale entry
  // look arbitrarily fresh, and replaying an old reply is worse than spending a turn.
  if (!Number.isFinite(age) || age < 0 || age > REPLY_CACHE_WINDOW_MS) return null;
  // AN OFFER THAT LOST ITS CHIPS IS NOT A REPLAY, IT IS A DEAD END — fail closed (§3).
  //
  // `narrowLastTurn` parses cached options all-or-nothing, so any chip the contract rejects empties
  // the list, while `kind` narrows independently and survives. Serving that pair tells the client to
  // draw a single-select with nothing in it: on chat a scroller with no chips, on the voice form a
  // question a worker who cannot type has no way at all to answer. Returning null re-runs the turn,
  // which costs one turn; serving it costs the session. All-or-nothing is kept deliberately over
  // per-chip narrowing — a PARTIAL offer would hide the same failure behind a plausible screen.
  if (last.kind === "disambiguate" && last.options.length === 0) return null;
  return {
    reply: last.reply,
    // FROM THE CACHE FOR THE SAME REASON THE OPTIONS ARE (#695). A retried submit over a flaky
    // link is an ordinary event, and re-deriving `ask` here would turn the second delivery of a
    // disambiguation offer into an ordinary question with a chip scroller — the byte-identical
    // replay this cache promises, silently downgraded on exactly the connections that need it.
    kind: last.kind,
    questionKey: last.questionKey,
    // FROM THE CACHE, not empty. These four used to be dropped on the floor here, which made a
    // replay a strictly WORSE response than the one it claims to repeat: same words, no chips, no
    // progress. On chat that costs a scroller and a progress bar; on the voice form it strands a
    // worker who cannot type in front of a question that can only be answered by tapping.
    options: last.options,
    progress: last.progress,
    whyText: last.whyText,
    answerType: last.answerType,
    unansweredEssentials: [],
    complete: false,
    completionReason: null,
    replayed: true,
    excludeFromParse: false,
    unavailable: false,
    // A replay changed NOTHING, so there is nothing new to checkpoint. Firing here would let a
    // client retrying on a flaky connection drive one Postgres UPDATE per retry.
    checkpointDue: false,
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
function outstandingOffer(
  envelope: ProfilingEnvelope,
): { prompt: string; options: QuestionPackOption[] } | null {
  if (!envelope.needsDisambiguation || envelope.disambiguationOffer.length === 0) return null;
  return {
    prompt: DISAMBIGUATION_PROMPT,
    options: envelope.disambiguationOffer.map((chip, index) => toPackOption(chip, index)),
  };
}

function unavailable(): TurnResult {
  return {
    reply: UNAVAILABLE_REPLY,
    // Nothing is on screen to describe, and `ask` is the enum's own neutral value — the same one
    // `ChatService` already serves on this path. A worker retrying into a live session is the
    // whole point of the line, so it must not read as a close.
    kind: "ask",
    questionKey: null,
    options: [],
    progress: { answered: 0, total: 0 },
    // Nothing is on screen to describe. Unlike the replay path above, this is not a lost value:
    // no question was served, so there is no shape.
    whyText: null,
    answerType: null,
    unansweredEssentials: [],
    complete: false,
    completionReason: null,
    replayed: false,
    excludeFromParse: false,
    unavailable: true,
    // Nothing was written to Redis either, so there is no state a checkpoint could make durable.
    checkpointDue: false,
  };
}

/**
 * The two render-shape fields for whichever question is on screen.
 *
 * DERIVED HERE RATHER THAN RETURNED BY `nextQuestion`, because they are not part of the DECISION.
 * The engine chooses which question to ask; `why_text` and `answer_type` are properties of the
 * authored row it chose, and threading them through the pure core would mean four more fields on
 * `Decision` that every one of its construction sites has to keep truthful. One lookup against the
 * same `items` array the decision was made from cannot disagree with it.
 *
 * Null for both when nothing pack-shaped is on screen — a close, or the disambiguation offer,
 * whose chips come from retrieval and belong to no pack row.
 */
function shapeOf(
  items: readonly QuestionPackItem[],
  questionKey: string | null,
): { whyText: string | null; answerType: AnswerType | null } {
  if (questionKey === null) return { whyText: null, answerType: null };
  const item = items.find((candidate) => candidate.question_key === questionKey);
  if (!item) return { whyText: null, answerType: null };
  return { whyText: item.why_text ?? null, answerType: item.answer_type };
}

function progressOf(items: readonly QuestionPackItem[], answers: AnswerMap) {
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
function essentialsOf(items: readonly QuestionPackItem[], answers: AnswerMap): string[] {
  return items
    .filter((item) => item.is_mandatory && !isSettled(answers, item.question_key))
    .map((item) => item.question_key)
    .slice(0, 50);
}
