import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from "@nestjs/common";
import type { AnswerRecord, QuestionPackOption } from "@badabhai/ai-contracts";

import { ChatRepository } from "../chat/chat.repository";
import { ChatService, type ChatTurnOutcome } from "../chat/chat.service";
import type { RequestContext } from "../common/request-context";
import {
  ProfilingOrchestrator,
  type ServedQuestion,
  type TurnResult,
} from "./orchestrator.service";
import { clipId } from "./reply-closure";
import type {
  FinalizeProfilingResponse,
  ProfilingAnswerDto,
  ProfilingReviewResponse,
  ProfilingSessionResponse,
  ProfilingStep,
  ProfilingStepResponse,
} from "./profiling.dto";

/**
 * The voice form's half of the interview — and ONLY its half.
 *
 * WHAT THIS CLASS IS NOT. It is not a second interview engine. Every turn it takes goes through
 * `ChatService.runTurn`, which is the same method `POST /chat/message` calls and which owns the
 * ownership check, the completed-but-unflushed re-drive, the CAS-loss branch, the replay
 * short-circuit, the flush and the mid-interview checkpoint. That is the owner's one-pipeline
 * ruling made mechanical rather than promised: there is no code path here that could decide the
 * interview is over, and no second `.insert(workerProfiles)`.
 *
 * WHAT IT DOES OWN is the two things a voice surface needs that a chat surface does not:
 *
 *  1. **Opening the screen.** A form that reads questions aloud has to speak first, so `start`
 *     calls `openTurn` rather than sending an empty message through the turn machinery.
 *  2. **Turning a tap into an answer.** The client sends `option_key`s; the LABEL is resolved
 *     here, against the options the engine actually served. This is the rule the plan states and
 *     it is a correctness rule, not a style one — a chip's `label_text` becomes the worker's
 *     answer of record verbatim, so a client that sent labels would be choosing what got stored.
 *
 * THERE IS NO MODE-LOCK, and that is now a measured decision rather than an omission. The lock
 * the plan called for existed to close a lost-update hazard between a blind `save()` and
 * `saveWithCas()`. The Phase 8 cutover deleted the blind save: both surfaces reach the same
 * envelope through the same compare-and-swap, so a worker who starts in chat and continues in the
 * voice form (which the entry chooser's own copy — "Baad mein badal sakte hain" — invites) simply
 * continues the same interview. Locking them apart would break that promise to fix nothing.
 */
@Injectable()
export class ProfilingSessionService {
  private readonly logger = new Logger(ProfilingSessionService.name);

  constructor(
    private readonly chat: ChatRepository,
    // forwardRef: ChatModule imports ProfilingModule for the orchestrator, and this needs
    // ChatService back. The cycle is real — one interview, two entry points.
    @Inject(forwardRef(() => ChatService)) private readonly chatService: ChatService,
    private readonly orchestrator: ProfilingOrchestrator,
  ) {}

  /**
   * Open the voice form: reattach to the worker's live interview, or start one.
   *
   * REATTACH RATHER THAN ALWAYS CREATE. `start()` is called on every cold app start and every
   * resume-after-kill, and minting a session each time would leave a trail of one-question
   * interviews and — worse — ask a worker who answered nine questions yesterday to begin again.
   * The session row is the durable anchor; `openTurn` is idempotent on top of it.
   */
  async start(workerId: string, ctx: RequestContext): Promise<ProfilingSessionResponse> {
    const existing = await this.chat.findLatestSessionByWorker(workerId);
    const sessionId =
      existing && existing.status === "active"
        ? existing.id
        : ((await this.chatService.startSession(workerId, ctx)) as { session_id: string })
            .session_id;

    const turn = await this.orchestrator.openTurn({
      sessionId,
      workerId,
      now: new Date(),
      ctx,
    });
    return { session_id: sessionId, step: this.stepOf(turn) };
  }

