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
import type { QuestionPack, QuestionPackItem, QuestionPackOption } from "@badabhai/ai-contracts";

import {
  ChatTranscriptBuffer,
  type TranscriptBuffer,
} from "../chat/chat-transcript.buffer";
import { CHAT_UNAVAILABLE_REPLY } from "../chat/chat.service";
import type { RequestContext } from "../common/request-context";
import { IdentifyService } from "./identify.service";
import { captureAnswer, hasFieldNormalizer, mayCommit } from "./answer-capture";
import {
  isSettled,
  recordAnswer,
  recordDeclined,
  recordUnanswered,
  type AnswerMap,
} from "./answer-map";
import {
  answersOf,
  emptyProfilingEnvelope,
  inboundHash,
  recordTurnLatency,
  REPLY_CACHE_WINDOW_MS,
  toEngineState,
  withAnswers,
  type ProfilingEnvelope,
} from "./conversation-state";
import {
  askCeiling,
  askCount,
  clarify,
  nextQuestion,
  servedText,
  MAX_ABUSIVE_TURNS,
  MAX_CONSECUTIVE_HARDSHIP,
  MAX_ENGINE_TURNS,
  MAX_SILENT_TURNS,
  type CompletionReason,
  type Decision,
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
export const DE_ESCALATION_REPLY = "Aap se vinamra rehne ki request hai. Kaam ki baat karte hain.";

/**
 * The closed appreciation set for a hardship turn.
 *
 * A CLOSED SET, and chosen by turn index rather than at random: the engine has no randomness by
 * construction, so the same conversation always produces the same words. Acknowledging without
 * pushing a question is the whole point — a worker describing a hard month is not refusing to
 * answer, and pressing them is the fastest way to lose the interview.
 */
export const HARDSHIP_REPLIES = [
  "Samajh sakta hoon. Aapki baat sahi hai.",
  "Aapki mehnat samajh aati hai. Thoda aur batayiye.",
  "Theek hai. Aaram se batayiye, koi jaldi nahi.",
] as const;

/** Served when the interview ends normally. */
export const CLOSING_REPLY = "Aapki baat poori ho chuki hai. Profile taiyaar ho rahi hai.";

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
export interface TurnResult {
  readonly reply: string;
  readonly questionKey: string | null;
  readonly options: readonly QuestionPackOption[];
  readonly progress: { readonly answered: number; readonly total: number };
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

@Injectable()
export class ProfilingOrchestrator {
  private readonly logger = new Logger(ProfilingOrchestrator.name);

  constructor(
    private readonly buffer: ChatTranscriptBuffer,
    private readonly packs: PackRegistryService,
    private readonly identify: IdentifyService,
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
      const envelope = buffer.profiling ?? emptyProfilingEnvelope();

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
      if (won) return decided.result;

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
    const items = [...(packs.engine.occupation?.items ?? []), ...packs.engine.universal.items];
    const askedItem = items.find((item) => item.question_key === envelope.servedQuestionKey) ?? null;

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
          questionKey: envelope.servedQuestionKey,
          options: askedItem?.options ?? [],
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
          questionKey: envelope.servedQuestionKey,
          options: askedItem?.options ?? [],
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
          questionKey: envelope.servedQuestionKey,
          options: askedItem?.options ?? [],
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
          reply: joinClarify(clarified, askedItem),
          questionKey: clarified.questionKey,
          options: clarified.options,
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
    answers = this.fillCrossQuestion(items, input.text, envelope, answers, capture.correcting, turn);

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
        // NO QUESTION KEY. This question belongs to no pack, and claiming a pack's key for it
        // would make the next turn's `askedItem` lookup capture a chip tap as that question's
        // answer.
        questionKey: null,
        options: identified.offer.options,
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
      questionKey: decision.questionKey,
      options: decision.options,
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
      const capture = captureAnswer(text, item);
      for (const value of capture.values) {
        filled = recordAnswer(filled, value, turn);
      }
    }
    return filled;
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
        questionKey: result.questionKey,
        at: input.now.toISOString(),
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
  return {
    reply: last.reply,
    questionKey: last.questionKey,
    options: [],
    progress: { answered: 0, total: 0 },
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

function unavailable(): TurnResult {
  return {
    reply: UNAVAILABLE_REPLY,
    questionKey: null,
    options: [],
    progress: { answered: 0, total: 0 },
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

/** `why_text`, then the question again — one message, because the client renders one bubble. */
function joinClarify(decision: Decision, askedItem: QuestionPackItem | null): string {
  const why = decision.promptText;
  const question = askedItem?.prompt_text ?? "";
  if (!question || why === question) return why;
  return `${why} ${question}`;
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
