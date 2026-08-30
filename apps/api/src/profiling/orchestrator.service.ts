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

import {
  routeToTradeForm,
  TRADE_FORM_OFFERS,
  type TradeFormKind,
  type TradeFormOffer,
} from "./trade-form-router";
import { Injectable, Logger } from "@nestjs/common";
import type {
  AnswerRecord,
  AnswerType,
  InputMode,
  QuestionPack,
  QuestionPackItem,
  QuestionPackOption,
  TranscriptLine,
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
import {
  DISAMBIGUATION_PROMPT,
  IdentifyService,
  slugIndexKey,
  toPackOption,
} from "./identify.service";
import { LlmTurnService } from "./llm-turn.service";
import { captureAnswer, hasFieldNormalizer, matchOptions, mayCommit } from "./answer-capture";
import {
  answerSetHash,
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
  MAX_REPLAYS_PER_TURN,
  RETRY_STORM_FLOOR_MS,
  narrowAnswerRecords,
  recordTurnLatency,
  REPLY_CACHE_WINDOW_MS,
  ID_REPLAY_MAX_AGE_MS,
  STALE_RESPONSE_WINDOW_MS,
  TURN_KINDS,
  toEngineState,
  withAnswers,
  type LastTurn,
  type ProfilingEnvelope,
  type TurnKind,
} from "./conversation-state";
import { computeLookahead, type Lookahead } from "./lookahead";
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
  /**
   * What the engine WOULD serve next, per answer the worker could give — so a client on 2G can
   * render the next question on the tap rather than on the round trip. See {@link computeLookahead}.
   *
   * ADVISORY. The next real turn is authoritative and replaces whatever was rendered early; the
   * prediction is deliberately narrow (single-select and decline only) so that "advisory" almost
   * never has to mean "wrong".
   *
   * `null` or absent whenever prediction is not exact — a close, a disambiguation, a clarify, a
   * free-text question, an unavailable turn.
   *
   * OPTIONAL, unlike `kind` directly above, and the asymmetry is deliberate. `kind` is required so
   * a new construction site cannot ship without saying what it put on screen — forgetting it
   * produces a WRONG turn. Forgetting this produces a turn with no prediction, which is exactly
   * what every non-ask path wants anyway: the failure mode of omission is one round trip, not one
   * incorrect question.
   */
  readonly lookahead?: Lookahead | null;
  /**
   * Whether the worker may TYPE this turn's answer, or must choose one of the options.
   *
   * OPTIONAL AND ABSENT MEANS `text`, for the same reason {@link lookahead} is optional: the
   * failure mode of forgetting it is today's behaviour (a keyboard), not a wrong screen. Only
   * two turns ever set it — the experience loop gate and a model turn that asks for one of a
   * closed set — and both still ACCEPT typed text, because shipped clients render the TextField
   * regardless until they honour the wire field. This is an instruction to the client, never a
   * server-side validation: rejecting typed text on it would dead-end every interview running on
   * a build that has not shipped the change yet.
   */
  readonly inputMode?: InputMode;
  /**
   * The trade-form handover card. Set on exactly one turn per interview, null everywhere else.
   *
   * OPTIONAL SO EVERY EXISTING CONSTRUCTION SITE COMPILES UNCHANGED — there are a dozen, and
   * none of them serve a handover. See {@link ../profiling/trade-form-router}.
   */
  readonly formOffer?: TradeFormOffer | null;
}

export interface TurnInput {
  readonly sessionId: string;
  readonly workerId: string;
  readonly text: string;
  readonly now: Date;
  /**
   * The client's id for THIS physical submission, or `null` when the caller has none (#931).
   *
   * The one fact that tells a transport retry from the worker's next answer without guessing at
   * it from a clock — see {@link LastTurn.submissionId} for the defect and the on-device symptom.
   * The client mints it once where the answer commits to the wire and re-sends the same value
   * verbatim on a retry, so equality means "the same submission", not "the same words".
   *
   * REQUIRED AND NULLABLE, never optional. The failure mode of forgetting it at a new call site
   * is silent and it is the original defect: a client that DOES send an id would have it dropped
   * here and be judged by the hash again, with nothing anywhere saying so. Required makes the
   * omission a BUILD failure; `null` is how a caller with no submission behind it — `openTurn`,
   * the finalize re-drive — says so in as many words.
   */
  readonly submissionId: string | null;
  /**
   * The `voice_notes` row these words were SPOKEN into, or `null` when the worker typed them.
   *
   * REQUIRED AND NULLABLE for the same reason {@link submissionId} is, and it is the same class
   * of defect: the caller that knows a clip produced this turn is `ProfilingSessionService`,
   * and if it can silently omit the id then a spoken answer is recorded as typed with nothing
   * anywhere saying so. Required makes the omission a BUILD failure; every caller with no clip
   * behind it — a typed turn, `openTurn`, the finalize re-drive — passes `null` in as many words.
   *
   * Threaded through the buffer rather than written at the turn, because `chat_messages` is
   * written ONCE at flush and this is the only way the fact survives that far.
   */
  readonly voiceNoteId: string | null;
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
  /**
   * The `voice_notes` row these words were SPOKEN into, or `null` for every other method
   * (#1272) — the same field `TurnInput.voiceNoteId` carries for an ordinary turn, so a
   * corrected `chat_messages` row is tagged `"voice"` with a real FK exactly like a first-time
   * spoken answer is (#1244), rather than the flush's provenance convention silently stopping
   * at the correction path's door.
   */
  readonly voiceNoteId: string | null;
  readonly profileAlreadyBuilt: boolean;
  readonly now: Date;
  readonly ctx: RequestContext;
}