  /**
   * One answer, blocking until the engine has chosen the next question.
   *
   * BLOCKING IS NOT A LIMITATION TO BE ENGINEERED AWAY. `captureAnswer` needs answer n's text to
   * decide question n+1, and `isSettled` is the first servability test — so an engine asked for
   * the next question before the current one is answered re-serves the current one. Any optimistic
   * advance would show the worker a question the server is about to contradict.
   */
  async answer(
    workerId: string,
    dto: ProfilingAnswerDto,
    ctx: RequestContext,
  ): Promise<ProfilingStepResponse> {
    const session = await this.chat.findSession(dto.session_id);
    // 404 rather than 403, exactly as chat does: a session id must never be an existence oracle
    // for another worker's session.
    if (!session || session.workerId !== workerId) {
      throw new NotFoundException(`Session ${dto.session_id} not found`);
    }

    const view = await this.orchestrator.viewSession(dto.session_id, new Date());
    const served = view?.served ?? null;

    // THE STALE-ANSWER GUARD. A worker whose submit timed out retries after the first attempt
    // landed; without this the engine captures the retry as the answer to the question it has
    // already moved on to. 409 rather than 400 — nothing about the request is malformed, the
    // world simply moved — and the client's correct response is to redraw from `GET /session`.
    if ((served?.questionKey ?? null) !== dto.question_key) {
      throw new ConflictException(
        `Question ${dto.question_key ?? "(none)"} is no longer on screen for session ` +
          `${dto.session_id}; re-read the session before answering`,
      );
    }

    const text = this.textFor(dto, served);
    const outcome = await this.chatService.runTurn(workerId, dto.session_id, text, ctx);
    return { step: this.stepOfOutcome(outcome) };
  }

  /**
   * The worker's own answers, read back for the review screen.
   *
   * PII: these values ARE the worker's data, returned to the worker themselves over their own
   * authenticated session. Response-only — never logged, never evented, never sent anywhere else.
   * `display_value` is the NORMALIZED value rather than the raw utterance on purpose: the review
   * exists to show what was UNDERSTOOD, because that is what reaches the profile. Echoing the raw
   * words would confirm the recording worked while hiding a mis-capture.
   */
  async review(workerId: string, sessionId: string): Promise<ProfilingReviewResponse> {
    const session = await this.chat.findSession(sessionId);
    if (!session || session.workerId !== workerId) {
      throw new NotFoundException(`Session ${sessionId} not found`);
    }

    const view = await this.orchestrator.viewSession(sessionId, new Date());
    if (!view) {
      // No buffer: either the interview never started or its TTL lapsed. Both are "there is
      // nothing to review", which is a truthful empty answer rather than an error.
      return { session_id: sessionId, complete: session.status !== "active", rows: [] };
    }

    const prompts = new Map(view.items.map((item) => [item.question_key, item.prompt_text]));
    // `envelope.answerMap` rather than `answersOf`, because the review is a LIST and the array is
    // the contract's stable order. Keying it first would hand the screen whatever order the object
    // happened to hold, which for a worker reading their answers back is not the same screen twice.
    const rows = view.envelope.answerMap
      .filter((record) => record.status !== "superseded")
      .map((record) => ({
        question_key: record.question_key,
        prompt_text: prompts.get(record.question_key) ?? record.question_key,
        status: record.status as "answered" | "declined" | "unanswered",
        display_value: this.displayValue(record),
      }));

    return {
      session_id: sessionId,
      complete: view.buffer.completedAt !== undefined || session.status !== "active",
      rows,
    };
  }

  /**
   * Commit the reviewed session.
   *
   * COMPLETION STAYS ENGINE-AUTHORITATIVE. This does not decide the interview is over — it 409s
   * if the engine has not closed it — so the plan's "no client-callable finalize" rule holds. What
   * it does is guarantee the close is DURABLE, by re-driving the same completed-but-unflushed path
   * `POST /chat/message` already runs. A flush transaction that rolled back leaves a session that
   * looks finished to the worker and has no profile behind it, and on this surface there is no
   * next message to notice it.
   *
   * IDEMPOTENT: a session already finalized reports committed rather than throwing. A retried
   * finalize over a bad connection must not read as a failure for something that succeeded.
   */
  async finalize(
    workerId: string,
    sessionId: string,
    ctx: RequestContext,
  ): Promise<FinalizeProfilingResponse> {
    const session = await this.chat.findSession(sessionId);
    if (!session || session.workerId !== workerId) {
      throw new NotFoundException(`Session ${sessionId} not found`);
    }
    if (session.status !== "active") return { session_id: sessionId, committed: true };

    const view = await this.orchestrator.viewSession(sessionId, new Date());
    if (!view?.buffer.completedAt) {
      throw new ConflictException(
        `Session ${sessionId} is not finished; the engine decides when an interview closes`,
      );
    }

    // The re-drive. `runTurn` sees `completedAt` on the buffer and re-runs the flush — the same
    // branch, the same transaction, the same events. The text is never captured: that branch
    // returns before the engine is consulted.
    const outcome = await this.chatService.runTurn(workerId, sessionId, FINALIZE_MARKER, ctx);
    const committed =
      outcome.kind === "reflushed" ? outcome.flushed : outcome.kind === "session_over";
    if (!committed) {
      this.logger.error(
        `finalize did not commit session=${sessionId} outcome=${outcome.kind}; the buffer ` +
          `survives and the worker may submit again`,
      );
    }
    return { session_id: sessionId, committed };
  }

