import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
  forwardRef,
} from "@nestjs/common";
import type { AnswerRecord, AnswerType, QuestionPackOption } from "@badabhai/ai-contracts";

import { ChatRepository } from "../chat/chat.repository";
import { ChatService, type ChatTurnOutcome } from "../chat/chat.service";
import type { RequestContext } from "../common/request-context";
import { MAX_PROFILING_ANSWER_SECONDS } from "@badabhai/types";
import { VoiceTranscriptionService } from "../voice/voice-transcription.service";
import {
  ProfilingOrchestrator,
  UNAVAILABLE_REPLY,
  type SessionView,
  type TurnResult,
} from "./orchestrator.service";
import { ProfilingVoiceRepository } from "./profiling-voice.repository";
import { isSettled } from "./answer-map";
import { clipId } from "./reply-closure";
import { ttsField } from "./question-tts-text";
import { WorkersRepository } from "../workers/workers.repository";
import { ProfilesService } from "../profiles/profiles.service";
import type {
  FinalizeProfilingResponse,
  ProfilingAnswerDto,
  ProfilingCorrectionDto,
  ProfilingCorrectionResponse,
  ProfilingReviewResponse,
  ProfilingSessionResponse,
  ProfilingStaleAnswerError,
  ProfilingStaleReason,
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
    private readonly transcription: VoiceTranscriptionService,
    private readonly voiceAnswers: ProfilingVoiceRepository,
    // Read-only, and for ONE question: had the profile already been built when a correction
    // landed? `latestProfile` is the same reader `autoTriggerExtraction` uses to decide the same
    // thing, so the two cannot disagree about whether a worker is profiled.
    private readonly workers: WorkersRepository,
    // The fourth trigger (#700). ProfilesModule imports ProfilingModule for the projector, so
    // this needs a forwardRef back — the cycle is real and is one interview, two concerns.
    @Inject(forwardRef(() => ProfilesService)) private readonly profiles: ProfilesService,
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
      throw new ConflictException({
        statusCode: 409,
        message:
          `Question ${dto.question_key ?? "(none)"} is no longer on screen for session ` +
          `${dto.session_id}; re-read the session before answering`,
        error: "Conflict",
        stale_reason: this.staleReason(view, dto.question_key),
      } satisfies ProfilingStaleAnswerError);
    }

    // A SPOKEN ANSWER IS TRANSCRIBED BEFORE THE TURN, synchronously, because the engine cannot
    // choose question n+1 without answer n's TEXT. Everything else resolves in memory.
    if (dto.answer.kind === "spoken") {
      return this.spokenAnswer(workerId, dto, dto.answer.voice_note_id, view, ctx);
    }

    const text = this.textFor(dto.answer, served?.options ?? [], served?.answerType ?? null);
    // THE CLIENT'S SUBMISSION ID, FORWARDED UNCHANGED (#931). Absent — an app build that predates
    // the field — arrives at the replay gate as `null` and is judged by the hash and the windows
    // exactly as it is today.
    const outcome = await this.chatService.runTurn(
      workerId,
      dto.session_id,
      text,
      ctx,
      dto.submission_id ?? null,
    );
    return { step: this.stepOfOutcome(outcome) };
  }

  /**
   * WHICH KIND OF STALE THIS 409 IS (#779). See `ProfilingStaleReasonSchema` for why the caller
   * needs to know and what the ambiguity costs.
   *
   * `answer_already_landed` is asserted ONLY on `status === "answered"`, which is the literal
   * claim the name makes: the engine took an answer for this question. It is deliberately NOT
   * `isSettled`, which also admits `declined` — a declined question is settled and the engine did
   * move on, but the worker's ANSWER was not taken, and reporting that as "landed" would let the
   * client bank engagement for an answer that does not exist. `declined` therefore falls to
   * `other`, which costs only a missed signal.
   *
   * FAIL-SOFT TO `other`, NEVER TO `answer_already_landed`. A null view (a closed or unresolvable
   * session) and a null `question_key` both land here, and both mean "we cannot show the answer
   * exists". The asymmetry is the safety property: `other` under-counts, `answer_already_landed`
   * over-counts, and only one of those corrupts the ranking input.
   *
   * IT MUST NOT BE ABLE TO THROW, AND THAT IS WHY THE SHAPE IS CHECKED RATHER THAN TRUSTED.
   * This runs INSIDE the construction of a 409. A throw here would replace that 409 with a 500 —
   * turning a routine, recoverable staleness into a hard failure, on precisely the connection
   * that is already failing, for precisely the workers this signal exists to represent. The
   * envelope is rehydrated from a jsonb column, so "it is always an array" is a claim about
   * upstream validation rather than about this value; `Array.isArray` costs nothing and makes the
   * degraded case a missed signal instead of a broken interview.
   */
  private staleReason(view: SessionView | null, questionKey: string | null): ProfilingStaleReason {
    const records: readonly AnswerRecord[] | undefined = view?.envelope.answerMap;
    if (questionKey === null || !Array.isArray(records)) return "other";
    const landed = records.find((record) => record.question_key === questionKey);
    return landed?.status === "answered" ? "answer_already_landed" : "other";
  }

  /**
   * A recorded clip becomes a turn: transcribe, take the turn, record the evidence.
   *
   * THE FAILURE MODE THIS EXISTS TO PREVENT is a worker speaking their answer into a noisy yard
   * and watching it disappear behind a green tick. `transcribeNow` reports WHICH failure — budget
   * blocked, call failed, service unreachable — and every one of them means the words did not
   * arrive, so no turn is taken and the worker is told they can say it again. Capturing an empty
   * transcript instead would spend the question's ask budget on silence they did not choose.
   */
  private async spokenAnswer(
    workerId: string,
    dto: ProfilingAnswerDto,
    voiceNoteId: string,
    view: SessionView | null,
    ctx: RequestContext,
  ): Promise<ProfilingStepResponse> {
    const transcribed = await this.transcription.transcribeNow({
      voiceNoteId,
      workerId,
      maxSeconds: MAX_PROFILING_ANSWER_SECONDS,
      ctx,
    });

    await this.recordClip(workerId, dto, voiceNoteId, view, transcribed);

    if (!transcribed.ok) {
      this.logger.warn(
        `spoken answer lost session=${dto.session_id} question=${dto.question_key ?? "-"} ` +
          `reason=${transcribed.errorCode}; no turn taken, the worker may record again`,
      );
      // THE EXISTING LINE, not a new one. It already means exactly this — nothing was written,
      // send it again — and it is already in the 433-clip render manifest, so a worker who cannot
      // read the screen HEARS it. Authoring a more specific line would be better copy and would
      // silently add a 434th clip that no rendered audio exists for.
      return { step: { kind: "unavailable", reply: UNAVAILABLE_REPLY } };
    }

    // THE ID MATTERS MOST ON THIS BRANCH. The text here is a TRANSCRIPT, so a re-recorded answer
    // produces different words and the hash misses every time — the reply cache cannot see a
    // spoken retry at all. The id is minted per physical submission and survives that, so a
    // duplicate delivery of ONE recording is finally recognisable as one (#931).
    const outcome = await this.chatService.runTurn(
      workerId,
      dto.session_id,
      transcribed.text,
      ctx,
      dto.submission_id ?? null,
    );
    return { step: this.stepOfOutcome(outcome) };
  }

  /**
   * The `profiling_voice_answer` row: this worker SPOKE this answer, at this attempt.
   *
   * NEVER FAILS THE TURN. It is an audit fact, and the answer it describes is already durable in
   * the transcript buffer and reaches Postgres through the flush. A worker must not lose a spoken
   * answer because an evidence INSERT hit a connection blip — so this logs and returns.
   *
   * WRITTEN ON FAILURE TOO, which is the more valuable half: a clip that was recorded, uploaded,
   * paid for, and never transcribed is invisible everywhere else in the system.
   */
  private async recordClip(
    workerId: string,
    dto: ProfilingAnswerDto,
    voiceNoteId: string,
    view: SessionView | null,
    transcribed:
      | { ok: true; text: string; durationSeconds: number | null }
      | { ok: false; errorCode: string },
  ): Promise<void> {
    const packId = view?.envelope.packId;
    const packVersion = view?.envelope.packVersion;
    // `pack_id` and `pack_version` are NOT NULL and pinned together by a CHECK. An unpinned
    // envelope means retrieval has not run yet, which cannot happen once a question is on screen
    // — but a row invented with a placeholder pack would be worse than no row.
    if (!packId || !packVersion || !dto.question_key) return;

    try {
      await this.voiceAnswers.recordAnswer({
        workerId,
        sessionId: dto.session_id,
        voiceNoteId,
        packId,
        packVersion,
        questionKey: dto.question_key,
        // The question's position in the interview, 1-based — `answered` is how many are behind
        // the worker, so the one they just spoke to is the next.
        ordinal: (view?.served?.progress.answered ?? 0) + 1,
        durationSeconds: transcribed.ok ? transcribed.durationSeconds : null,
        transcriptStatus: transcribed.ok ? "succeeded" : "failed",
        transcriptErrorCode: transcribed.ok ? null : transcribed.errorCode,
      });
    } catch (err) {
      this.logger.error(
        `failed to record the voice-answer evidence row session=${dto.session_id} ` +
          `question=${dto.question_key}; the ANSWER is unaffected: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
    const prompts = new Map(
      (view?.items ?? []).map((item) => [item.question_key, item.prompt_text]),
    );

    // POSTGRES FIRST, AND THAT ORDER IS THE WHOLE FIX. The review screen exists to be shown AFTER
    // the last question — but the engine closing the interview triggers the flush, and the flush
    // drops the Redis key the instant its transaction commits. Reading the envelope therefore
    // returned an EMPTY review at exactly the moment the review is for. Measured live: `rows: 0`
    // against twelve `worker_pack_answer` rows already durable in Postgres.
    //
    // The envelope is still the right source MID-INTERVIEW, where nothing has been flushed yet —
    // so it is the fallback rather than the replacement, and a worker who backs into the review
    // half way through still sees what they have answered so far.
    const flushed = await this.chat.listPackAnswers(sessionId);
    const rows =
      flushed.length > 0
        ? flushed.map((row) => ({
            question_key: row.questionKey,
            prompt_text: prompts.get(row.questionKey) ?? row.questionKey,
            status: row.status as "answered" | "declined" | "unanswered",
            display_value: this.displayValueOf(
              row.answerBool ?? row.answerNumber ?? row.answerText ?? row.answerOptionKeys,
              row.status,
            ),
          }))
        : // `envelope.answerMap` rather than `answersOf`, because the review is a LIST and the
          // array is the contract's stable order. Keying it first would hand the screen whatever
          // order the object happened to hold, which for a worker reading their answers back is
          // not the same screen twice.
          (view?.envelope.answerMap ?? [])
            .filter((record) => record.status !== "superseded")
            .map((record) => ({
              question_key: record.question_key,
              prompt_text: prompts.get(record.question_key) ?? record.question_key,
              status: record.status as "answered" | "declined" | "unanswered",
              display_value: this.displayValueOf(
                record.value_normalized ?? record.value_raw,
                record.status,
              ),
            }));

    return {
      session_id: sessionId,
      complete: view?.buffer.completedAt !== undefined || session.status !== "active",
      rows,
    };
  }

  /**
   * Change an answer the worker can see is wrong.
   *
   * THE REVIEW SCREEN IS THE ONLY PATH TO SUBMIT (#632), so this is the last moment before the
   * profile is built and the value reaches the matcher. A worker who sees a wrong value here and
   * cannot fix it submits it or abandons — and in chat they would simply have said so, because the
   * correction lexicon picks it up mid-conversation. This route is that affordance, for a surface
   * that has no mid-conversation left.
   *
   * WHAT THIS METHOD OWNS is only what a SURFACE owns: whose session it is, turning a tap or a clip
   * into words, and drawing the result. Every engine rule — supersession, the overwrite escape, the
   * capture path, the bound — belongs to `ProfilingOrchestrator.correctAnswer`, which is where the
   * proof for bypassing the turn loop lives.
   */
  async correct(
    workerId: string,
    dto: ProfilingCorrectionDto,
    ctx: RequestContext,
  ): Promise<ProfilingCorrectionResponse> {
    const session = await this.chat.findSession(dto.session_id);
    // 404 not 403, exactly as the other routes: a session id must never be an existence oracle.
    if (!session || session.workerId !== workerId) {
      throw new NotFoundException(`Session ${dto.session_id} not found`);
    }

    const view = await this.orchestrator.viewSettled(dto.session_id, new Date());
    if (!view) {
      throw new ConflictException(
        `Session ${dto.session_id} has no pinned pack; there is nothing settled to correct`,
      );
    }

    const item = view.items.find((candidate) => candidate.question_key === dto.question_key);
    // 400, not 404: the session exists and is the worker's — the QUESTION is the malformed part,
    // and resolving it from the pinned pack is what stops a client correcting an arbitrary key.
    if (!item) {
      throw new BadRequestException(`Question ${dto.question_key} is not in this session's pack`);
    }

    // A QUESTION STILL ON SCREEN BELONGS TO THE TURN LOOP. Correcting it here would write the
    // answer without spending its ask budget or recording a turn, so the engine would go on to
    // serve a question the worker has already answered.
    if (!isSettled(view.answers, dto.question_key)) {
      throw new ConflictException(
        `Question ${dto.question_key} is not settled; answer it through POST /profiling/answer`,
      );
    }

    const text =
      dto.answer.kind === "spoken"
        ? await this.transcribeCorrection(workerId, dto.answer.voice_note_id, ctx)
        : this.textFor(dto.answer, item.options, item.answer_type);

    const existing = await this.workers.latestProfile(workerId);
    const outcome = await this.orchestrator.correctAnswer({
      sessionId: dto.session_id,
      workerId,
      questionKey: dto.question_key,
      text,
      method: dto.answer.kind,
      profileAlreadyBuilt: existing !== undefined && existing !== null,
      now: new Date(),
      ctx,
    });

    if (outcome.kind === "capped") {
      throw new ConflictException(`This interview has already taken ${outcome.cap} corrections`);
    }
    if (outcome.kind === "unreadable") {
      // 422, not 400: the request was well-formed and the words simply did not parse to a value
      // for this question. The client's correct response is to offer another affordance — the
      // review screen's chips → mic → typing order exists for exactly this.
      throw new UnprocessableEntityException(
        `Could not read an answer to ${dto.question_key} from that`,
      );
    }

    // THE BOUNDARY, and it is the whole of why this is safe.
    //
    // NO PROFILE YET → do nothing. An extraction is already queued or running from the ordinary
    // flush trigger, and it reads `conversation_state.answer_map` when it RUNS — which is after
    // this correction committed. It will therefore build from the corrected answers by itself.
    // Firing a rebuild here would be a second trigger on data the first has not read yet, which
    // is #420's shape exactly.
    //
    // PROFILE ALREADY BUILT → rebuild. The extraction has been and gone; the stored answer is now
    // right and the profile is stale, and nothing else will ever notice.
    let rebuild: { ai_job_id: string; status: string } | null = null;
    if (existing) {
      this.logger.log(
        `correction landed after profile ${existing.id} was built session=${dto.session_id} ` +
          `question=${dto.question_key}; queuing a rebuild`,
      );
      rebuild = await this.profiles.rebuildAfterCorrection(
        {
          worker_id: workerId,
          session_id: dto.session_id,
          answer_set_hash: outcome.answerSetHash,
        },
        ctx,
      );
    }

    return {
      session_id: dto.session_id,
      question_key: dto.question_key,
      row: {
        question_key: dto.question_key,
        prompt_text: item.prompt_text,
        status: "answered",
        display_value: this.displayValueOf(outcome.value, "answered"),
      },
      correction_count: outcome.correctionCount,
      // TRUE means a rebuild is UNDERWAY, not that one is owed. It stays false when no profile
      // existed, because the ordinary extraction has not run yet and will pick the correction up
      // on its own — there is nothing to rebuild.
      profile_rebuild_required: rebuild !== null,
    };
  }

  /**
   * A spoken correction → its words.
   *
   * THROWS RATHER THAN DEGRADING, which is the opposite of the answer route and deliberately so.
   * There, a lost clip returns `unavailable` and the worker records again against a question still
   * on screen. Here there is no question on screen and no turn to retry — a soft failure would
   * leave the review screen showing the old value with no indication the correction was lost.
   */
  private async transcribeCorrection(
    workerId: string,
    voiceNoteId: string,
    ctx: RequestContext,
  ): Promise<string> {
    const transcribed = await this.transcription.transcribeNow({
      voiceNoteId,
      workerId,
      maxSeconds: MAX_PROFILING_ANSWER_SECONDS,
      ctx,
    });
    if (!transcribed.ok) {
      throw new UnprocessableEntityException(
        `That recording could not be transcribed (${transcribed.errorCode})`,
      );
    }
    return transcribed.text;
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
    //
    // AND NO SUBMISSION ID (#931), for the same reason the text is never captured: there is no
    // worker submission behind this call. `FINALIZE_MARKER` is server-synthesised, and attaching
    // an id "for consistency" would make it a stampable turn carrying a client's id for something
    // the client never sent.
    const outcome = await this.chatService.runTurn(workerId, sessionId, FINALIZE_MARKER, ctx, null);
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
  private textFor(
    answer: ProfilingAnswerDto["answer"],
    options: readonly QuestionPackOption[],
    answerType: AnswerType | null,
  ): string {
    // `spoken` is resolved before this is reached — it needs a provider call, and a synchronous
    // mapper is the wrong place for one.
    if (answer.kind === "spoken") throw new BadRequestException("A spoken answer needs a clip");
    if (answer.kind === "text") return answer.text;

    if (answer.kind === "boolean") {
      // The 236 boolean items carry ZERO options, so there is no chip to look up — the client
      // renders Haan/Nahi itself. Mapped to the words `parseAffirmation` reads rather than to a
      // stored `true`, so the yes/no lexicon stays the ONE thing that decides what yes means.
      return answer.value ? "haan" : "nahi";
    }

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

    if (matched.length > 1 && answerType !== "multi_select") {
      throw new BadRequestException("This question takes exactly one option");
    }

    // ONE label goes through verbatim, so `normalizeFor`'s exact-chip match fires and the stored
    // value is the option's own `value` rather than a re-parse of its words. Several are joined,
    // because `matchOptions` scans for each label independently — the separator is a separator,
    // not a syntax, so a label containing a comma cannot confuse it.
    return matched.join(", ");
  }

  /**
   * The rendered value for one review row, or null when the worker declined or never answered.
   *
   * ONE FUNCTION FOR BOTH SOURCES. The flushed row and the live envelope hold the same values in
   * different shapes, and rendering them separately is how a worker's answer would come to look
   * different depending on whether the interview had finished — which is the one comparison the
   * review screen exists to make.
   */
  private displayValueOf(value: unknown, status: string): string | null {
    if (status !== "answered") return null;
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) return value.map((v) => String(v)).join(", ");
    if (typeof value === "boolean") return value ? "Haan" : "Nahi";
    // `numeric` columns arrive as strings from postgres-js; `String()` is a no-op on those and
    // the right rendering for a number either way.
    return String(value);
  }

  private stepOf(turn: TurnResult): ProfilingStep {
    if (turn.unavailable) return { kind: "unavailable", reply: turn.reply };
    if (turn.complete) return { kind: "done" };
    return {
      kind: "question",
      question: {
        question_key: turn.questionKey,
        // THE ENGINE'S OWN VERDICT (#706), not `questionKey === null` inferred by whoever draws
        // this. The fact reaches here on `TurnResult` and was dropped at this one site, leaving a
        // disambiguation offer indistinguishable from an ordinary ask on the surface where the
        // worker is being read to rather than reading.
        question_kind: turn.kind,
        prompt_text: turn.reply,
        answer_type: turn.answerType,
        // KEYS, LABELS, AND THE ESCAPE FLAG — still nothing else off the option: `value` and
        // `implies_skill_id` are engine business, and a client that could see them could be
        // tempted to act on them. `is_none_of_above` is different in kind: it is a property of
        // how the option should be PRESENTED, and withholding it only forced the client to
        // rediscover it by matching display copy.
        options: turn.options.map((option) => ({
          option_key: option.option_key,
          label_text: option.label_text,
          is_none_of_above: option.is_none_of_above,
        })),
        why_text: turn.whyText,
        tts_clip_id: clipId(turn.reply),
        // #896 — the on-device fallback for when the clip id resolves to no bundled asset.
        ...ttsField(turn.reply),
      },
      // 1-BASED, and derived from what is settled rather than counted client-side. `answered` is
      // how many questions are behind the worker, so the one in front of them is the next.
      index: Math.min(turn.progress.answered + 1, Math.max(turn.progress.total, 1)),
      total: turn.progress.total,
      // THE PREDICTION, projected through the SAME rules as the question above it — including the
      // `tts_clip_id`, which is the whole reason this is worth more on the voice surface than on
      // chat: a client that knows the next clip id can have the audio ready before the tap, so a
      // worker who cannot read hears the next question immediately instead of hearing silence.
      //
      // A CLOSE PREDICTION IS DROPPED rather than rendered. This union models "the interview is
      // over" as its own step (`done`), so a lookahead entry claiming `kind: "close"` has no
      // question to draw and the client should simply take the round trip and be moved to the
      // review screen by the real response.
      lookahead: turn.lookahead
        ? Object.fromEntries(
            Object.entries(turn.lookahead)
              .filter(([, entry]) => entry.kind === "ask" && entry.questionKey !== null)
              .map(([answerKey, entry]) => [
                answerKey,
                {
                  question_key: entry.questionKey,
                  question_kind: entry.kind,
                  prompt_text: entry.promptText,
                  why_text: entry.whyText,
                  answer_type: entry.answerType,
                  options: entry.options.map((option) => ({
                    option_key: option.option_key,
                    label_text: option.label_text,
                    is_none_of_above: option.is_none_of_above,
                  })),
                  tts_clip_id: clipId(entry.promptText),
                  ...ttsField(entry.promptText),
                  index: Math.min(entry.progress.answered + 1, Math.max(entry.progress.total, 1)),
                  total: entry.progress.total,
                  // #766 item 4. Load-bearing on THIS surface specifically: `tts_clip_id` above
                  // means a stale prediction is spoken, not repainted.
                  turn: entry.turn,
                },
              ]),
          )
        : null,
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