export type CorrectAnswerOutcome =
  | {
      readonly kind: "corrected";
      readonly value: unknown;
      readonly correctionCount: number;
      /** Fingerprint of the answer map as written — the rebuild trigger's dedupe key. */
      readonly answerSetHash: string;
    }
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
    private readonly llm: LlmTurnService,
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
      // `replayOf` only ever returns non-null when `envelope.lastTurn` is itself non-null — `last`
      // here is that guarantee made explicit, not a new fact.
      if (replay && envelope.lastTurn) {
        // A RETRY-STORM REPLAY IS SERVED AND NOTHING IS WRITTEN (#858). The budget is already
        // spent, so there is no unit left to consume; what bounds this is `RETRY_STORM_FLOOR_MS`
        // expiring against `lastTurn.at`, which no replay refreshes and which therefore runs out
        // on the wall clock without any write to help it. Writing anyway would put one CAS per
        // duplicate on the exact path a broken client hammers, and — because a consume re-stamps
        // against the new rev — would do it to buy nothing at all.
        //
        // This is NOT the pre-#857 unbounded replay it resembles. That one never went stale
        // because going stale was a write's job and a replay performed none; this one is stale by
        // the clock in at most `RETRY_STORM_FLOOR_MS`, after which `replayOf` declines and the
        // very next identical submission runs a real turn.
        //
        // AND IT IS LOGGED, because this branch is the only evidence that a client is duplicating
        // submissions at all — everything downstream of it looks like a healthy session precisely
        // because the damage was absorbed here. Ids and counters only: the worker's words live in
        // the transcript, which is the one place they belong (§2).
        //
        // THE LOG IS NO LONGER THE ONLY EVIDENCE (#931 step 5). A duplicate is invisible on the
        // event spine — this method returns before `decide()` is consulted, so it writes no
        // `chat_messages` row and emits no `chat.message_received` — and this repo ships, retains
        // and searches no logs at all, so the warn below diagnoses ONE incident and can never
        // answer "is this getting worse". `recordDuplicate` emits the countable half, keyed so a
        // storm collapses to one row.
        if (!replay.consumesBudget) {
          // THE WARN IS FOR THE CLOCK BRANCHES ONLY, and it is unchanged for them (#931). An
          // id-matched replay is a client doing exactly the right thing — re-sending one
          // submission it has no confirmation for — so calling it a storm would train a reader to
          // ignore the line that means a client really is broken. `log`, not `warn`, and it names
          // the id as the decider so a reader can tell "the clock guessed" from "the client knew".
          if (replay.absorbedAs === "client_id") {
            this.logger.log(
              `submission replayed session=${input.sessionId} rev=${envelope.rev} ` +
                `question=${envelope.servedQuestionKey ?? "-"}; the client re-sent the SAME ` +
                `submission id, so the previous reply is served verbatim and nothing is written`,
            );
          } else {
            this.logger.warn(
              `retry storm absorbed session=${input.sessionId} rev=${envelope.rev} ` +
                `replays=${envelope.lastTurn.replays} question=${envelope.servedQuestionKey ?? "-"}; ` +
                `duplicate served from cache and NOT captured — the client is posting one ` +
                `submission more than once`,
            );
          }
          // AFTER the log and BEFORE the return, on a branch that writes nothing to Redis: there
          // is no CAS here whose outcome could make this fact untrue. It never throws — a worker
          // whose duplicate was correctly absorbed must not lose the reply because an audit
          // INSERT failed.
          await this.recordDuplicate(envelope, envelope.lastTurn, replay, input);
          return replay.result;
        }

        // CONSUME ONE UNIT OF THE REPLAY BUDGET before serving it. A replay itself writes nothing,
        // so without this the stamp this matched would never go stale and every further identical
        // submission — including the worker's own next, unrelated turn, if it happens to use the
        // same words — would match it forever, for the whole of `REPLY_CACHE_WINDOW_MS`.
        //
        // THE HASH IS RE-STAMPED, NOT LEFT ALONE, against the rev this write produces — the exact
        // rule `turn()` stamps a fresh reply by. Bumping `rev` without re-stamping would invalidate
        // the entry after this ONE serve regardless of `replays`, silently capping the budget at
        // one no matter what `MAX_REPLAYS_PER_TURN` says: a second genuine retry, arriving after
        // THIS write landed, would compute a hash against the new rev that no longer matches the
        // stale one and would incorrectly run a real turn instead of replaying. Re-stamping keeps
        // the entry matchable at the new rev, so `replays` — not `rev` drift — is what decides when
        // the budget runs out.
        //
        // `at` IS DELIBERATELY LEFT UNTOUCHED. It anchors the window to the ORIGINAL real turn, so
        // the total time this session may spend replaying one stamp is bounded at
        // `REPLY_CACHE_WINDOW_MS` regardless of how many retries land inside it — refreshing it
        // here would let each consume buy the window another `REPLY_CACHE_WINDOW_MS`, which is the
        // unbounded-loop failure this whole mechanism exists to close.
        //
        // THE SPREAD CARRIES `submissionId` FORWARD UNTOUCHED (#931), which is correct rather than
        // incidental: this stamp still describes the ORIGINAL real turn and the submission that
        // produced it. Re-stamping it with the duplicate's own id would make the stamp claim the
        // retry was the real turn, and — where the two ids differ — would hand the NEXT retry of
        // the first submission a stamp it no longer matches.
        const last = envelope.lastTurn;
        const consumed: TranscriptBuffer = {
          ...buffer,
          profiling: {
            ...envelope,
            lastTurn: {
              ...last,
              inboundHash: inboundHash(input.sessionId, envelope.rev + 1, input.text),
              replays: last.replays + 1,
            },
          },
        };
        const held = await this.buffer.saveWithCas(input.sessionId, consumed, envelope.rev);
        if (held) {
          // AFTER THE CAS, NEVER BEFORE — the same rule `persistPin` follows below. This branch is
          // the one duplicate path that WRITES, and an attempt that loses the write did not
          // happen: emitting before it would record a duplicate for a decision that was then
          // thrown away and re-evaluated from the winner's state, double-counting the one real
          // event the loop eventually emits.
          await this.recordDuplicate(envelope, last, replay, input);
          return replay.result;
        }
        // Lost the race — someone else already wrote (a real turn, or another caller consuming the
        // same replay slot). Reload and re-evaluate against whatever landed, exactly as a lost CAS
        // does below.
        this.logger.log(
          `replay-consume lost session=${input.sessionId} rev=${envelope.rev} ` +
            `attempt=${attempt + 1}; reloading and re-evaluating against the winner's state`,
        );
        continue;
      }

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
      // Same split as `decide` — see the note there. A reopened session must not report a
      // different denominator from the turn loop it is about to hand back to.
      const openSelectable = selectableEnginePacks(envelope, packs.engine);
      const progressItems = [
        ...(openSelectable.occupation?.items ?? []),
        ...openSelectable.universal.items,
      ];
      // THE SAME SEAM `decide` APPLIES, and this reader needs it just as badly. A closed interview
      // has no `servedQuestionKey` at all, so the re-serve below finds nothing and a cold start or
      // resume-after-kill falls straight through to `nextQuestion` — which, without this, would
      // open the screen on the very trade-pack question the turn loop has been declining to ask.
      // `items` above is deliberately built from the full resolved pair, not from this: see
      // {@link selectableEnginePacks}.
      const engine = selectableEnginePacks(envelope, packs.engine);
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
          progress: progressOf(progressItems, answers),
          unansweredEssentials: essentialsOf(items, answers),
          complete: false,
          completionReason: null,
          replayed: true,
          excludeFromParse: false,
          unavailable: false,
          checkpointDue: false,
        };
      }

      // THE MODEL'S QUESTION OUTRANKS THE PACK RE-SERVE for the same reason the offer above
      // does: it belongs to no pack, so the lookup below cannot find it and would answer a cold
      // start mid-Phase-A by serving an authored question instead.
      const asked = outstandingLlmAsk(envelope, this.llm.leads(envelope));
      if (asked) {
        return {
          reply: asked.prompt,
          kind: "ask",
          questionKey: null,
          options: asked.options,
          whyText: null,
          answerType: asked.answerType,
          // DERIVED, because `lastTurn` does not cache it: the gate is the only turn the engine
          // itself sends `options_only`, and a model turn that asked for one re-opens with the
          // keyboard available — which is what every shipped client does anyway.
          inputMode: envelope.llmGateOpen ? "options_only" : "text",
          progress: progressOf(progressItems, answers),
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
      // SEARCHED IN THE SELECTABLE SET, NOT THE FULL ONE. The note above says a closed interview
      // has no `servedQuestionKey`, and that is true of every envelope THIS build writes. It is
      // not true of one the previous build wrote: a session that finished Phase A before this
      // shipped can be sitting on `machine_type` with the pack now suppressed, and re-serving it
      // here would ask the one trade question the change exists to stop asking — after which the
      // engine never offers it again, so the worker answers a question nothing will follow up.
      // Bounded to one leftover question inside the deploy window, and zero today because the
      // flag is default OFF, which is exactly why it is cheaper to close than to remember.
      const served = progressItems.find((item) => item.question_key === envelope.servedQuestionKey);
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
          progress: progressOf(progressItems, answers),
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
      const decision = nextQuestion(toEngineState(envelope, buffer.turnCount), engine);
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
        // The opening line is the platform's, so it carries no clip — see the worker/assistant
        // split in `takeTurn`'s append.
        messages: [
          ...buffer.messages,
          { role: "assistant" as const, text: reply, at, voiceNoteId: null },
        ],
        profiling: next,
      };

      if (await this.buffer.saveWithCas(input.sessionId, opened, envelope.rev)) {
        await this.persistPin(envelope, next, {
          sessionId: input.sessionId,
          workerId: input.workerId,
          text: "",
          now: input.now,
          // NO SUBMISSION BEHIND THIS ONE (#931). `openTurn` puts the first question on screen
          // without a worker having sent anything, so there is no client id to carry and
          // inventing one would stamp a submission that never happened.
          submissionId: null,
          // And no clip either, for the same reason: nothing was spoken to open the screen.
          voiceNoteId: null,
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
          // #766 item 2 — THE OPENING TURN GETS A PREDICTION TOO.
          //
          // `computeLookahead` was wired only into `decide()`, so the FIRST question of every
          // session — the one a worker waits on with nothing on screen yet, on a cold start over
          // 2G — was the one turn that could not render its successor instantly. That is the
          // round trip the feature exists to remove, skipped on the turn where it is most felt.
          //
          // `turnCount` is deliberately NOT bumped by an opening turn (there is no worker message
          // to record), so THIS turn is `buffer.turnCount` and the worker's first answer will be
          // `buffer.turnCount + 1` — the same current/next relationship `decide()` builds from
          // its own `turn`. `next` is the post-turn envelope, which is what the contract requires.
          lookahead: computeLookahead({
            decision,
            state: toEngineState(next, buffer.turnCount),
            packs: engine,
            items,
            nextTurn: buffer.turnCount + 1,
          }),
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
    // ONE DENOMINATOR FOR THE WHOLE SESSION. `items` stays the FULL pinned universe, because
    // settlement, `shapeOf` and `essentialsOf` all have to keep seeing the trade pack's rows —
    // every `skills` question in the corpus lives in an occupation pack, and narrowing that list
    // would take Phase A's skills out of `answer_map`. Progress is a different question and gets
    // its own list: what the worker will actually BE ASKED.
    //
    // WITHOUT THIS SPLIT THE BAR MOVES BACKWARDS. `decision.progress` is computed over the
    // narrowed packs, while every non-decision branch — silence, hardship, de-escalation, clarify
    // — counted the full union, so a post-Phase-A machinist saw 1/8 on an ask turn and 1/12 the
    // moment they went quiet or asked a question back, then 2/8 again. `progress.fraction` is a
    // wire field both surfaces render, and this file calls it the single biggest lever on
    // completion rate for low-literacy users; a bar that retreats when a worker hesitates is not
    // a cost the pack skip was signed off with.
    const selectable = selectableEnginePacks(envelope, packs.engine);
    let progressItems = [...(selectable.occupation?.items ?? []), ...selectable.universal.items];
    const askedItem =
      items.find((item) => item.question_key === envelope.servedQuestionKey) ?? null;
    // THE SAME QUESTION, BUT ONLY IF THE ENGINE WOULD STILL SERVE IT — the re-serve twin of
    // `askedItem`, and the two are deliberately different objects.
    //
    // `askedItem` is resolved from the FULL pinned union because it is what CAPTURES the worker's
    // answer, and an answer must never be dropped because the question behind it went out of
    // scope. But three branches below (de-escalation, silence, hardship) do not capture anything
    // — they PUT THE QUESTION BACK ON SCREEN — and a suppressed trade question re-served there is
    // the exact thing {@link selectableEnginePacks} exists to stop, arriving through the one door
    // it does not guard. Reachable whenever a session written by the previous build resumes with
    // `servedQuestionKey` naming a pack row this build will no longer select: bounded to the
    // deploy window, and cheaper to close than to remember.
    //
    // Null here does NOT mean "say nothing". The silence branch falls through to the engine (its
    // guard is already "is there text to re-serve"), and the other two serve their line above a
    // question key of null — the same shape they already return for a brand-new session with
    // nothing on screen yet.
    const reservableItem =
      askedItem && progressItems.some((item) => item.question_key === askedItem.question_key)
        ? askedItem
        : null;

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
          // words above it differ. NARROWED — see {@link reservableItem}: a question the engine
          // has stopped selecting is not on screen, so naming it here would put it back.
          kind: "ask",
          questionKey: reservableItem?.question_key ?? null,
          options: reservableItem?.options ?? [],
          ...shapeOf(items, reservableItem?.question_key ?? null),
          progress: progressOf(progressItems, answers),
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
      // NARROWED (see {@link reservableItem}). A suppressed trade question yields "" here and
      // the guard below falls through to the engine, which is the right answer: the interview
      // moves on rather than re-serving a question it has stopped asking.
      const reserved = reservableItem
        ? servedText(
            reservableItem,
            askCount(toEngineState(next, turn), reservableItem.question_key),
          )
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
          questionKey: reservableItem?.question_key ?? null,
          options: reservableItem?.options ?? [],
          ...shapeOf(items, reservableItem?.question_key ?? null),
          progress: progressOf(progressItems, answers),
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
          // An acknowledgement above the question that is still on screen. NARROWED — see
          // {@link reservableItem}.
          kind: "ask",
          questionKey: reservableItem?.question_key ?? null,
          options: reservableItem?.options ?? [],
          ...shapeOf(items, reservableItem?.question_key ?? null),
          progress: progressOf(progressItems, answers),
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
      // `selectable`, NOT `packs.engine`. `clarify` looks the on-screen question up in the pair
      // it is given and then RE-SERVES IT under its own why-text, so handing it the full union
      // was a second door onto the suppressed trade pack. Handed the narrowed pair it returns
      // null for a question the engine no longer selects, and the branch falls through to
      // `nextQuestion` — the worker's "kyun?" moves the interview on instead of re-asking a
      // question that is not on screen. It also fixes the progress `clarify` reports, which is
      // computed over the very pair passed here.
      const clarified = clarify(state, selectable);
      if (clarified) {
        // NEVER counts as an ask. The worker asked a reasonable question and deserves an answer,
        // not a spent budget — `why_text` first, then the same question again on the same turn.
        next = { ...next, clarifyCount: next.clarifyCount + 1, silentTurns: 0 };
        return this.turn(buffer, next, input, {
          reply: joinClarify(
            clarified,
            reservableItem,
            reservableItem ? askCount(state, reservableItem.question_key) : 0,
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
        progress: progressOf(progressItems, answers),
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
        // The re-pin changes which questions exist, so the denominator moves with it.
        const repinnedSelectable = selectableEnginePacks(next, repinned.engine);
        progressItems = [
          ...(repinnedSelectable.occupation?.items ?? []),
          ...repinnedSelectable.universal.items,
        ];
      }
    }

    // --- PHASE A: the model chooses the question ----------------------------
    //
    // AT THE SELECTION SEAM, NOT ABOVE IT. Everything before this line still runs exactly as it
    // does for a deterministic interview: the turn classes bound abuse and hardship, the worker's
    // answer to whatever WAS on screen is captured, free information is filled cross-question,
    // and retrieval pins the pack. The model replaces question SELECTION and nothing else — so
    // `answer_map` keeps filling underneath the conversation, which is what makes both the
    // fallback and Phase C work on an interview that switched engines halfway through.
    //
    // `next` is passed rather than `envelope`: the draft this turn's patch is folded into must be
    // the one carrying this turn's answers, or a fallback would lose them.
    if (this.llm.leads(next)) {
      const led = await this.llm.take(next, input.text, transcriptOf(buffer), {
        workerId: input.workerId,
        // The turn's spend is attributed to THIS session — the same `chat_sessions.id` the
        // extraction job records — so per-interview cost is one indexed row, not a scan.
        sessionId: input.sessionId,
        correlationId: input.ctx.correlationId,
        requestId: input.ctx.requestId,
      });

      if (led === null) {
        // THE MODEL WENT AWAY. Sticky from here, and the gate is closed on the way out — leaving
        // it open would make the worker's next sentence be read as a yes/no to a question the
        // engine is about to replace.
        next = { ...next, llmFallback: true, llmGateOpen: false };
        await this.recordFallback(next, input);
        // AND SETTLE WHAT PHASE A ALREADY LEARNED, on the way out.
        //
        // THE DEFECT THIS CLOSES. `settleFromLlmDraft` used to run on the `done` branch only, so
        // an interview that spent five turns on a worker's welding and THEN lost the model kept
        // its trade, its skills and its experience nowhere but the transcript — and the engine
        // opened the tail by asking `primary_trade` ("Aap kaunsa kaam karte hain?") to a worker
        // who had just spent five turns answering it. The fallback is a fall-through, and a
        // fall-through that discards everything gathered so far is a restart wearing its costume.
        //
        // IT IS ALSO WHAT MAKES THE PACK SKIP SAFE FOR THIS BRANCH. {@link selectableEnginePacks}
        // now suppresses the occupation pack for a fallen-back interview too, and its previous
        // refusal to do so rested entirely on this settlement not existing. Same `llmLedTurns > 0`
        // test on both sides, so the two cannot drift: a session whose draft is settled is exactly
        // the session whose pack is suppressed.
        //
        // GUARDED ON `llmLedTurns`, NOT ON THE DRAFT BEING NON-EMPTY, because `settleFromLlmDraft`
        // falls `trade` back to the RETRIEVAL PIN when the draft has no label. On a first-turn
        // fallback that would settle `primary_trade` from a pin the worker has not confirmed and
        // that Phase A never got to test — filling in an answer for an interview that never
        // happened. Zero led turns means zero settlement, and the pack asks the questions.
        if (next.llmLedTurns > 0) {
          answers = settleFromLlmDraft(
            answers,
            next.llmDraft,
            next.occupation?.label ?? null,
            items,
            turn,
          );
          next = withAnswers(next, answers);
          // COUNTS ONLY — no draft text, no transcript, no worker identity beyond the session
          // (§3 Privacy First). This is the line that separates "the model was never there" from
          // "the model left mid-interview", which is the distinction the fallback EVENT cannot
          // carry: its payload is `.strict()` at v1 and `asks` undercounts by exactly the gate
          // turn. Without it the two cases are indistinguishable in production, and they now have
          // opposite consequences for the worker's trade pack.
          this.logger.log(
            `Phase A fell back after leading session=${input.sessionId} ` +
              `led=${next.llmLedTurns} asks=${next.llmAsks} stage=${envelope.llmStage}; ` +
              `its draft was settled and the occupation pack will not be re-asked`,
          );
        }
        // ...and FALL THROUGH. `nextQuestion` below serves the next question, which is the whole
        // design: one branch, not a second engine to keep in step.
      } else {
        next = { ...next, ...led.patch };

        // --- THE TRADE-FORM HANDOVER ----------------------------------------
        //
        // BEFORE THE `ask` BRANCH, NOT AFTER IT. The routing evidence is the draft the patch
        // above just folded in, and that draft is complete the moment the model names the trade
        // -- which is usually the SAME turn it wants to ask its next question on. Checking after
        // the ask branch would serve that question first and hand over one turn late, which is
        // one more question than a worker who has already said what they do needs to answer.
        //
        // AI PROPOSES, CODE DECIDES (section 3). The model contributes two free-text labels;
        // every rule about what they mean lives in `routeToTradeForm`, which is pure, closed and
        // unit-tabled. A model that hallucinates a trade cannot route a worker anywhere.
        const formKind = routeToTradeForm({
          draft: next.llmDraft,
          occupationFamilyId: next.occupationFamilyId,
          // THE PIN, WHICH IS READY A TURN BEFORE THE MODEL'S DRAFT IS. Retrieval resolves the
          // worker's first sentence against the catalogue on this same turn, whereas the model
          // may answer "cnc turning" by asking its next question and leaving `domain_label` null
          // — which cost a real worker an extra question about materials before the handover.
          occupationLabel: next.occupation?.label ?? null,
        });
        if (formKind !== null) {
          // SETTLE FIRST, END SECOND. Everything Phase A learned becomes answers before the
          // interview closes, for the same reason the fallback branch settles: the form picks
          // up from the answer map, and a handover that discarded the trade would open the form
          // by asking a worker the one question they have already answered. Unguarded by
          // `llmLedTurns` here -- unlike the fallback -- because routing REQUIRES a label, so
          // there is always a draft to settle and never a bare retrieval pin to settle from.
          answers = settleFromLlmDraft(
            answers,
            next.llmDraft,
            next.occupation?.label ?? null,
            items,
            turn,
          );
          next = withAnswers(next, answers);
          next = {
            ...next,
            formKind,
            // PHASE A IS OFF FOR GOOD. `leads()` gates on the stage, so this is what makes the
            // handover survive a reload -- and `llmGateOpen` closes with it, or the worker next
            // sentence would be read as a yes/no to a question no longer on screen.
            llmStage: "done",
            llmGateOpen: false,
            phase: "close",
            servedQuestionKey: null,
          };
          await this.recordFormHandoff(next, input, formKind);
          const offer: TradeFormOffer = TRADE_FORM_OFFERS[formKind];
          return this.turn(buffer, next, input, {
            reply: offer.reply,
            kind: "close",
            questionKey: null,
            options: [],
            answerType: null,
            whyText: null,
            inputMode: "text",
            progress: progressOf(progressItems, answers),
            unansweredEssentials: essentialsOf(items, answers),
            // COMPLETE, so the flush transaction runs and the answer map is DURABLE before the
            // worker leaves for the form. A handover that left the session open would
            // checkpoint only every fifth ask, and a two-turn interview never reaches a fifth.
            complete: true,
            completionReason: "form_handoff",
            replayed: false,
            excludeFromParse: capture.excludeFromParse,
            unavailable: false,
            checkpointDue: false,
            formOffer: offer,
          });
        }

        if (led.kind === "ask") {
          // NO `servedQuestionKey`. A model's question belongs to no pack, and claiming a pack's
          // key for it would make the next turn's `askedItem` lookup capture the answer as that
          // question's — the same rule the disambiguation offer follows one branch up.
          next = { ...next, phase: "llm_interview", servedQuestionKey: null };
          const options = led.chips.map(toLlmOption);
          return this.turn(buffer, next, input, {
            reply: led.reply,
            kind: "ask",
            questionKey: null,
            options,
            // ASSERTED, NOT LOOKED UP, exactly as the disambiguation branch does it: there is no
            // pack row to read an `answer_type` off. Chips mean one tap becomes the answer;
            // without them the worker speaks or types.
            answerType: options.length > 0 ? "single_select" : "text",
            whyText: null,
            inputMode: led.inputMode,
            progress: progressOf(progressItems, answers),
            unansweredEssentials: essentialsOf(items, answers),
            complete: false,
            completionReason: null,
            replayed: false,
            excludeFromParse: capture.excludeFromParse,
            unavailable: false,
            // An LLM ask spends no ENGINE ask, so it can never cross a checkpoint boundary.
            checkpointDue: false,
          });
        }
        // `done` — Phase A is over. What the model gathered becomes ANSWERS before the engine is
        // consulted, or the template tail opens by asking a worker their trade immediately after
        // a conversation that was largely about it.
        answers = settleFromLlmDraft(
          answers,
          next.llmDraft,
          next.occupation?.label ?? null,
          items,
          turn,
        );
        next = withAnswers(next, answers);
        // FALL THROUGH so the engine serves the template pack's first question on THIS turn:
        // returning the model's closing words here would cost the worker a round trip to see a
        // bubble with no question in it.
      }
    }

    // --- The decision -------------------------------------------------------
    //
    // REASSIGNED RATHER THAN PASSED, and that is the point: `engine` is read twice below — once by
    // `nextQuestion` and once by `computeLookahead` — and narrowing only the first would have the
    // client pre-render, and on the voice form SPEAK, a trade-pack question the engine will never
    // actually serve. One assignment keeps the decision and its prediction in agreement by
    // construction. AFTER the re-pin above, so the pack is still resolved and still pinned; see
    // {@link selectableEnginePacks} for why an interview Phase A led stops selecting from it.
    engine = selectableEnginePacks(next, engine);
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
      // COMPUTED FROM `next`, THE POST-TURN STATE, and from the same `engine` and `items` this
      // decision was made against — including after the mid-turn re-pin above, so the prediction
      // is made over the worker's own trade rather than the universal pack it replaced.
      lookahead: computeLookahead({
        decision,
        state: toEngineState(next, turn),
        packs: engine,
        items,
        nextTurn: turn + 1,
      }),
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
    // Same split as `decide` — the review screen counts what the worker will be asked, while
    // `items` stays whole for the rows it renders.
    const viewSelectable = packs ? selectableEnginePacks(envelope, packs.engine) : null;
    const progressItems = viewSelectable
      ? [...(viewSelectable.occupation?.items ?? []), ...viewSelectable.universal.items]
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
          progress: progressOf(progressItems, answers),
        },
      };
    }

    // AND THE MODEL'S QUESTION OUTRANKS IT TOO — the same precedence `openTurn` applies, through
    // the same helper, so the two readers of a reopened session cannot disagree about what the
    // worker is looking at.
    const asked = outstandingLlmAsk(envelope, this.llm.leads(envelope));
    if (asked) {
      return {
        buffer,
        envelope,
        items,
        served: {
          questionKey: null,
          promptText: asked.prompt,
          answerType: asked.answerType,
          options: asked.options,
          whyText: null,
          progress: progressOf(progressItems, answers),
        },
      };
    }

    // SEARCHED IN THE SELECTABLE SET, NOT THE FULL ONE — the same narrowing `openTurn` applies,
    // and for the same reason plus one more. `openTurn` was narrowed when the pack skip shipped
    // and this reader was not, so the two readers of one reopened session disagreed again about
    // what the worker is looking at — the precise class of bug `outstandingOffer` was written to
    // close. This one is not a display artefact: `ProfilingSessionService.answer` guards on
    // `served?.questionKey !== dto.question_key`, so this lookup is what decides whether a voice
    // form's answer is accepted, and `review`/`finalize` read it too. Reporting a suppressed
    // trade question here would accept an answer to a question the turn loop has stopped asking.
    const item = progressItems.find(
      (candidate) => candidate.question_key === envelope.servedQuestionKey,
    );
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
            progress: progressOf(progressItems, answers),
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
      // A SPOKEN CORRECTION IS A TRANSCRIPT LINE TOO (#1272). `takeTurn` appends every turn's
      // words to the buffer, which reaches `chat_messages` at flush — but a correction runs
      // OUTSIDE the turn loop and, until now, never touched the buffer OR `chat_messages`, so a
      // worker's corrected wording lived only as a captured value and never as conversation.
      //
      // WRITTEN HERE, NOT VIA THE BUFFER. `viewSettled` reads `chat_sessions` directly rather
      // than Redis precisely because the buffer is GONE by the time a correction is reachable —
      // it is dropped the instant the flush commits, which is the same instant the review screen
      // (the correction's only entry point) becomes reachable; see `ChatRepository.listPackAnswers`
      // and the `answer-correction.test.ts` proof that this path is built with no buffer at all.
      // Appending to a buffer that will never flush again would durably lose the line at the next
      // TTL sweep while looking like it had been saved. `insertMessages` is the SAME repository
      // call and the SAME row shape `finalizeInterview`/`abandonInterview` use at flush time — the
      // existing mechanism, reused, rather than a second way to write a `chat_messages` row.
      //
      // TEXT ONLY, NEVER TYPED/CHIP CORRECTIONS: those already have their exact submitted value in
      // `worker_pack_answer`, and #1272 scopes this to the spoken gap specifically.
      //
      // NO NEW EVENT. `profile.answer_corrected` below already covers this state change (invariant
      // #1: one event per change) — this row is a read-path fix for extraction and the audit
      // transcript, not a second thing that happened.
      //
      // SAME PROVENANCE CONVENTION `toMessageRow` USES (#1244/#1272): `messageType` and
      // `voiceNoteId` are derived from `input.voiceNoteId`, never hardcoded — a spoken correction
      // is tagged `"voice"` with the clip's real FK, exactly like a first-time spoken answer.
      if (input.method === "spoken") {
        await this.chat.insertMessages(tx, [
          {
            sessionId: input.sessionId,
            workerId: input.workerId,
            direction: "inbound",
            messageType: input.voiceNoteId === null ? "text" : "voice",
            voiceNoteId: input.voiceNoteId,
            bodyText: input.text,
            createdAt: input.now,
          },
        ]);
      }
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

    return {
      kind: "corrected",
      value: record.value_normalized,
      correctionCount,
      // The fingerprint of the map that was JUST WRITTEN, handed back rather than recomputed by
      // the caller: the rebuild trigger keys on it, and a hash of anything other than exactly
      // what landed would dedupe against the wrong answer set.
      answerSetHash: answerSetHash(answers),
    };
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
  /**
   * The model stopped leading and the engine took over. Recorded ONCE per session.
   *
   * EMITTED FROM INSIDE `decide()`, WHICH RUNS UNDER THE CAS RETRY — so a losing attempt can
   * reach this line and then be thrown away. The session-scoped idempotency key is what makes
   * that harmless, and it is the same backstop `profile.pack_pinned` relies on for at-least-once
   * delivery. Emitting after the CAS instead would need the fallback decision threaded out of the
   * decision and back in, for a fact that is true of the SESSION rather than of the turn.
   *
   * NEVER THROWS. A worker whose interview just lost the model must not also lose the turn
   * because the audit write failed; the fallback itself is already the recovery path.
   */
  private async recordFallback(envelope: ProfilingEnvelope, input: TurnInput): Promise<void> {
    try {
      await this.events.emit({
        event_name: "profile.llm_interview_fallback",
        actor: { actor_type: "worker", actor_id: input.workerId },
        subject: { subject_type: "chat_session", subject_id: input.sessionId },
        payload: {
          worker_id: input.workerId,
          session_id: input.sessionId,
          // EVERY TRANSPORT FAILURE COLLAPSED, because `llmTurn` returns one `null` for all of
          // them. A finer reason here would be this layer guessing at something it cannot see.
          reason: "unavailable",
          stage: envelope.llmStage,
          asks: envelope.llmAsks,
        },
        idempotencyKey: `profile.llm_interview_fallback:${input.sessionId}`,
        correlationId: input.ctx.correlationId,
        requestId: input.ctx.requestId,
      });
    } catch (error) {
      this.logger.error(
        `the LLM-interview fallback for session ${input.sessionId} was not recorded; the ` +
          `interview continues on pack questions but the switch is now invisible: ` +
          `${(error as Error).message}`,
      );
    }
  }

  /**
   * The interview handed over to a trade form -- the countable half of that fact.
   *
   * SWALLOWS ITS OWN FAILURE, exactly as {@link recordFallback} does. The handover has already
   * happened in the envelope by the time this runs; throwing here would fail the turn and roll
   * a worker back into an interview that had correctly decided to end, to protect a telemetry
   * row. The log line is the fallback record.
   */
  private async recordFormHandoff(
    envelope: ProfilingEnvelope,
    input: TurnInput,
    formKind: TradeFormKind,
  ): Promise<void> {
    try {
      await this.events.emit({
        event_name: "profile.form_mode_entered",
        actor: { actor_type: "worker", actor_id: input.workerId },
        subject: { subject_type: "chat_session", subject_id: input.sessionId },
        payload: {
          worker_id: input.workerId,
          session_id: input.sessionId,
          form_kind: formKind,
          // THE COST OF THE FEATURE. A handover on turn one is the design; on turn nine it is
          // Phase A failing to recognise a trade it should have caught on the first answer.
          llm_led_turns: envelope.llmLedTurns,
          asks: envelope.llmAsks,
        },
        // ONCE PER SESSION -- `formKind` is set once and never cleared, so a second row would
        // misreport how often the handover fired.
        idempotencyKey: `profile.form_mode_entered:${input.sessionId}`,
        correlationId: input.ctx.correlationId,
        requestId: input.ctx.requestId,
      });
    } catch (error) {
      this.logger.error(
        `the trade-form handover for session ${input.sessionId} was not recorded; the worker ` +
          `is on the ${formKind} form but the switch is now invisible: ` +
          `${(error as Error).message}`,
      );
    }
  }

  /**
   * ONE PHYSICAL SUBMISSION ARRIVED TWICE — the countable half of that fact (#931 step 5).
   *
   * WHY A LOG LINE WAS NOT ENOUGH, given one already exists. A duplicate is invisible on the event
   * spine by construction: `takeTurn` returns before `decide()` runs, so there is no
   * `chat_messages` row, no `chat.message_received`, and no counter anywhere that moves —
   * everything downstream looks like a healthy session precisely because the damage was absorbed.
   * The only prior evidence was the `retry storm absorbed` warn, and it covers ONE of the three
   * clock branches (the ordinary first flaky-link retry logged nothing at all), into stdout, in a
   * repo that ships, retains and searches no logs. A log answers "what happened in this session";
   * only a queryable event answers "is this getting worse", which is the shape of every question a
   * client-side retry defect is diagnosed by.
   *
   * IT IS ALSO THE ROLLOUT TELEMETRY #931 STEP 4 IS GATED ON. `absorbed_as` says which rule served
   * each duplicate and `inbound_had_id` says whether the client sent an id at all; the four
   * reply-cache clocks may only be retired once the clock branches go to zero in the field, and
   * until then they stay exactly as they are for every build that has not shipped the id.
   *
   * ONE ROW PER DUPLICATED SUBMISSION, NOT PER POST. The idempotency key is the submission id when
   * there is one, so a client hammering one submission fifty times collapses to a single row —
   * which is what keeps this from becoming the per-turn event volume the architecture rules out.
   * With no id it falls back to the rev the duplicate was READ at, which is equally stable across
   * a storm (a storm writes nothing, so the rev does not move).
   *
   * ON THE ROUND TRIPS IT DOES COST: this is one keyed INSERT on a path that already performs a
   * Postgres SELECT per POST (`runTurn`'s session-ownership read), so it is not a new class of
   * cost on the path a broken client hammers — unlike the CAS write the storm branch deliberately
   * refuses, which would buy nothing at all.
   *
   * NEVER THROWS. A worker whose duplicate was correctly absorbed must not lose the reply because
   * an audit INSERT failed — the reply is already in hand and nothing about it depends on this.
   */
  private async recordDuplicate(
    envelope: ProfilingEnvelope,
    last: LastTurn,
    replay: Replay,
    input: TurnInput,
  ): Promise<void> {
    try {
      // CLAMPED, NOT TRUSTED. `at` is rehydrated from Redis and the id path deliberately consults
      // no clock at all, so a skewed or drifted stamp can produce a negative or non-finite age
      // here — neither of which the payload's `int().nonnegative()` accepts. Reporting 0 costs one
      // observability field; letting it throw costs the emit, on the branch that exists to make
      // this visible.
      const rawAge = input.now.getTime() - new Date(last.at).getTime();
      const elapsedMs = Number.isFinite(rawAge) ? Math.max(0, Math.trunc(rawAge)) : 0;
      await this.events.emit({
        event_name: "profile.submission_duplicated",
        actor: { actor_type: "worker", actor_id: input.workerId },
        subject: { subject_type: "chat_session", subject_id: input.sessionId },
        payload: {
          worker_id: input.workerId,
          session_id: input.sessionId,
          // FILTERED AT THE BOUNDARY, not trusted — the same wall `chat.service.ts` puts in front
          // of `answered_topics`. The `^[a-z_]+$` shape is what makes this field structurally
          // incapable of carrying a worker's words, and "pack keys are slugs by construction" is a
          // property of today's corpus rather than of this mechanism. A key that fails it is
          // reported as null, which costs one field; passing it through would fail the payload
          // schema and cost the whole event.
          question_key: eventQuestionKey(envelope.servedQuestionKey),
          absorbed_as: replay.absorbedAs,
          // THE INBOUND'S OWN id, not the match. A build that sends an id still lands on a clock
          // branch when the STAMP predates the deploy, and counting `absorbed_as` alone would read
          // that as "the app has not rolled out" long after it has.
          inbound_had_id: input.submissionId !== null,
          replays: last.replays,
          elapsed_ms: elapsedMs,
        },
        // KEYED ON THE SUBMISSION, so N copies of ONE physical send are one row. The raw id is
        // NOT a payload field: it is client-supplied, this key already persists it verbatim in
        // `events.idempotency_key`, and a second copy inside the payload would be an unvalidated
        // client string in the audit spine. Namespaced with the event name because the unique
        // index is on the key COLUMN alone, platform-wide.
        idempotencyKey:
          `profile.submission_duplicated:${input.sessionId}:` +
          // KEYED ON THE STAMP, NEVER ON THE INBOUND. Keyed on `input.submissionId` this row
          // was writable at will: the asymmetric case (inbound has an id, stamp does not) falls
          // to the clock branches, which write nothing to Redis and never refresh `last.at`, so
          // an authenticated worker re-POSTing identical text with a FRESH uuid each time — on
          // routes with no rate limiter — minted a unique key per request and appended without
          // bound to the `events` audit spine. `last.inboundHash` is sha256(session, rev, text):
          // stable across a whole storm, so the documented one-row-per-duplicated-submission
          // ceiling holds, and not client-supplied, so it cannot be rotated. It also survives a
          // lost Redis buffer, which `rev` does not — `rev` restarts at 0 and would collide a
          // post-restore duplicate with a pre-loss row, silently undercounting exactly the clock
          // branches whose falling to zero is the signal to retire the four constants (step 4).
          `${last.inboundHash}`,
        correlationId: input.ctx.correlationId,
        requestId: input.ctx.requestId,
      });
    } catch (error) {
      this.logger.error(
        `the duplicate submission on session ${input.sessionId} was not recorded; the worker's ` +
          `reply was served correctly but the duplicate is now invisible to the rollout ` +
          `telemetry #931 step 4 reads: ${(error as Error).message}`,
      );
    }
  }

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
        // #766 item 2 — the prediction rides along, for the reason stated one line up: taken off
        // `result` so the replay is the SAME response rather than a second derivation. Without it
        // a retried submit replayed the words and silently dropped the instant next-question
        // render, on exactly the flaky link that caused the retry.
        lookahead: result.lookahead ?? null,
        inputMode: result.inputMode ?? "text",
        // A FRESH STAMP. This reply has not been served as a replay yet, so it gets the whole
        // budget — see `LastTurn.replays`.
        replays: 0,
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
          // THE PROVENANCE LANDS ON THE WORKER LINE ONLY. `input.voiceNoteId` describes the
          // clip the worker spoke; the reply below it is the platform's own text and can never
          // have one, so it is `null` structurally rather than by omission.
          { role: "worker" as const, text: input.text, at, voiceNoteId: input.voiceNoteId },
          { role: "assistant" as const, text: result.reply, at, voiceNoteId: null },
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

/**
 * A cache hit, and WHAT SERVING IT COSTS.
 *
 * The two are returned together because they are one decision made from one set of facts, and the
 * caller can re-derive neither: `replayOf` owns every rule about the stamp — the hash, the window,
 * the budget, the storm floor — and a `takeTurn` that re-tested `replays` to decide whether to
 * write would be a second copy of the budget rule, free to disagree with the first.
 */
interface Replay {
  readonly result: TurnResult;
  /**
   * Whether serving this replay must WRITE, spending one unit of the stamp's budget.
   *
   * True for a replay served FROM the budget: without the write the stamp would never go stale and
   * the interview would sit on one reply for the whole window (#857). False for a retry-storm
   * replay, whose budget is already spent — there is nothing left to consume, and what bounds it
   * is `RETRY_STORM_FLOOR_MS` running out on the wall clock rather than a counter running down.
   */
  readonly consumesBudget: boolean;
  /**
   * WHICH RULE decided this was a duplicate — the label `profile.submission_duplicated` carries.
   *
   * RETURNED RATHER THAN RE-DERIVED, for the reason stated above: `stale` and `storm` are both
   * `consumesBudget: false`, so the caller cannot tell them apart from what it is already given,
   * and a `takeTurn` that re-tested `replays` and the clock to label the event would be the second
   * copy of the budget rule this interface exists to prevent.
   *
   * It is not the same fact as `consumesBudget`, even though `budget` is exactly the branch that
   * writes today: one is a control-flow decision the caller must obey, the other is an
   * observability label whose value set grows every time a new rule is added here — as
   * `client_id` just did.
   */
  readonly absorbedAs: "client_id" | "budget" | "storm" | "stale";
}

/**
 * The cached response, rebuilt as a turn result.
 *
 * EXTRACTED SO THE TWO RETURN SITES CANNOT DRIFT (#931). The id branch and the clock branch below
 * must serve the BYTE-IDENTICAL previous response — that is the whole promise of this cache — and
 * two hand-written copies of a fourteen-field literal is how one of them quietly stops carrying
 * the chips, the lookahead or the input mode that a worker on a flaky link needs most.
 */
function replayResultOf(last: LastTurn): TurnResult {
  return {
    reply: last.reply,
    // FROM THE CACHE FOR THE SAME REASON THE OPTIONS ARE (#695). A retried submit over a flaky
    // link is an ordinary event, and re-deriving `ask` here would turn the second delivery of a
    // disambiguation offer into an ordinary question with a chip scroller — the byte-identical
    // replay this cache promises, silently downgraded on exactly the connections that need it.
    kind: last.kind,
    questionKey: last.questionKey,
    // FROM THE CACHE, not empty. These four used to be dropped on the floor here, which made a
    // replay a strictly WORSE response than the one it claims to repeat: same words, no chips,
    // no progress. On chat that costs a scroller and a progress bar; on the voice form it
    // strands a worker who cannot type in front of a question only answerable by tapping.
    options: last.options,
    progress: last.progress,
    whyText: last.whyText,
    answerType: last.answerType,
    inputMode: last.inputMode,
    // FROM THE CACHE, like the four above. A handover replayed without its button is a dead end.
    formOffer: last.formOffer,
    unansweredEssentials: [],
    complete: false,
    completionReason: null,
    replayed: true,
    excludeFromParse: false,
    unavailable: false,
    // FROM THE CACHE, like the four above and for the identical reason (#766 item 2). The
    // lookahead is part of what the client draws — it renders the next question from it on the
    // tap — so replaying the words without it is the same silent downgrade `options` and
    // `progress` used to suffer here. `null` on a record written before the field existed,
    // which is simply the round trip the client already falls back to.
    lookahead: last.lookahead,
    // A replay changed NOTHING, so there is nothing new to checkpoint. Firing here would let a
    // client retrying on a flaky connection drive one Postgres UPDATE per retry.
    checkpointDue: false,
  };
}

/**
 * The closed shape a pack question key has, re-checked before one crosses into an event.
 *
 * THE SHAPE IS THE PRIVACY GUARANTEE, which is why it is enforced here and not assumed. A key that
 * matches `^[a-z_]+$` and is at most 40 characters cannot carry a worker's words; "pack keys are
 * slugs by construction" is a property of today's corpus and of a validator that runs somewhere
 * else, not of this call site. Anything else reports as `null` — one lost observability field
 * rather than a rejected payload, on a path whose only job is to make something visible.
 */
const EVENT_QUESTION_KEY = /^[a-z_]{1,40}$/;

function eventQuestionKey(value: string | null): string | null {
  return value !== null && EVENT_QUESTION_KEY.test(value) ? value : null;
}

/** Layer A: the same message, at the same rev, inside the window. */
function replayOf(envelope: ProfilingEnvelope, input: TurnInput): Replay | null {
  const last = envelope.lastTurn;
  if (!last) return null;
  if (last.inboundHash !== inboundHash(input.sessionId, envelope.rev, input.text)) return null;

  // ─── THE CLIENT'S OWN VERDICT, WHEN BOTH SIDES HAVE ONE (#931) ────────────────────────────
  //
  // THE DEFECT. Everything below this block decides "retry or next answer?" from elapsed time,
  // because the hash — `(sessionId, rev, text)`, stamped against `rev + 1` — cannot tell them
  // apart: a worker who answers the FOLLOWING question with the SAME word produces a byte-
  // identical key and has their answer discarded and the question re-served. Measured on device
  // on qp_machining: "Kya aap programme feed kar lete hain?" → "haan" captured and the engine
  // advances, then "Kya aap drawing padh lete hain?" → "haan" DISCARDED. 236 of 466 authored pack
  // items are `boolean` with zero options and the packs place them back to back, so this is the
  // normal case for a voice-first UI, not an edge one.
  //
  // WHY THE ID BEATS THE CLOCK. A clock is a guess about intent — a fast worker and a slow retry
  // produce the same number, which is why four constants and three defects (#857, #858, #869)
  // have not resolved the ambiguity and cannot. The client is not guessing: it mints one id per
  // PHYSICAL send and re-sends that same id verbatim on a transport retry, so id equality is a
  // FACT about which submission this is. Facts do not expire, which is why no window, budget or
  // floor is consulted on this path.
  //
  // AND THAT IS NOT AN UNBOUNDED REPLAY. The hash test one line above still stands in front of
  // this, so the branch is reachable only while (session, rev, text) are all unchanged — i.e.
  // only while NOTHING has happened since the reply was stamped. The worker's next answer carries
  // a different id (a real turn, immediately), and any turn at all moves `rev` and the hash misses.
  //
  // THE HASH TEST STAYS IN FRONT, DELIBERATELY. Tested id-first, a client bug that reused one id
  // across two DIFFERENT utterances would discard the second one — a brand-new way to lose a
  // worker's words, worse than the defect being fixed. Behind the hash, that case fails the text
  // comparison and falls through to a real turn, which captures what they said. No second rule.
  // AN OFFER THAT LOST ITS CHIPS IS NOT A REPLAY, IT IS A DEAD END — fail closed (§3).
  //
  // `narrowLastTurn` parses cached options all-or-nothing, so any chip the contract rejects
  // empties the list, while `kind` narrows independently and survives. Serving that pair tells
  // the client to draw a single-select with nothing in it: on chat a scroller with no chips, on
  // the voice form a question a worker who cannot type has no way at all to answer. Returning
  // null re-runs the turn, which costs one turn; serving it costs the session.
  //
  // IT SITS ABOVE EVERY BRANCH THAT CAN SERVE THIS STAMP, AND THAT POSITION IS THE POINT. Empty
  // chips are a property of the CACHED REPLY — they are empty however this call arrived — not of
  // the rule that matched it. Written below the id branch (#931) it silently stopped covering the
  // path that had just become the PRIMARY one: every shipped client sends an id, so an id-carrying
  // retry was handed the dead end this guard exists to refuse — and handed it on every retry,
  // because that branch consults no window and never ages out. Two independent reviewers
  // reproduced it from the existing `FAILS CLOSED when a cached offer comes back without its
  // chips` test by adding nothing but a submission id.
  if (last.kind === "disambiguate" && last.options.length === 0) return null;

  const incomingId = input.submissionId;
  const stampedId = last.submissionId;
  if (incomingId !== null && stampedId !== null) {
    // DIFFERENT ID ⇒ A REAL TURN, ALWAYS — even byte-identical text at the matching rev. This
    // single line is the fix.
    if (incomingId !== stampedId) return null;
    // SAME ID ⇒ the same physical submission arriving again. NOTHING IS WRITTEN: the budget
    // exists only because a stamp that never goes stale traps the worker's NEXT answer (#857),
    // and their next answer carries a different id and can never match this stamp, so there is
    // nothing left for a budget to protect. It also takes one CAS round trip off exactly the
    // flaky links that produce retries.
    // SAME ID, AND STILL BOUNDED BY THE OUTER WINDOW. This bound is not a hedge against the id;
    // it is the fail-closed reading of an id the server does not control (§3, client input is
    // untrusted). `Facts do not expire` holds for a CORRECT client. A client that reuses one id
    // across two physical sends is not misreporting a fact, it is broken — and unbounded, every
    // later send it makes matches this stamp and writes nothing, so `rev` never moves, the stamp
    // never ages, and the interview DEADLOCKS for the whole 24 h buffer TTL while the worker
    // answers a question that will not advance. The code this replaces self-cleared in ≤10 s.
    // Trading a bounded old failure for an unbounded new one is not a fix.
    //
    // THE BOUND IS `ID_REPLAY_MAX_AGE_MS`, NOT THE STALE WINDOW, and the difference matters.
    // `STALE_RESPONSE_WINDOW_MS` is 30 s, but `POST /profiling/answer` transcribes a spoken answer
    // in-request and the shipped client waits 150 s for it, so a GENUINE retry on that route lands
    // far outside 30 s. Bounding there would run the turn for real and capture a worker's spoken
    // answer against the question their first submission had already advanced past — #869's silent
    // corruption, reintroduced sideways. 180 s clears the longest deadline a shipped client has, so
    // every real retry replays and only a wedged one ages out. See the constant for the full case.
    //
    // THE DEFECT #931 FIXES IS UNTOUCHED BY THIS. The on-device bug is the DIFFERENT-id case one
    // line above, which returns null with no clock consulted at all and cannot be re-broken here.
    const idAge = input.now.getTime() - new Date(last.at).getTime();
    if (!Number.isFinite(idAge) || idAge < 0 || idAge > ID_REPLAY_MAX_AGE_MS) return null;
    return { consumesBudget: false, absorbedAs: "client_id", result: replayResultOf(last) };
  }
  // ASYMMETRIC AND ABSENT CASES BOTH FALL THROUGH TO THE CLOCK, and must. An id can only be
  // compared with an id: "inbound has one, the stamp does not" is the deploy straddle (an
  // envelope stamped by the previous build, alive in Redis behind a 24 h TTL) and the mixed-surface
  // case (there is no mode-lock — a worker may start in chat and continue in the voice form);
  // "the stamp has one, the inbound does not" is an old app build, or `openTurn`/finalize, which
  // have no client submission behind them at all. Neither is comparable, so both are judged by
  // exactly the rules below, which is what makes the rollout requirement mechanical rather than
  // promised. A straddling session self-heals on its next real turn, which stamps an id.
  //
  // ⚠ THE FOUR CLOCKS BELOW ARE DELIBERATELY LEFT IN PLACE (#931 step 4, NOT done here).
  // `REPLY_CACHE_WINDOW_MS`, `STALE_RESPONSE_WINDOW_MS`, `MAX_REPLAYS_PER_TURN` and
  // `RETRY_STORM_FLOOR_MS` are byte-identical to what they were, and they remain the WHOLE of the
  // behaviour for any inbound with no id on either side. Retiring them is gated on telemetry
  // proving the id is universally present in the field — `profile.submission_duplicated`'s
  // `absorbed_as` is that telemetry — because old app builds stay in the field for a long time and
  // shortening these now would regress #857/#858/#869 for every one of them (#930 rollout).
  const age = input.now.getTime() - new Date(last.at).getTime();
  // A NEGATIVE age is not a hit. Clock skew between instances would otherwise make a stale entry
  // look arbitrarily fresh, and replaying an old reply is worse than spending a turn.
  //
  // AND THIS TEST GUARDS THE STORM FLOOR BELOW TOO, which is why the floor is expressed here and
  // not in `takeTurn`: `age` is only a floor on human turnaround once it is known to be a real,
  // forward-running elapsed time. A skewed clock handing back −60 s satisfies "less than 1.5 s"
  // perfectly, and would turn clock skew into a free way to suppress turns indefinitely.
  if (!Number.isFinite(age) || age < 0 || age > STALE_RESPONSE_WINDOW_MS) return null;
  // PAST THE FRESH WINDOW BUT INSIDE THE STALE ONE (#869) — still served from the cache, but for a
  // different reason, so the budget below does not apply to it.
  //
  // Inside `REPLY_CACHE_WINDOW_MS` a match is confidently one physical submission arriving twice.
  // Out here it is genuinely ambiguous: either the shipped client's own 15 s timeout retry (whose
  // worker never saw the question this would otherwise answer), or the worker's next answer reusing
  // the same words. The server cannot tell — so it is decided by which mistake is recoverable.
  // Replaying at a worker who really did repeat themselves costs one visible round trip; running
  // the turn for a stale retry captures their words against a question they never saw and, on a
  // `max_asks: 1` item, settles it forever. See STALE_RESPONSE_WINDOW_MS for the full argument.
  const stale = age > REPLY_CACHE_WINDOW_MS;
  // THE REPLAY BUDGET (see `LastTurn.replays`). `rev` does not distinguish a network retry of
  // THIS reply from the worker's next, genuinely different turn happening to use the same words —
  // a replay writes nothing, so an unbudgeted stamp would match every further identical submission
  // for the whole of `REPLY_CACHE_WINDOW_MS`, however many real turns that is. Past the budget a
  // matching submission runs the turn for real instead of matching this stamp again.
  //
  // ...UNLESS IT LANDED TOO FAST TO BE A HUMAN (#858). Running the turn for real answers whatever
  // question is on screen NOW, and for the third copy of ONE physical submission that is the wrong
  // question — the FIRST duplicate's own success is what advanced it. The worker never gave those
  // words for it, and the engine cannot tell, so the words are captured against it anyway: B's ask
  // budget spent, or B settled outright, on content meant for A. Inside `RETRY_STORM_FLOOR_MS` the
  // worker cannot have seen B at all, so the submission is still the same physical one and is
  // still answered from the cache. Past the floor the two cases are genuinely indistinguishable
  // and the budget decides, exactly as it did before.
  const spent = last.replays >= MAX_REPLAYS_PER_TURN;
  // `&& !stale` IS THE FIX (#869), and it is why the budget is scoped rather than removed. The
  // budget exists to stop ONE stamp trapping an interview while it is being replayed cheaply
  // inside the fresh window. Out in the stale window there is nothing to trap: a stale replay
  // consumes no budget, writes nothing, and never refreshes `last.at`, so the window shuts by the
  // clock on its own. Letting the budget fall through to here would re-open exactly this defect —
  // the spent stamp would run the turn for real and capture the stale retry against the question
  // it was never meant for, which is the whole bug.
  if (spent && age >= RETRY_STORM_FLOOR_MS && !stale) return null;
  return {
    // A STORM REPLAY WRITES NOTHING, and it is the clock that makes that safe. `last.at` is the
    // ORIGINAL real turn and no replay ever refreshes it, so `age` only grows: the floor above
    // expires on its own, whether or not this path ever touches Redis. Consuming budget here
    // instead would buy nothing — the budget is already spent — while putting one CAS write per
    // duplicate on exactly the path a storm hammers.
    // `&& !stale`: a stale replay costs no budget. Consuming it would put one CAS write on every
    // duplicate of a retry storm — the same reason a spent storm replay writes nothing — and would
    // buy nothing, since out there the budget no longer gates anything (see the check above).
    consumesBudget: !spent && !stale,
    // NAMED WHERE `spent` AND `stale` LIVE, because this is the only place both are in scope —
    // see `Replay.absorbedAs`. `stale` wins the label over `storm`: out past the fresh window the
    // budget is not what served it (#869), whatever `replays` happens to say.
    absorbedAs: stale ? "stale" : spent ? "storm" : "budget",
    result: replayResultOf(last),
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
function outstandingLlmAsk(
  envelope: ProfilingEnvelope,
  leads: boolean,
): {
  prompt: string;
  options: readonly QuestionPackOption[];
  answerType: AnswerType | null;
} | null {
  if (!leads) return null;
  if (envelope.llmAsks === 0 && !envelope.llmGateOpen) return null;
  const last = envelope.lastTurn;
  if (!last || last.reply.trim().length === 0) return null;
  return { prompt: last.reply, options: last.options, answerType: last.answerType };
}

/**
 * The packs the engine may still SELECT a question from, once Phase A has had its turn.
 *
 * THE SYMPTOM THIS EXISTS TO REMOVE. A worker finished the LLM-led interview — the model asked
 * about their trade, their jobs and their skills, the experience gate opened, they answered
 * "Nahi" — and the very next thing on screen was `machine_type`, then `programming`, then
 * `drawing_reading`, then `measuring_tools`: the whole of `qp_machining`, asked one authored row
 * at a time about a conversation that had just covered it. That is not a bug in either engine.
 * Phase A closing FALLS THROUGH to `nextQuestion` on the same turn, and `nextQuestion` serves the
 * occupation pack strictly before the universal tail — so "the model led this interview" and "the
 * worker is re-interrogated by their trade pack" were, by construction, the same turn. The ruling
 * is that an LLM-led interview goes from the model's close straight to the universal tail and then
 * closes: keep the LLM interview only, for now.
 *
 * THIS FUNCTION IS THE WHOLE SEAM, deliberately — "for now" ends with a revert of it and its call
 * sites, not with an archaeology of scattered conditions. It suppresses SELECTION and nothing
 * else, and each of the three things it leaves alone is load-bearing:
 *
 *  - THE PIN. `resolvePacks` derives `packId`/`packVersion` from the occupation pack it resolved,
 *    and the obvious place to null the pack — next to the "universal pack resolved as the
 *    occupation pack" line inside it — is two lines above that derivation. A session with no pin
 *    writes ZERO `worker_pack_answer` rows (`toPackAnswerRows` returns early without one), the
 *    universal tail's included, never emits `profile.pack_pinned`, and gives `viewSettled` nothing
 *    to correct against. The pack stays pinned; only the questions stop being asked.
 *  - `items`, the flat union both `decide` and `openTurn` build. It is what `settleFromLlmDraft`
 *    writes the model's skills onto — every `skills` item in the shipped corpus lives in an
 *    occupation pack, so narrowing it would silently drop Phase A's skills out of `answer_map`
 *    and out of the matching inputs behind it. It is also what `shapeOf` resolves an in-flight
 *    question against and what the review screen names its stored answers from.
 *  - The CAPTURE half of a stale `servedQuestionKey`. A worker looking at a trade question this
 *    build will never serve again — the state a session written by the PREVIOUS build resumes in
 *    — still has their answer recorded, because `askedItem` is resolved from the full union. It
 *    is the RE-SERVE that is narrowed, not the capture: losing a question is recoverable, losing
 *    the answer a worker already typed is not.
 *
 * ─── THE RULE ───────────────────────────────────────────────────────────────────────────────
 *
 * TWO DETERMINISTIC FACTS, BOTH OWNED BY THIS SERVICE. The occupation pack is off the table when
 * both hold:
 *
 *   1. PHASE A ACTUALLY RAN — `llmLedTurns > 0`, a counter `LlmTurnService` increments once per
 *      turn it put in front of the worker.
 *   2. PHASE A IS OVER — `llmStage === "done"` (the answered gate, the caps, or `phase_a_done`
 *      under those caps) or `llmFallback` (the model stopped answering; sticky by design).
 *
 * Phase A ran and is finished ⟹ nothing from the worker's trade pack is served, re-served,
 * predicted or spoken for the rest of the interview. Phase A never ran ⟹ this returns the very
 * object it was handed, and every deterministic interview behaves exactly as it did before this
 * function existed. That second branch is the majority path and it is an identity return.
 *
 * ─── §3: WHY THE MODEL IS NOT WHAT DECIDES THIS ─────────────────────────────────────────────
 *
 * WHAT THE PREVIOUS FLOOR GOT WRONG, stated plainly because it shipped and it broke a real
 * worker. The first version of this function required `llmDraft.experiences.length > 0`, added in
 * review as a §3 guard against the model's `phase_a_done` deleting a worker's authored questions.
 * The intent was right and the field was the wrong one: `experiences` is populated from
 * `out.experience_entry`, WHICH IS THE MODEL'S OWN OUTPUT, filled or left null at the model's
 * discretion on any turn. So that floor did not take the decision away from the model. It handed
 * the model a second lever with the polarity reversed — a model that simply never emits an
 * `experience_entry` re-arms the entire trade pack — and that is what the reported welder session
 * looked like: a conversational experience stretch, a gate-shaped question the model wrote itself
 * ("aur koi kaam jode?" — not `EXPERIENCE_GATE_PROMPT`, which says "experience"), "Nahi", and then
 * `qp_welding` from the top. A floor the model can walk under by omission is not a floor.
 *
 * WHY `llmLedTurns` IS ONE. It is written by `LlmTurnService` and by nothing else, one increment
 * per turn it served. No field on the wire moves it; the model cannot inflate it and cannot zero
 * it. What it records is not an opinion about the interview's quality — it is the fact that the
 * platform put N conversational questions to this worker and read N answers back. That is the
 * business fact the rule needs, and deterministic code is what establishes it.
 *
 * WHAT THE MODEL STILL INFLUENCES, AND WHY THAT IS INSIDE §3. `phase_a_done` can still END Phase
 * A early. That is advice about the model's own turn-taking, and acting on it is this service's
 * decision to stop spending money on an interview the model says it has finished — the same class
 * of decision as the caps. It can only SHORTEN Phase A. It cannot conjure the `llmLedTurns`
 * evidence, and it cannot bring the pack back. Combined with #949's clamp on `out.stage` (which
 * stopped the model writing `"done"` on an ask turn), every path from the model's output to
 * "which authored questions this worker is asked" now runs through a counter the model cannot
 * touch.
 *
 * WHY NOT `llmAsks > 0`, THE OBVIOUS EXISTING COUNTER. It is API-owned, so §3 is satisfied — but
 * it is the runaway BUDGET's counter and is deliberately not incremented by the turn that opens
 * the experience gate, because the model's reply is discarded there in favour of the gate. The
 * shortest real interview — the composite opener answered with a whole job, the gate, "Nahi" —
 * therefore ends Phase A with `llmAsks === 0`. Keying on it would serve the full trade pack to a
 * worker who had just described their job in their own words: the reported bug, reintroduced from
 * the other side. See the field's own note in `conversation-state.ts`.
 *
 * ─── WHY A FALLEN-BACK INTERVIEW IS COVERED TOO ─────────────────────────────────────────────
 *
 * The first version excluded it, and said so: `settleFromLlmDraft` ran only on the `done` branch,
 * so a fallen-back interview's trade, experience and skills existed nowhere but the transcript,
 * and suppressing its pack would have left the worker with neither the model's answers nor the
 * pack's questions. That reasoning was sound and its premise has been removed — `decide` now
 * settles the draft on the fallback branch as well, under the same `llmLedTurns > 0` test used
 * here, so the two move together by construction. What is left is a worker who spent five turns
 * describing their welding to a model that then timed out, and the honest answer for them is the
 * universal tail, not `welding_process` asked from the top as though the conversation had not
 * happened. A fallback on the FIRST turn is untouched: nothing was led, `llmLedTurns` is 0, and
 * the pack is served exactly as it is today.
 *
 * ─── WHAT IT COSTS, AND WHAT IT STILL DOES NOT COVER ────────────────────────────────────────
 *
 * THE DENOMINATOR SPLIT. For an LLM-led session the engine's `progress` counts the universal tail
 * alone, while `progressOf(items, …)` on the non-advancing branches would count the pinned pack's
 * rows — so the two would disagree by exactly the questions no longer asked. Every reader that
 * reports progress is therefore handed the NARROWED list; `items` stays whole for settlement and
 * shape. A mandatory occupation question (only `qp_welding/welding_process` in the corpus) still
 * shows up in `unansweredEssentials`, which is wire-only and gates nothing.
 *
 * A LOST REDIS BUFFER IS NOT COVERED, and cannot be closed here. `restorePin` rebuilds an empty
 * envelope carrying only `packId`/`packVersion`, so `llmLedTurns` comes back 0 — but so do
 * `answerMap` and `llmDraft` and the whole interview, and Phase A simply starts again from the top
 * and suppresses again at ITS close. The residue is a session that loses its buffer while
 * `CHAT_LLM_INTERVIEW_ENABLED` reads off, which then gets the deterministic interview it would
 * have had all along. Making the fact durable means a new member on `ConversationState` — the
 * FROZEN cross-language contract mirrored in `apps/ai-service/app/contracts.py` — or a new column
 * under the held CD-2 migration gate. Both are joint changes with another owner (§16), so this is
 * recorded rather than smuggled in.
 */
function selectableEnginePacks(envelope: ProfilingEnvelope, resolved: EnginePacks): EnginePacks {
  // THE BRANCH THAT PRESERVES EVERY DETERMINISTIC INTERVIEW — an identity return, so the engine is
  // handed the very object it is handed today. `emptyProfilingEnvelope` seeds `llmLedTurns: 0`,
  // `narrowProfilingEnvelope` reads an absent field as 0, and `LlmTurnService` is the only writer
  // that ever moves it — so with `CHAT_LLM_INTERVIEW_ENABLED` at its default OFF, `leads()` is
  // false for every session, `take()` is never called, and nothing on the majority path can get
  // past this line. FIRST because it is the majority path, and because it is the one branch whose
  // correctness has to be obvious at a glance.
  if (envelope.llmLedTurns === 0) return resolved;

  // STILL RUNNING. Phase A is mid-interview, so the engine is not selecting anything this turn
  // anyway — but `openTurn` and `viewSession` read this too, and a worker who reopens the app
  // mid-Phase-A must be shown the same denominator the turn loop is about to use. `llmStage` is
  // written only by `LlmTurnService` and `llmFallback` only by `decide`; neither is reachable
  // from the wire.
  if (envelope.llmStage !== "done" && !envelope.llmFallback) return resolved;

  return { occupation: null, universal: resolved.universal };
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
 * What Phase A learned, written into the deterministic answer map.
 *
 * WHY THIS IS NOT OPTIONAL. Phase A spends most of an interview on the worker's trade and their
 * jobs, and the template tail opens with `primary_trade` — so without this the first thing a
 * worker hears after the conversation ends is a question the conversation already answered. It
 * is also what keeps `progress` and `unansweredEssentials` honest: both are computed from settled
 * pack questions, and a Phase A that filled neither reports a worker who has answered nothing.
 *
 * KEYED ON `target_field`, NEVER ON A QUESTION KEY. The trade question is `primary_trade` in the
 * universal pack and something else in an occupation pack, and hardcoding either would silently
 * settle nothing for the other. The RFS field is the fact the packs agree on.
 *
 * FIRST-WRITE-WINS, the same rule the cross-question path follows: a value the worker established
 * against a real question is theirs, and a draft assembled by a model must never overwrite it.
 *
 * `experience_years` IS ONLY SETTLED WHEN EVERY ENTRY CARRIES A DURATION. A sum over entries the
 * model could not put a number on understates a worker's experience, and understating it is the
 * one direction that costs them jobs — so a partial answer is left for the pack question to ask
 * properly rather than filled in with a number nobody can defend.
 *
 * THE PINNED OCCUPATION IS THE LAST TRADE FALLBACK, and it is what closes the bug this function
 * was already written to prevent. Both draft labels default to `null`, and an `experience_entry`
 * may arrive on ANY turn — including the first, which the composite opener actively invites
 * ("aap kaun sa kaam karte hain, kahan rehte hain, aur kitna tajurba hai?"). An entry opens the
 * Yes/No gate immediately, so a worker can reach "Aur koi experience jodna hai?" with both labels
 * still null, answer "nahi", and be asked "Aap kaunsa kaam karte hain?" as the very next line —
 * after a conversation that was entirely about their trade.
 *
 * `occupation.label` is safe to spend here in a way a model's free text would not be: it is
 * RETRIEVAL's pin, the same deterministic decision that chose the pack whose questions are about
 * to be served. Last in precedence, because the model's own labels are more specific when present.
 *
 * SKILLS ARE MATCHED AGAINST THE PACK'S OWN VOCABULARY, never written through verbatim. The draft
 * carries free text ("MIG welding") and the skills items are `multi_select` over a closed option
 * list, so the model's words are run through {@link matchOptions} — the SAME matcher a typed
 * answer goes through — and only the options that actually land are settled. A skill that matches
 * nothing settles nothing and the question is still asked, which is the correct outcome: §11 says
 * validate AI output before business logic consumes it, and `answer_option_keys` is read by the
 * matcher as pack vocabulary. Writing "MIG welding" into it would be a value no option means.
 */
function settleFromLlmDraft(
  answers: AnswerMap,
  draft: ProfilingEnvelope["llmDraft"],
  occupationLabel: string | null,
  items: readonly QuestionPackItem[],
  turn: number,
): AnswerMap {
  const trade = (draft.role_label ?? draft.domain_label ?? occupationLabel ?? "").trim();
  const months = draft.experiences.map((entry) => entry.duration_months);
  const years =
    months.length > 0 && months.every((m): m is number => typeof m === "number")
      ? Math.round(months.reduce((sum, m) => sum + m, 0) / 12)
      : null;

  let next = answers;
  const settle = (field: string, raw: string, normalized: unknown): void => {
    const item = items.find((candidate) => candidate.target_field === field);
    if (!item || isSettled(next, item.question_key)) return;
    next = recordAnswer(
      next,
      {
        questionKey: item.question_key,
        targetField: field,
        valueRaw: raw,
        valueNormalized: normalized,
        // NO EVIDENCE SPAN. These come from the model's structured draft rather than from a
        // quoted stretch of transcript, and inventing an index the provenance gate would then
        // verify against is worse than admitting there is nothing to cite.
        evidence: null,
      },
      turn,
    );
  };

  if (trade) settle("trade", trade, trade);
  if (years !== null) settle("experience_years", `${years}`, years);

  // EVERY skills item, not the first one `settle` would have found: a pack may carry more than one
  // (`welding_process` and a materials question both target `skills`), and they ask about different
  // things. One joined string is scanned for each, because `matchOptions` masks negation and
  // consumes matched characters per item — running it per skill would let a two-word option lose to
  // a one-word fragment scanned in a different call.
  const skillsText = draft.skills.join(", ").trim();
  if (skillsText) {
    for (const item of items) {
      if (item.target_field !== "skills" || isSettled(next, item.question_key)) continue;
      const matched = matchOptions(item, skillsText);
      // MIRRORS THE CAPTURE RULES EXACTLY (`normalizeFor`): a multi_select holds the list, a
      // single_select holds exactly one — two option labels in one draft is not an answer to a
      // single-choice question, and picking the first would be picking at random. Anything else
      // (a free-text skills item) is left for the question to ask properly.
      const value =
        item.answer_type === "multi_select" && matched.length > 0
          ? matched
          : item.answer_type === "single_select" && matched.length === 1
            ? matched[0]
            : undefined;
      if (value === undefined) continue;
      next = recordAnswer(
        next,
        {
          questionKey: item.question_key,
          targetField: "skills",
          valueRaw: skillsText,
          valueNormalized: value,
          evidence: null,
        },
        turn,
      );
    }
  }
  return next;
}

/**
 * The buffered conversation, as the contract's transcript lines.
 *
 * INDEXED BY POSITION IN THE BUFFER, matching what `/profile/parse` sends — `i` is what an
 * evidence span cites, so the two callers must number the same conversation the same way or a
 * quote verified against line 4 in one call points at line 5 in the other.
 */
function transcriptOf(buffer: TranscriptBuffer): TranscriptLine[] {
  return buffer.messages.map((message, i) => ({ i, role: message.role, text: message.text }));
}

/**
 * A model-authored chip, in the shape the client already renders.
 *
 * THE KEY IS SYNTHESISED AND NEVER READ BACK, exactly as a disambiguation chip's is: these come
 * from a model rather than from an authored pack row, so there is no `option_key` to carry. It
 * goes through {@link slugIndexKey} rather than an index because `QuestionPackOptionSchema`'s
 * `slugKey` forbids digits, and `narrowLastTurn` parses the cached option list all-or-nothing —
 * one `llm_0` would empty the whole chip list on a replay and leave a worker who cannot type
 * looking at a question with nothing to tap.
 *
 * THE LABEL IS THE VALUE, which is the same contract every chip has: what the worker taps is
 * what they said. Nothing here is a business decision — the chips are an affordance for typing,
 * and the answer of record is the label either way.
 */
function toLlmOption(label: string, index: number): QuestionPackOption {
  return {
    option_key: slugIndexKey("llm", index),
    label_text: label,
    value: label,
    implies_skill_id: null,
    is_none_of_above: false,
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