  // -------------------------------------------------------------------------

  /**
   * What the worker's action MEANS, as the text the engine captures.
   *
   * EVERY BRANCH RESOLVES SERVER-SIDE. The client never sends a label, never sends "haan", and
   * never decides that a tap means `true` — it sends what was tapped, and the meaning is looked
   * up against the options the engine actually served.
   */
  private textFor(dto: ProfilingAnswerDto, served: ServedQuestion | null): string {
    const answer = dto.answer;
    if (answer.kind === "text") return answer.text;

    if (answer.kind === "boolean") {
      // The 236 boolean items carry ZERO options, so there is no chip to look up — the client
      // renders Haan/Nahi itself. Mapped to the words `parseAffirmation` reads rather than to a
      // stored `true`, so the yes/no lexicon stays the ONE thing that decides what yes means.
      return answer.value ? "haan" : "nahi";
    }

    const options = served?.options ?? [];
    const matched = answer.option_keys.map((key) => {
      const option = options.find((candidate: QuestionPackOption) => candidate.option_key === key);
      if (!option) {
        // 400, not a silent drop. An unknown key means the client is answering a question it is
        // no longer looking at, or one it built chips for itself — and capturing the keys it DID
        // recognize would store a partial answer the worker never gave.
        throw new BadRequestException(`Unknown option ${key} for this question`);
      }
      return option.label_text;
    });

    if (matched.length > 1 && served?.answerType !== "multi_select") {
      throw new BadRequestException("This question takes exactly one option");
    }

    // ONE label goes through verbatim, so `normalizeFor`'s exact-chip match fires and the stored
    // value is the option's own `value` rather than a re-parse of its words. Several are joined,
    // because `matchOptions` scans for each label independently — the separator is a separator,
    // not a syntax, so a label containing a comma cannot confuse it.
    return matched.join(", ");
  }

  /** The rendered value for one review row, or null when the worker declined or never answered. */
  private displayValue(record: AnswerRecord): string | null {
    if (record.status !== "answered") return null;
    const value = record.value_normalized ?? record.value_raw;
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) return value.map((v) => String(v)).join(", ");
    if (typeof value === "boolean") return value ? "Haan" : "Nahi";
    return String(value);
  }

  private stepOf(turn: TurnResult): ProfilingStep {
    if (turn.unavailable) return { kind: "unavailable", reply: turn.reply };
    if (turn.complete) return { kind: "done" };
    return {
      kind: "question",
      question: {
        question_key: turn.questionKey,
        prompt_text: turn.reply,
        answer_type: turn.answerType,
        // KEYS AND LABELS BOTH, and nothing else off the option: `value` and `implies_skill_id`
        // are engine business, and a client that could see them could be tempted to act on them.
        options: turn.options.map((option) => ({
          option_key: option.option_key,
          label_text: option.label_text,
        })),
        why_text: turn.whyText,
        tts_clip_id: clipId(turn.reply),
      },
      // 1-BASED, and derived from what is settled rather than counted client-side. `answered` is
      // how many questions are behind the worker, so the one in front of them is the next.
      index: Math.min(turn.progress.answered + 1, Math.max(turn.progress.total, 1)),
      total: turn.progress.total,
    };
  }

  private stepOfOutcome(outcome: ChatTurnOutcome): ProfilingStep {
    switch (outcome.kind) {
      // The interview is over and the flush already happened — the review screen is where the
      // worker belongs, not an error.
      case "session_over":
      case "reflushed":
        return { kind: "done" };
      case "unavailable":
      case "degraded":
        return { kind: "unavailable", reply: outcome.reply };
      case "replay":
        return this.stepOf(outcome.turn);
      case "turn":
        return this.stepOf(outcome.turn);
    }
  }
}

/**
 * The text a finalize re-drive carries.
 *
 * IT IS NEVER CAPTURED. `runTurn`'s completed-but-unflushed branch returns before the engine is
 * consulted, so this string reaches no `captureAnswer` and no transcript. It exists because
 * `runTurn` takes a message and this path has none — naming it is what stops the next reader
 * assuming a worker typed it.
 */
const FINALIZE_MARKER = "[finalize]";
