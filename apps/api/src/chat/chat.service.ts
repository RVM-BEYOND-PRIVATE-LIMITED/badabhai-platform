import { Inject, Injectable, Logger, NotFoundException, forwardRef } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { RequestContext } from "../common/request-context";
import { SERVER_CONFIG } from "../config/config.module";
import { EventsService } from "../events/events.service";
import { WorkersRepository } from "../workers/workers.repository";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { ProfilesService } from "../profiles/profiles.service";
import { ProfilingOrchestrator, type TurnResult } from "../profiling/orchestrator.service";
import { CLOSING_REPLY_TEXT } from "../profiling/next-question";
import { ttsField, ttsTextFor } from "../profiling/question-tts-text";
import { toConversationStatePatch } from "../profiling/conversation-state";
import { packAnswerRowFor } from "../profiling/pack-answer-row";
// T3: the SAME "did this extraction extract anything?" predicate ProfilesService
// dedupes on (issue #420). A pure leaf function — no new module edge, no new cycle.
import { hasExtractedContent } from "../profiles/profile-content";
import type { NewWorkerPackAnswer } from "@badabhai/db";
import type { QuestionPackOption } from "@badabhai/ai-contracts";
import { CHAT_OPENING_TEXT } from "./chat-replies";
import { ChatRepository } from "./chat.repository";
import {
  ChatTranscriptBuffer,
  type BufferedMessage,
  type TranscriptBuffer,
} from "./chat-transcript.buffer";
import {
  PostMessageResponseSchema,
  StartSessionResponseSchema,
  type PostMessageDto,
  type PostMessageResponse,
  type StartSessionResponse,
  type SessionMessagesResponse,
} from "./chat.dto";

const DEFAULT_ROLE_FAMILY = "cnc_vmc";

/**
 * A pack option → the three fields the client is allowed to see (#695).
 *
 * ONE PROJECTION, USED BY EVERY SITE THAT SERVES CHIPS, so the fresh turn and the replayed turn
 * cannot disagree about what an option is — the drift that let a replay serve the same words with
 * no chips at all.
 *
 * `value` and `implies_skill_id` are dropped rather than forwarded. Neither is renderable, and
 * `implies_skill_id` is a taxonomy internal that has no business on a worker's device (§9: never
 * expose unnecessary data).
 */
function toWireOption(option: QuestionPackOption): {
  option_key: string;
  label_text: string;
  is_none_of_above: boolean;
} {
  return {
    option_key: option.option_key,
    label_text: option.label_text,
    is_none_of_above: option.is_none_of_above,
  };
}

/**
 * A normalized answer value → the ONE typed column it belongs in, or `null` when no column can
 * hold it.
 *
 * FOUR COLUMNS AND A NULL, matching `wpa_answer_shape_chk` exactly. Returning null rather than
 * stringifying an unknown shape is the point: `String({})` is `"[object Object]"`, which the
 * constraint would happily accept and which is worse than storing nothing, because it is
 * indistinguishable from a real answer at every later read.
 */
/**
 * Split the answer map by status, for `profile.interview_completed`.
 *
 * THE THREE ARE KEPT APART DELIBERATELY. `declined` is a COMPLETE answer — "nahi pata" is the
 * plan's own hardest-won rule — and folding it into `unanswered` would erase the difference
 * between a worker who told us they do not know and a question that was never settled. A rising
 * decline rate on one question is a question-quality problem; a rising unanswered rate is an
 * engine problem. One number cannot say which.
 *
 * `superseded` records (a correction's old value) are counted under neither: they are history,
 * not outcomes, and including them would make the counts exceed the questions asked.
 */
function countAnswerStatuses(answers: readonly { status?: string }[]): {
  answered: number;
  declined: number;
  unanswered: number;
} {
  let answered = 0;
  let declined = 0;
  let unanswered = 0;
  for (const a of answers) {
    if (a.status === "answered") answered++;
    else if (a.status === "declined") declined++;
    else if (a.status === "unanswered") unanswered++;
  }
  return { answered, declined, unanswered };
}

// AI-PERSONA-2: the ai-service emits this literal token (never a real name) at the
// vocative slots. The real first name is interpolated over it here in the API,
// POST-emit, only in the value returned to the client — see renderWorkerName.
const WORKER_NAME_PLACEHOLDER = "{{worker_name}}";

/**
 * Re-exported from the import-free module so the TTS closure can read them without Nest.
 *
 * `export … from` alone would not bind them locally, and `startSession` below serves the opener,
 * so it is imported as well. One statement each way, and still one definition.
 */
export { CHAT_UNAVAILABLE_REPLY, CHAT_OPENING_TEXT } from "./chat-replies";

/**
 * Served on a message posted to an interview that has already been finalized.
 *
 * AN ALIAS, NOT A SECOND STRING (#679). It was declared here as its own byte-identical literal,
 * which is precisely the drift the rest of the reply-closure work went out of its way to
 * eliminate: two copies of a worker-facing line, and which one a worker hears decided by which
 * internal path produced it. The local name stays because the two call sites below are about a
 * dead session rather than a normal close, and reading `CLOSING_REPLY_TEXT` there would suggest
 * the interview just ended.
 */
const CHAT_ALREADY_COMPLETE_REPLY = CLOSING_REPLY_TEXT;

/**
 * What one interview turn DID, before anybody decides how to render it.
 *
 * A CLOSED SET RATHER THAN A NULLABLE RESULT, because five of these six are not "the turn, but
 * degraded" — they are distinct facts with distinct client contracts, and a shape that collapsed
 * them (`{ turn: TurnResult | null }`) would leave every caller re-deriving which one happened
 * from a combination of flags. That re-derivation is precisely where two surfaces drift: one of
 * them eventually treats a `replay` as a `turn`, double-counts it, and the worker's retry over a
 * bad connection costs them a question.
 *
 * `session_over` and `reflushed` carry no `TurnResult` because no turn was taken — the engine was
 * never consulted. `unavailable` and `degraded` carry only the line to serve: in both, nothing
 * the worker said was written, and the honest response is one they can retry into.
 */
export type ChatTurnOutcome =
  /** The session was already finalized. No writes, no engine call — a late duplicate POST. */
  | { readonly kind: "session_over" }
  /** A completed-but-unflushed buffer was re-driven. `flushed` says whether it landed this time. */
  | { readonly kind: "reflushed"; readonly flushed: boolean }
  /** The orchestrator wrote NOTHING: a lost CAS after two attempts, or no resolvable pack. */
  | { readonly kind: "unavailable"; readonly reply: string }
  /** The buffer vanished between the CAS write and the read-back. The reply is still served. */
  | { readonly kind: "degraded"; readonly reply: string }
  /** Layer A fired — the previous reply, byte-identically, with no state changed. */
  | { readonly kind: "replay"; readonly turn: TurnResult }
  /** A real turn. `terminal` is true only when the interview closed AND the flush LANDED. */
  | {
      readonly kind: "turn";
      readonly turn: TurnResult;
      readonly buffered: TranscriptBuffer;
      readonly terminal: boolean;
    };

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly chat: ChatRepository,
    private readonly workers: WorkersRepository,
    private readonly pii: PiiCryptoService,
    private readonly events: EventsService,
    private readonly buffer: ChatTranscriptBuffer,
    // forwardRef: ProfilesModule imports ChatModule (for the transcript), so the
    // dependency is circular. Used to auto-trigger extraction on the readiness flip.
    @Inject(forwardRef(() => ProfilesService)) private readonly profiles: ProfilesService,
    // forwardRef: ProfilingModule needs ChatTranscriptBuffer from here. THE turn now runs
    // through this — see postMessage.
    @Inject(forwardRef(() => ProfilingOrchestrator))
    private readonly orchestrator: ProfilingOrchestrator,
  ) {}

  async startSession(workerId: string, ctx: RequestContext) {
    const worker = await this.workers.findById(workerId);
    if (!worker) throw new NotFoundException(`Worker ${workerId} not found`);

    // REATTACH BEFORE MINT (#1197) — the server-side twin of the voice form's
    // `ProfilingSessionService.start`. This POST fires on every cold app open, and until now
    // it inserted unconditionally: a trail of one-row `'active'` sessions that the
    // abandonment sweep then drains at 100/hour. The client's `GET /session/latest` resume
    // is best-effort (its failure falls through to THIS POST) and older shipped builds never
    // had it at all, so the guard belongs here, where every caller lands.
    //
    // A live session is returned VERBATIM in the same three keys a fresh start serves, and
    // deliberately WITHOUT `opening_text`: this is a resume, and the transcript the client
    // redraws via GET /messages already contains the questions that greeting precedes.
    // No `chat.session_started` either — nothing changed state, and the original start
    // already emitted it under this session's idempotency key.
    //
    // KNOWN RACE, ACCEPTED: two concurrent POSTs can both miss the read and mint. Closing it
    // needs a partial unique index on `(worker_id) WHERE status = 'active'`, which the
    // existing multi-active backlog would violate on creation; the sweep already retires
    // those rows, and the loser of the race loses nothing but an empty row.
    const live = await this.chat.findActiveSessionByWorker(workerId);
    if (live) {
      this.logger.log(`reattached to live session worker=${workerId} session=${live.id}`);
      return {
        session_id: live.id,
        status: live.status,
        started_at: live.startedAt,
      };
    }

    const session = await this.chat.createSession(workerId);
    await this.events.emit({
      event_name: "chat.session_started",
      actor: { actor_type: "worker", actor_id: workerId },
      subject: { subject_type: "chat_session", subject_id: session.id },
      payload: { session_id: session.id, worker_id: workerId },
      idempotencyKey: `chat.session_started:${session.id}`,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
    const base = {
      session_id: session.id,
      status: session.status,
      started_at: session.startedAt,
    };

    // One-shot composite opener (CHAT_ONE_SHOT_OPENER_ENABLED, default OFF).
    //
    // OFF is byte-identical to before this existed: no outbound call at all — the
    // `post()` helper's 8s timeout must never appear on the chat-mount path — and the
    // response keys stay exactly the three above. The key is OMITTED, not null, so a
    // client that does not know about it sees no change whatsoever.
    //
    // ON, `opening_text` invites the worker to answer every topic in one message. The
    // engine still asks for whatever they leave out, so a partial answer degrades to
    // today's flow rather than losing anything.
    //
    // NO EVENT: this is read-shaped output on an existing endpoint, and
    // `chat.session_started` above already records the state change. Adding a field
    // to that payload would mutate a shipped event schema (invariant #8).
    //
    // NOT POSTED, and this is the load-bearing part: the opener is rendered by the
    // client and never stored as a chat message, so it never enters the extraction
    // transcript. Measured — an opener naming example values, on the `messages`-absent
    // fallback that PR #493 documents as its rollback lever, hands the worker four
    // machines, five controllers and two qualifications they never said.
    if (!this.config.CHAT_ONE_SHOT_OPENER_ENABLED) return base;

    // STATIC REVIEWED COPY, NOT A MODEL CALL (OIE Phase 8). This used to be
    // `ai.profilingOpening()` — a `capable`-tier LLM call, memoized per role family, made on
    // the chat MOUNT path. The route behind it is deleted with the rest of the LLM interview,
    // and the replacement is a constant from the persona corpus lifted out of `persona.py`:
    // the same voice, reviewed once in a git diff instead of regenerated per deployment.
    //
    // DELIBERATELY NOT the universal pack's first question. The engine asks that on the first
    // POST, and rendering it here too would show the worker the same question twice — once as
    // an un-answerable greeting and once as a real turn.
    // #896 — the opener's Devanagari twin ships WITH it, so turn one reads aloud correctly and
    // the client can stop carrying its own hard-coded copy of this sentence.
    const response: StartSessionResponse = {
      ...base,
      opening_text: CHAT_OPENING_TEXT,
      ...(ttsTextFor(CHAT_OPENING_TEXT) === undefined
        ? {}
        : { opening_tts_text: ttsTextFor(CHAT_OPENING_TEXT) }),
    };
    const checked = StartSessionResponseSchema.safeParse(response);
    if (!checked.success) {
      this.logger.warn(
        `startSession outbound validation failed session=${session.id} ` +
          `paths=[${checked.error.issues.map((i) => i.path.join(".")).join(",")}]`,
      );
    }
    return response;
  }

  /**
   * One interview turn. NOTHING IS WRITTEN TO POSTGRES HERE — that is the change.
   *
   * The turn used to cost five Postgres writes: an inbound message, a
   * `chat.message_received`, an outbound message, a `chat.message_sent`, and a
   * `conversation_state` UPDATE. Over a thirty-turn interview that is ~150 rows
   * recording a conversation nothing downstream reads until it is finished, and a
   * worker who abandons on turn three leaves three permanent rows describing nothing.
   * The whole conversation now buffers in Redis and flushes ONCE, transactionally, in
   * {@link finalizeInterview}.
   *
   * WHAT DID NOT CHANGE, because it is the security spine:
   *   - the worker id comes from `@CurrentWorker`, never the body;
   *   - a session that is missing OR not yours is **404, never 403** (a 403 confirms
   *     the id exists and turns this route into an existence oracle);
   *   - the ownership check reads the `chat_sessions` ROW, never the buffer — an
   *     absent cache key must never be able to answer an authorization question;
   *   - `redactKnownName` strips the worker's own name from everything crossing the
   *     ai-service boundary, and now from every HISTORY leg too, not just this turn;
   *   - `renderWorkerName` runs LAST, on the client-returned string only.
   */
  async postMessage(
    workerId: string,
    dto: PostMessageDto,
    ctx: RequestContext,
  ): Promise<PostMessageResponse> {
    // `?? null` AND NOT `?? undefined`: absent on the wire is the supported legacy case — an app
    // build that predates the field — and it has to arrive at the replay gate as the explicit
    // "this submission carries no id" that makes it take the hash + window path (#931).
    const outcome = await this.runTurn(
      workerId,
      dto.session_id,
      dto.text,
      ctx,
      dto.submission_id ?? null,
      // TYPED, ALWAYS. This is `POST /chat/message`, whose DTO has no clip slot — a voice note
      // reaches chat only after the worker has confirmed its transcript, and it arrives here as
      // ordinary text. If that route ever grows a clip id, this is the line that must change.
      null,
    );
    switch (outcome.kind) {
      case "session_over":
        return this.terminalResponse(dto.session_id);
      case "reflushed":
        return this.checkedResponse(
          {
            session_id: dto.session_id,
            reply: CHAT_ALREADY_COMPLETE_REPLY,
            ...this.ttsField(CHAT_ALREADY_COMPLETE_REPLY, null),
            blocked: false,
            is_mock: true,
            // Nothing is on screen to tap: the interview is over.
            suggested_followups: [],
            suggested_options: [],
            asked_question_id: null,
            extraction_ready: outcome.flushed,
            unanswered_essentials: [],
            session_ended: outcome.flushed,
            question_kind: "close",
            // A finished interview constrains nothing; typing is available as it always was.
            input_mode: "text",
            // No question is on screen here, so there is no answer shape to describe.
            answer_type: null,
            progress: null,
            occupation_label: null,
            // No prediction on a turn that served no pack question.
            lookahead: null,
          },
          dto.session_id,
        );
      case "unavailable":
      case "degraded":
        return this.degradedResponse(dto.session_id, outcome.reply);
      case "replay":
        // 4. Layer A of the double-submit defence fired: this exact message at this exact rev
        //    inside the replay window. The previous reply is returned byte-identically and NO
        //    state changed — which is what a mobile client on a flaky 2G connection needs, as
        //    opposed to a 409 telling it something went wrong when nothing did.
        return this.checkedResponse(
          {
            session_id: dto.session_id,
            reply: outcome.turn.reply,
            // FROM THE REPLAYED TURN too — a resubmit over a bad link must read aloud exactly as
            // the response it claims to repeat.
            ...this.ttsField(outcome.turn.reply, null),
            blocked: false,
            is_mock: false,
            // FROM THE REPLAYED TURN, not empty (#695). The orchestrator caches the chips
            // precisely so a replay is the response it claims to repeat, and this site then
            // dropped them — which on a disambiguation offer is the worst version of it: the
            // right words, no options, and now a `disambiguate` kind telling the client to draw
            // a single-select with nothing in it. A worker who resubmits over a bad connection
            // gets what they got the first time.
            suggested_followups: outcome.turn.options.map((option) => option.label_text),
            suggested_options: outcome.turn.options.map(toWireOption),
            asked_question_id: outcome.turn.questionKey,
            extraction_ready: false,
            unanswered_essentials: [],
            session_ended: false,
            question_kind: outcome.turn.kind,
            // FROM THE REPLAYED TURN, for the same reason the chips above are. The gate is served
            // `options_only`, and re-deriving `text` here would give a worker who resubmitted over
            // a bad link a keyboard where the response it claims to repeat had two buttons.
            input_mode: outcome.turn.inputMode ?? "text",
            // FROM THE CACHED TURN, never null. `LastTurn.answerType` is persisted and
            // re-validated on read precisely so a replay REPEATS the turn rather than
            // downgrading it: hardcoding null would make a resent message silently drop
            // the widget the worker is already looking at.
            answer_type: outcome.turn.answerType,
            progress: outcome.turn.progress,
            occupation_label: null,
            // No prediction on a turn that served no pack question.
            lookahead: null,
          },
          dto.session_id,
        );
      case "turn":
        return this.projectTurn(dto.session_id, workerId, outcome);
    }
  }

  /**
   * ONE INTERVIEW TURN, up to but not including how it is rendered.
   *
   * EXTRACTED SO THERE IS EXACTLY ONE OF IT. The owner ruling on this feature is that both
   * surfaces must build the profile the same way, and everything between the ownership check and
   * the projection is where "the same way" actually lives: the completed-but-unflushed re-drive,
   * the CAS-losing `unavailable` branch, the replay short-circuit, the re-read of what actually
   * landed, the flush, and the mid-interview checkpoint. A second surface that reimplemented any
   * one of those would be a second interview engine wearing the first one's name — and the ways
   * they would drift are all silent (a checkpoint that stops firing, a flush judged by
   * `turn.complete` instead of by whether it landed).
   *
   * WHAT STAYS WITH THE CALLER is only the projection, because that genuinely differs: chat
   * returns chip LABELS in `suggested_followups`, and the voice form needs option KEYS, an
   * `answer_type` and a `why_text` in order to draw a question it cannot make the worker read.
   *
   * The security spine does NOT move: the worker id is the caller's authenticated id, the
   * ownership test reads the `chat_sessions` ROW rather than the buffer, and a session that is
   * missing OR not yours is 404 rather than 403.
   */
  async runTurn(
    workerId: string,
    sessionId: string,
    text: string,
    ctx: RequestContext,
    /**
     * The client's id for this physical submission, or `null` when there is no client submission
     * behind this turn (#931).
     *
     * REQUIRED RATHER THAN OPTIONAL, at the cost of one explicit `null` at the finalize re-drive.
     * A caller that forgets an optional id gets today's hash-and-clock behaviour silently — which
     * is the defect this parameter exists to close, reappearing as an omission no test would
     * catch. Made required, forgetting it is a build failure, and the one caller with nothing
     * honest to pass has to say so in as many words.
     */
    submissionId: string | null,
    /**
     * The `voice_notes` row this turn's words were SPOKEN into, or `null` when typed (#1244).
     *
     * REQUIRED RATHER THAN OPTIONAL, matching `submissionId` directly above and for the same
     * reason: the only caller that knows a clip produced this turn is `ProfilingSessionService`,
     * and an optional parameter would let it forget — recording a spoken answer as typed, which
     * is the exact defect this closes. Threaded to the buffer, not written here: `chat_messages`
     * is written once at flush, and this is how the fact survives to it.
     */
    voiceNoteId: string | null,
  ): Promise<ChatTurnOutcome> {
    const dto = { session_id: sessionId, text };
    const session = await this.chat.findSession(dto.session_id);
    // Ownership: a worker may only post to their OWN session. 404 (not 403) so a
    // session id is never an existence oracle for another worker's session.
    if (!session || session.workerId !== workerId) {
      throw new NotFoundException(`Session ${dto.session_id} not found`);
    }

    // A finalized interview is TERMINAL. Serve a closing line rather than throwing:
    // the flush already happened, the profile is being built, and a 409 here would
    // surface to the worker as an error for something that actually succeeded. No LLM
    // call, no writes — a late duplicate POST costs nothing.
    if (session.status !== "active") {
      return { kind: "session_over" };
    }

    // 1. The buffered interview. Fails CLOSED (503) rather than silently restarting at
    //    question one — see ChatTranscriptBuffer.
    const now = new Date();
    let buffer = await this.buffer.load(dto.session_id);
    if (buffer && buffer.workerId !== workerId) {
      // Tripwire, not an expected branch: the session row already proved ownership, so
      // a buffer naming a different worker means key reuse or a bad write. Discard it
      // rather than mixing two workers' answers into one transcript.
      this.logger.error(
        `transcript buffer for session ${dto.session_id} named a different worker; ` +
          `discarding it and restarting the interview`,
      );
      buffer = null;
    }
    if (buffer === null) {
      // No buffer. Usually turn one — but it is ALSO what a lapsed TTL looks like on
      // turn twelve, and the two are otherwise indistinguishable: `turnCount` resets to
      // 0, `captured` empties, and eleven turns of the worker's answers are simply gone
      // with nothing in the log to say so.
      //
      // The session row is the only evidence available (nothing else is written
      // mid-interview), so the test is conservative: a session OLDER than the TTL cannot
      // still have a buffer, so its absence is certainly an expiry, never a first turn.
      // A lapse inside the window stays ambiguous and is not guessed at.
      const ageMs = now.getTime() - new Date(session.startedAt).getTime();
      if (ageMs > this.config.CHAT_TRANSCRIPT_TTL_SECONDS * 1000) {
        this.logger.warn(
          `session ${dto.session_id} is older than CHAT_TRANSCRIPT_TTL_SECONDS and has ` +
            `no buffer; its earlier turns have expired and the interview restarts from ` +
            `zero (age=${Math.round(ageMs / 1000)}s)`,
        );
      }
      buffer = ChatTranscriptBuffer.create(workerId, DEFAULT_ROLE_FAMILY, now);
    }

    // 1b. RETRY A COMPLETED-BUT-UNFLUSHED INTERVIEW. `completedAt` is set only just
    //     before the flush, so finding it still set on a fresh POST means the previous
    //     flush transaction rolled back and the buffer survived. Re-drive it HERE,
    //     before the AI call: the interview is already over, so spending another real
    //     LLM turn on it would be pure waste, and the worker's message needs no reply
    //     beyond the closing one. Without this the buffer is only ever re-flushed if a
    //     LATER turn happens to complete again — which, for an interview the client
    //     believes is finished, is never.
    if (buffer.completedAt) {
      const reflushed = await this.finalizeInterview(workerId, dto.session_id, buffer, ctx);
      this.logger.warn(
        `session ${dto.session_id} had a completed-but-unflushed buffer; ` +
          `re-flush ${reflushed ? "succeeded" : "FAILED again"}`,
      );
      return { kind: "reflushed", flushed: reflushed };
    }

    // 2. THE TURN. Deterministic, in-process, ZERO LLM CALLS.
    //
    //    Everything that used to happen between here and step 8 — the redacted history,
    //    the `profilingRespond` round trip, the echoed `turn_count` the API had to
    //    distrust, the `force_complete` flag a model could ignore — is gone, replaced by
    //    one call into the orchestrator. Turn budget, answer capture, question selection,
    //    the CAS write and the buffer append all live there, because they are ONE
    //    decision and splitting them across two files is how the API and the model came
    //    to hold two disagreeing copies of the interview's state.
    //
    //    THE ORCHESTRATOR OWNS THE BUFFER WRITE. It saves under a compare-and-swap on the
    //    envelope's `rev`, which is the fix for the lost update this method used to have:
    //    load → mutate → save with two concurrent submits silently discarded one worker's
    //    answer. Nothing below writes the buffer.
    const turn = await this.orchestrator.takeTurn({
      sessionId: dto.session_id,
      workerId,
      text: dto.text,
      now,
      submissionId,
      voiceNoteId,
      ctx,
    });

    // 3. Nothing was written and the worker should retry — a lost CAS after two attempts,
    //    or no resolvable question pack. Same shape as the old AI-unreachable branch, and
    //    for the same reason: no half-turn, no duplicated line, no topic lost.
    if (turn.unavailable) {
      this.logger.warn(
        `chat turn dropped session=${dto.session_id}: orchestrator wrote nothing; ` +
          `the worker can retry into the same session`,
      );
      return { kind: "unavailable", reply: turn.reply };
    }

    // 4. Layer A of the double-submit defence fired: this exact message at this exact rev
    //    inside the replay window. The previous reply is returned byte-identically and NO
    //    state changed — which is what a mobile client on a flaky 2G connection needs, as
    //    opposed to a 409 telling it something went wrong when nothing did.
    if (turn.replayed) {
      return { kind: "replay", turn };
    }

    // 5. Re-read the buffer the orchestrator just wrote.
    //
    //    RE-READ RATHER THAN RECONSTRUCTED. `takeTurn` may have retried the whole decision
    //    against a competing writer's state, so the object this method loaded at step 1 is
    //    not necessarily the one that landed. Rebuilding a view of it here from `turn`
    //    would be a second, quietly divergent copy of the interview — the exact class of
    //    bug the CAS exists to remove.
    const written = await this.buffer.load(dto.session_id);
    if (written === null) {
      // The key vanished between the CAS write and this read: a TTL lapse at the worst
      // possible instant, or an eviction. The turn DID happen and is durable in Redis's
      // eyes only, so the reply is still served; the interview restarts on the next POST.
      this.logger.error(
        `buffer for session ${dto.session_id} disappeared immediately after a successful ` +
          `CAS write; serving the reply and letting the next turn restart the interview`,
      );
      return { kind: "degraded", reply: turn.reply };
    }
    const buffered = written;

    // 6. Flush, if the engine closed the interview.
    //
    //    TERMINAL ONLY IF IT ACTUALLY LANDED. `turn.complete` says the interview should
    //    end; `flushed` says the transcript is durable. They differ exactly when the flush
    //    transaction rolled back, and conflating them loses the whole interview.
    const flushed = turn.complete
      ? await this.finalizeInterview(workerId, dto.session_id, buffered, ctx)
      : false;
    const terminal = turn.complete && flushed;

    // 6b. The mid-interview checkpoint (OIE Phase 9, risk #10).
    //
    //     ONLY WHEN THE INTERVIEW IS STILL RUNNING. A completed one just wrote the same state
    //     through `endSession` inside the flush transaction; checkpointing here as well would be
    //     a second UPDATE of the same column with the same value, outside that transaction.
    //
    //     BEST EFFORT, AND THAT IS THE WHOLE DESIGN. This write exists to make a Redis TTL lapse
    //     survivable — it is a backup, not the record. The record is the buffer, which is already
    //     durable in Redis's eyes by the time we get here. So a checkpoint failure must never
    //     reach the worker: they answered a question, and the honest response to that is the next
    //     question, not an error because a redundant copy did not land.
    //
    //     STATE ONLY, NEVER MESSAGE TEXT. `toConversationStatePatch` is the same projection
    //     `finalizeInterview` writes — phase, occupation, answer map, counters. The transcript
    //     stays in Redis until the flush, which is what keeps this ~2 UPDATEs per interview
    //     instead of the ~150 rows the buffer design deleted.
    if (turn.checkpointDue && !terminal && buffered.profiling) {
      try {
        await this.chat.saveConversationState(
          dto.session_id,
          toConversationStatePatch(buffered.profiling),
          now,
        );
      } catch (err) {
        this.logger.warn(
          `mid-interview checkpoint failed session=${dto.session_id} ` +
            `asks=${buffered.profiling.engineAsks}; the interview continues on the Redis buffer ` +
            `and the next checkpoint will retry (${err instanceof Error ? err.message : "unknown"})`,
        );
      }
    }

    this.logger.log(
      `turn taken session=${dto.session_id} turn=${buffered.turnCount} ` +
        `question=${turn.questionKey ?? "-"} progress=${turn.progress.answered}/${turn.progress.total} ` +
        `complete=${turn.complete} flushed=${flushed}`,
    );

    return { kind: "turn", turn, buffered, terminal };
  }

  /**
   * A completed turn, as `POST /chat/message` renders it.
   *
   * SPLIT FROM {@link runTurn} RATHER THAN INLINED, because this is the ONE part a second
   * surface must be free to do differently: `suggested_followups` carries chip LABELS, which is
   * right for "pick a chip or type instead" and useless to a client that has to submit the
   * `option_key` the worker tapped.
   */
  private async projectTurn(
    sessionId: string,
    workerId: string,
    outcome: Extract<ChatTurnOutcome, { kind: "turn" }>,
  ): Promise<PostMessageResponse> {
    const { turn, buffered, terminal } = outcome;
    const dto = { session_id: sessionId };
    // 7. Personalize ONLY the client-returned reply — post-buffer, post-flush, post-emit —
    //    by interpolating the worker's real first name over the `{{worker_name}}` token.
    //    Everything durable still holds the placeholder.
    //
    //    KEPT EVEN THOUGH PACK COPY CONTAINS NO VOCATIVE TODAY. The token is a reviewed
    //    affordance of the pack corpus, the validator permits it, and removing the
    //    interpolation would turn the first pack that uses it into a literal
    //    `{{worker_name}}` on a worker's screen.
    const workerFullName = await this.workerFullName(workerId);
    const occupation = buffered.profiling?.occupation ?? null;
    const response: PostMessageResponse = {
      session_id: dto.session_id,
      reply: this.renderPackText(turn.reply, workerFullName),
      // #896 — the SAME sentence in Devanagari, so read-aloud pronounces it. Resolved from
      // `turn.reply` PRE-interpolation (the sidecar is keyed by the engine string, and a lookup
      // on the rendered text would key on the worker's real name), then rendered through the
      // identical `renderPackText` so both strings carry the name the same way.
      ...this.ttsField(turn.reply, workerFullName),
      blocked: false,
      // PERMANENTLY FALSE, and deliberately not repurposed. The field meant "this reply
      // came from a mock LLM instead of a real one"; there is no LLM in this path at all,
      // so the honest answer is that no mock happened either.
      is_mock: false,
      // THE CHIPS. Same field, same client rendering — but the options are now the pack's
      // REVIEWED closed set (or a disambiguation offer), not a model's improvisation. That
      // is what makes "options are ANSWERS, never questions" mechanically checkable.
      suggested_followups: turn.options.map((option) => option.label_text),
      // The same chips with their key and their escape flag — see the DTO. Labels stay the
      // rendering contract; this is what lets the client stop matching on copy.
      suggested_options: turn.options.map(toWireOption),
      // Now a pack `question_key`. Still passes the `^[a-z_]+$` ≤40-char filter the flush
      // transaction applies, because the pack validator enforces exactly that shape.
      asked_question_id: turn.questionKey,
      extraction_ready: terminal,
      // Required-but-unanswered pack questions. Question keys only, never PII — and unlike the
      // LLM path, empty here genuinely means "nothing essential is outstanding" rather than
      // "the model did not say".
      unanswered_essentials: [...turn.unansweredEssentials],
      session_ended: terminal,
      // THE ENGINE'S OWN VERDICT (#695). This used to be `turn.complete ? "close" : "ask"`, which
      // could never produce `disambiguate` — so a real offer arrived at the worker app as an
      // ordinary ask and rendered in the horizontal chip scroller, which is precisely the failure
      // #649 was raised to fix. The orchestrator knew at the offer branch and the fact was thrown
      // away one layer down.
      question_kind: turn.kind,
      // TYPING ON OR OFF. Absent on every turn but two, and absent means `text` — the same
      // asymmetry `lookahead` uses, and for the same reason: forgetting it produces today's
      // behaviour rather than a wrong screen.
      input_mode: turn.inputMode ?? "text",
      answer_type: turn.answerType,
      // The completion bar. The single biggest lever on completion rate for low-literacy
      // users, and impossible to compute under the LLM path — the model never knew how
      // many questions were left because it invented each one as it went.
      progress: turn.progress,
      // The "you have been understood" moment: the worker's trade, in their language,
      // echoed back once retrieval pins it.
      occupation_label: occupation?.label ?? null,
      // THE PREDICTION, INTERPOLATED THE SAME WAY THE REPLY IS.
      //
      // `{{worker_name}}` is a reviewed affordance of the pack corpus, and the interpolation above
      // covers `turn.reply` and nothing else — so a predicted question containing the token would
      // reach a worker's screen as the literal characters `{{worker_name}}`, on a path where it
      // is rendered without a round trip and therefore without anything else to catch it. Sharing
      // one helper is what keeps the predicted question and the real one spelled identically.
      lookahead: turn.lookahead
        ? Object.fromEntries(
            Object.entries(turn.lookahead).map(([answerKey, entry]) => [
              answerKey,
              {
                question_key: entry.questionKey,
                question_kind: entry.kind,
                prompt_text: this.renderPackText(entry.promptText, workerFullName),
                ...this.ttsField(entry.promptText, workerFullName),
                why_text:
                  entry.whyText === null
                    ? null
                    : this.renderPackText(entry.whyText, workerFullName),
                answer_type: entry.answerType,
                options: entry.options.map(toWireOption),
                progress: entry.progress,
                // #766 item 4 — the turn this prediction is FOR, so a client can drop a stale
                // one rather than trusting it until the real response contradicts it.
                turn: entry.turn,
              },
            ]),
          )
        : null,
    };
    return this.checkedResponse(response, dto.session_id);
  }

  /**
   * THE ONLY WRITE. Flush the buffered interview to Postgres in ONE transaction:
   * every message, the final state, and every event land together or not at all.
   *
   * IDEMPOTENCY, in two layers with different jobs.
   *   1. `endSession` is a CONDITIONAL update (`... AND status = 'active'`) and reports
   *      whether it won. That is the real guard, and it must be conditional rather than
   *      a prior read: two concurrent finalizations both pass a read, but only one wins
   *      the write, and the loser aborts before inserting anything. `chat_messages` has
   *      no unique key, so nothing else could stop a duplicated transcript.
   *   2. Every event carries a stable `idempotency_key`, which the `events` table
   *      enforces at insert (TD18). That covers the narrower case of the transaction
   *      committing and a retry arriving anyway.
   *
   * ORDER: the Redis key is dropped only AFTER the transaction commits, and never in a
   * `finally`. Postgres is what makes the transcript durable; dropping the key on a
   * failed flush would destroy the only copy of the interview.
   */
  private async finalizeInterview(
    workerId: string,
    sessionId: string,
    buffer: TranscriptBuffer,
    ctx: RequestContext,
  ): Promise<boolean> {
    const at = new Date();
    // The state snapshot that lands in `chat_sessions.conversation_state`. Built
    // field-by-field from the buffer rather than spread, so nothing Redis-shaped
    // (`messages`, `workerId`) can ride into the JSONB column.
    const finalState: Record<string, unknown> = {
      role_family: buffer.roleFamily || DEFAULT_ROLE_FAMILY,
      turn_count: buffer.turnCount,
      captured: buffer.captured,
      completion_reason: buffer.completionReason ?? null,
      // The RFS field ids the worker actually answered.
      //
      // FILTERED, not trusted. The event payload enforces `^[a-z_]+$`, max 40 chars and
      // max 50 entries — and that emit happens INSIDE this transaction, so one bad id
      // would throw, roll back the flush, and discard the worker's whole completed
      // interview while they saw a normal closing reply. The vocabulary is now DATA
      // (PROFILING_REQUIRED_FIELDS on the ai-service), so "lowercase slug by
      // construction" is a property of today's config, not of the mechanism. The
      // ai-service validates the same shape at startup; this is the second wall, so a
      // version-skewed deployment costs an observability field instead of an interview.
      answered_topics: this.slugFieldIds(Object.keys(buffer.captured).sort(), sessionId),
      extraction_ready_emitted: true,
      // THE ANSWER MAP AND THE PINNED OCCUPATION, projected into the frozen contract shape.
      //
      // THIS IS WHAT MAKES THE PARSE CALL POSSIBLE AT ALL. The extraction job runs minutes
      // later, off the request path, and the Redis buffer is dropped the moment this
      // transaction commits — so `chat_sessions.conversation_state` is the ONLY place the
      // processor can read the interview's record from. Without this line the parse call
      // would fall back to re-reading the transcript under a different vocabulary, which is
      // precisely the live defect the plan set out to fix (`captured` never reaching
      // extraction).
      //
      // SPREAD LAST so it cannot be silently overwritten by a field above, and taken from
      // the ENVELOPE rather than rebuilt here — one projection, owned by the module that
      // owns the envelope.
      ...(buffer.profiling ? toConversationStatePatch(buffer.profiling) : {}),
    };

    let won = false;
    try {
      won = await this.chat.withTransaction(async (tx) => {
        if (!(await this.chat.endSession(tx, sessionId, finalState, at))) {
          this.logger.log(`flush skipped session=${sessionId}: already finalized`);
          return false;
        }

        const rows = await this.chat.insertMessages(
          tx,
          buffer.messages.map((m) => this.toMessageRow(sessionId, workerId, m)),
        );

        // THE ANSWER MAP, AS ROWS — ONE multi-row INSERT, inside this transaction.
        //
        // One statement and not twelve, deliberately. A twelve-question interview issuing
        // twelve INSERTs inside an open transaction holds row locks across twelve network
        // round trips at the exact moment the worker is waiting on their closing reply; the
        // whole reason this method exists is that the per-turn design cost ~150 writes.
        //
        // INSIDE the transaction, so a rolled-back flush leaves no orphan answers pointing at
        // a session whose transcript was never written. The buffer survives and the retry
        // re-inserts the same rows — idempotent, because `wpa_worker_question_uq` turns the
        // second attempt into an upsert rather than a duplicate.
        const answers = this.toPackAnswerRows(workerId, sessionId, buffer);
        if (answers.length > 0) {
          await this.chat.insertPackAnswers(tx, answers);
        }

        // One event per stored message, exactly as the per-turn flow emitted them —
        // same names, same payloads, same key shape. Only the TIMING moved: the audit
        // spine records the whole conversation at once instead of a row at a time.
        for (const row of rows) {
          const inbound = row.direction === "inbound";
          await this.events.emit({
            event_name: inbound ? "chat.message_received" : "chat.message_sent",
            actor: inbound
              ? { actor_type: "worker", actor_id: workerId }
              : { actor_type: "ai_service" },
            subject: { subject_type: "chat_message", subject_id: row.id },
            payload: {
              session_id: sessionId,
              worker_id: workerId,
              message_id: row.id,
              // READ OFF THE STORED ROW, never re-asserted here (#1244). Both of these were
              // hardcoded — `"text"` and `false` — so a spoken turn emitted an audit event
              // actively DENYING it was spoken. Deriving them from `row` makes the event and
              // the row it describes structurally incapable of disagreeing.
              message_type: row.messageType,
              ...(inbound ? { has_voice_note: row.voiceNoteId !== null } : {}),
            },
            idempotencyKey: `${inbound ? "chat.message_received" : "chat.message_sent"}:${row.id}`,
            correlationId: ctx.correlationId,
            requestId: ctx.requestId,
            tx,
          });
        }

        await this.events.emit({
          event_name: "profile.extraction_ready",
          actor: { actor_type: "worker", actor_id: workerId },
          subject: { subject_type: "chat_session", subject_id: sessionId },
          payload: {
            worker_id: workerId,
            session_id: sessionId,
            role_family: buffer.roleFamily || DEFAULT_ROLE_FAMILY,
            turn_count: buffer.turnCount,
            answered_topics: finalState.answered_topics as string[],
          },
          idempotencyKey: `profile.extraction_ready:${sessionId}`,
          correlationId: ctx.correlationId,
          requestId: ctx.requestId,
          tx,
        });

        // THE INTERVIEW'S OWN RECORD (OIE Phase 9). Distinct from `extraction_ready` above,
        // which is a downstream trigger — one says "there is work to do", this says "here is
        // how the engine performed". Three of the plan's acceptance criteria (p95 turn latency,
        // completion rate, ask-count distribution) have no other source: `worker_profiles`
        // records where a worker ended up and overwrites the evidence of how they got there.
        //
        // ONE EVENT PER INTERVIEW, NOT PER TURN — the latency arrives as a histogram
        // accumulated in the envelope. Per-turn events would be the plan's own risk #9: ~12M
        // rows whose only reader is a dashboard.
        //
        // INSIDE THE TRANSACTION, so an interview that did not durably happen does not report
        // that it did. A rolled-back flush leaves no telemetry claiming a completion.
        if (buffer.profiling) {
          const env = buffer.profiling;
          const byStatus = countAnswerStatuses(env.answerMap);
          await this.events.emit({
            event_name: "profile.interview_completed",
            actor: { actor_type: "worker", actor_id: workerId },
            subject: { subject_type: "chat_session", subject_id: sessionId },
            payload: {
              worker_id: workerId,
              session_id: sessionId,
              turn_count: buffer.turnCount,
              ask_count: env.engineAsks,
              // Filtered to the payload's own slug rule rather than trusted. The emit is inside
              // this transaction, so a reason that failed validation would roll back a completed
              // interview to protect an observability field — the same asymmetry `slugFieldIds`
              // exists for two methods above.
              completion_reason: /^[a-z_]{1,40}$/.test(buffer.completionReason ?? "")
                ? (buffer.completionReason as string)
                : null,
              occupation_pinned: env.occupation !== null,
              match_layer: env.occupation?.match_layer ?? null,
              pack_id: env.packId,
              pack_version: env.packVersion,
              answered_count: byStatus.answered,
              declined_count: byStatus.declined,
              unanswered_count: byStatus.unanswered,
              turn_latency_ms: { ...env.turnLatency },
            },
            idempotencyKey: `profile.interview_completed:${sessionId}`,
            correlationId: ctx.correlationId,
            requestId: ctx.requestId,
            tx,
          });
        }
        return true;
      });
    } catch (err) {
      // The transaction rolled back, so nothing was written AND the buffer is still in
      // Redis with `completedAt` set. Do NOT rethrow: the worker's final message was
      // answered and the reply is already built, so 500-ing here would tell them their
      // completed interview failed when the only thing that failed is a write we can
      // retry. Loud in the log, invisible to them.
      //
      // Returning FALSE is what makes that retry reachable. The caller uses it to keep
      // `session_ended` false, so the client does NOT drop its session id — and
      // `postMessage` re-attempts the flush from the intact buffer on the next POST
      // (see the completed-but-unflushed short-circuit at step 1b). Reporting success
      // here instead would end the session client-side, strand `chat_sessions` at
      // `status='active'` forever, and let the whole interview expire with the buffer:
      // zero messages, zero events, no profile.
      this.logger.error(
        `transcript flush FAILED session=${sessionId}; the buffer is intact and the ` +
          `flush will be retried: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }

    if (!won) {
      // Another request finalized this session. The transcript is durable, so the key
      // is ours to clear — and durable is durable no matter who wrote it, so this counts
      // as flushed for the caller.
      await this.buffer.drop(sessionId);
      return true;
    }

    this.logger.log(
      `transcript flushed session=${sessionId} messages=${buffer.messages.length} ` +
        `turns=${buffer.turnCount} reason=${buffer.completionReason ?? "-"}`,
    );
    await this.buffer.drop(sessionId);
    await this.autoTriggerExtraction(workerId, sessionId, ctx);
    return true;
  }

  /**
   * Close ONE idle session as `abandoned`, preserving whatever is still recoverable.
   *
   * WHAT THIS IS FOR. An interview the worker walks away from is never flushed, so its
   * transcript lives only in the Redis buffer and dies with the idle TTL. The periodic
   * `conversation_state` checkpoint survives, but nothing ever acts on it: the session
   * stays `active` forever and the worker's words are simply lost. This is the missing
   * trigger — it runs off the request path, on the sweep's clock.
   *
   * ══ IT PRESERVES. IT DOES NOT EXTRACT. ══
   *
   * No `profile.extraction_ready`, no `autoTriggerExtraction`, and
   * `extraction_ready_emitted` stays FALSE in the persisted state. A profile is minted by a
   * FINISHED interview and by nothing else. A worker who answered four of thirteen
   * questions has told us too little to rank on, and CLAUDE.md §2 ("never show irrelevant
   * candidates", "matching quality over quantity") makes a thin profile worse than no
   * profile — it does not sit idle, it competes for a slot in front of an employer. So the
   * answers are banked where the worker can resume onto them, and the ranking surface
   * never sees them.
   *
   * This is also why the flag matters rather than being cosmetic: the extraction processor
   * reads `conversation_state`, and a `true` here would let a later, unrelated trigger
   * treat a four-answer stub as a completed interview.
   *
   * TWO RECOVERY GRADES, and the caller is told which happened.
   *   1. BUFFER ALIVE (the sweep beat the TTL — the design target). The full verbatim
   *      transcript and the pack answers are written exactly as a real flush writes them.
   *   2. BUFFER GONE (the sweep did not). Nothing is left to write; the session is closed
   *      on the `conversation_state` checkpoint it already had, which is preserved rather
   *      than overwritten. Reporting this as an ordinary success would hide real data loss,
   *      so it rides on the event as `transcript_recovered: false`.
   *
   * The whole write is ONE transaction, and `abandonSession` is conditional on the session
   * still being `active` — so a worker who returns mid-sweep and finishes their interview
   * wins, and this aborts having written nothing.
   */
  async abandonInterview(
    session: { id: string; workerId: string; conversationState: Record<string, unknown> | null },
    idleMinutes: number,
    ctx: RequestContext,
  ): Promise<{ closed: boolean; transcriptRecovered: boolean; messages: number; answers: number }> {
    const at = new Date();
    const sessionId = session.id;
    const workerId = session.workerId;

    const loaded = await this.buffer.load(sessionId);
    // The tripwire from TranscriptBuffer.workerId: a buffer disagreeing with the session row
    // means key reuse, and it must never be attributed to this worker.
    const buffer = loaded && loaded.workerId === workerId ? loaded : null;

    const state: Record<string, unknown> = buffer
      ? {
          role_family: buffer.roleFamily || DEFAULT_ROLE_FAMILY,
          turn_count: buffer.turnCount,
          captured: buffer.captured,
          completion_reason: "abandoned",
          answered_topics: this.slugFieldIds(Object.keys(buffer.captured).sort(), sessionId),
          // ⚠ FALSE, and load-bearing — see the header. No extraction ran, and none will.
          extraction_ready_emitted: false,
          ...(buffer.profiling ? toConversationStatePatch(buffer.profiling) : {}),
        }
      : // Buffer gone: keep the checkpoint verbatim and only stamp WHY it closed. Rebuilding
        // it here would overwrite a real answer map with an empty one.
        { ...(session.conversationState ?? {}), completion_reason: "abandoned" };

    const messageRows = buffer
      ? buffer.messages.map((m) => this.toMessageRow(sessionId, workerId, m))
      : [];
    const answerRows = buffer ? this.toPackAnswerRows(workerId, sessionId, buffer) : [];

    const closed = await this.chat.withTransaction(async (tx) => {
      if (!(await this.chat.abandonSession(tx, sessionId, state, at))) {
        // The worker came back and finished (or another sweep tick won). Either way this
        // session is no longer ours to close, and nothing has been written.
        this.logger.log(`abandon skipped session=${sessionId}: no longer active`);
        return false;
      }

      const rows = await this.chat.insertMessages(tx, messageRows);
      if (answerRows.length > 0) await this.chat.insertPackAnswers(tx, answerRows);

      // The audit spine records the messages that now exist, exactly as the completion
      // flush records them — same names, same payloads, same key shape. These rows are real
      // `chat_messages` rows; the only thing that differs about this path is that no
      // PROFILE is minted from them.
      for (const row of rows) {
        const inbound = row.direction === "inbound";
        await this.events.emit({
          event_name: inbound ? "chat.message_received" : "chat.message_sent",
          actor: inbound
            ? { actor_type: "worker", actor_id: workerId }
            : { actor_type: "ai_service" },
          subject: { subject_type: "chat_message", subject_id: row.id },
          payload: {
            session_id: sessionId,
            worker_id: workerId,
            message_id: row.id,
            // Same derivation as the completion flush above — the abandonment sweep writes
            // real `chat_messages` rows, so its events must describe them just as honestly.
            message_type: row.messageType,
            ...(inbound ? { has_voice_note: row.voiceNoteId !== null } : {}),
          },
          idempotencyKey: `${inbound ? "chat.message_received" : "chat.message_sent"}:${row.id}`,
          correlationId: ctx.correlationId,
          requestId: ctx.requestId,
          tx,
        });
      }

      await this.events.emit({
        event_name: "chat.session_abandoned",
        // The SWEEP closed this, not the worker. Attributing it to them would put an action
        // they did not take in their own audit trail.
        actor: { actor_type: "system" },
        subject: { subject_type: "chat_session", subject_id: sessionId },
        payload: {
          session_id: sessionId,
          worker_id: workerId,
          transcript_recovered: buffer !== null,
          messages_preserved: rows.length,
          answers_preserved: answerRows.length,
          idle_minutes: idleMinutes,
        },
        idempotencyKey: `chat.session_abandoned:${sessionId}`,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
        tx,
      });

      return true;
    });

    // ONLY AFTER THE COMMIT, and never in a `finally` — same rule as the completion flush.
    // Postgres is what makes the transcript durable, so dropping the key on a failed or
    // lost-race close would destroy the one copy the next tick could still have saved.
    if (closed && buffer) await this.buffer.drop(sessionId);

    if (closed) {
      this.logger.log(
        `session abandoned session=${sessionId} idle=${idleMinutes}m ` +
          `messages=${messageRows.length} answers=${answerRows.length} ` +
          `transcript=${buffer ? "recovered" : "LOST (buffer expired before the sweep)"}`,
      );
    }
    return {
      closed,
      transcriptRecovered: buffer !== null,
      messages: closed ? messageRows.length : 0,
      answers: closed ? answerRows.length : 0,
    };
  }

  /**
   * RFS field ids narrowed to what `ProfileExtractionReadyPayload` will actually
   * accept: lowercase slugs, at most 40 characters, at most 50 of them.
   *
   * Dropping a field id costs one entry in an observability array. NOT dropping it, if
   * the ai-service's configured vocabulary ever disagrees with the payload's regex,
   * costs the worker their entire completed interview — the emit is inside the flush
   * transaction. The asymmetry is the whole argument for filtering here.
   */
  private slugFieldIds(ids: string[], sessionId: string): string[] {
    const kept = ids.filter((id) => /^[a-z_]{1,40}$/.test(id)).slice(0, 50);
    if (kept.length !== ids.length) {
      // Count only, never the ids themselves — a rejected id is by definition not from
      // the vocabulary we vouch for, so it is not known to be PII-free.
      this.logger.warn(
        `dropped ${ids.length - kept.length} field id(s) from answered_topics for ` +
          `session ${sessionId}: not [a-z_]{1,40}, or over the 50-entry payload cap`,
      );
    }
    return kept;
  }

  /**
   * The answer map as `worker_pack_answer` rows.
   *
   * ONE ROW PER SETTLED QUESTION. `unanswered` records are skipped: they mean "we asked and
   * moved on", which is a fact about the CONVERSATION and lives in the transcript, not a fact
   * about the worker. Persisting them would fill the table with empty rows that a re-interview
   * would then have to distinguish from real declinations.
   *
   * THE VALUE COLUMN IS CHOSEN BY THE VALUE'S OWN TYPE, not by the question's declared
   * `answer_type`. The pack says what it expected; the answer map holds what the worker actually
   * gave, normalized at capture time. Trusting the declaration would write "5" into
   * `answer_number` for a question whose normalizer legitimately produced a range string, and
   * the CHECK constraint would then roll back the entire flush.
   */
  private toPackAnswerRows(
    workerId: string,
    sessionId: string,
    buffer: TranscriptBuffer,
  ): NewWorkerPackAnswer[] {
    const envelope = buffer.profiling;
    if (!envelope) return [];
    // A pack pointer is REQUIRED, not defaulted. `pack_id` is how a later reader knows which
    // question `experience_years` was — two packs may legitimately own that key with different
    // wording — so a row without one is unreadable rather than merely incomplete.
    if (envelope.packId === null || envelope.packVersion === null) return [];

    const rows: NewWorkerPackAnswer[] = [];
    for (const record of envelope.answerMap) {
      const row = packAnswerRowFor({
        workerId,
        sessionId,
        packId: envelope.packId,
        packVersion: envelope.packVersion,
        record,
        // `chip` vs `chat` is not knowable from the answer map — the record keeps the value, not
        // the affordance that produced it. `chat` is the honest default; a chip tap is still a
        // message on this route.
        source: "chat",
      });
      if (row) rows.push(row);
    }
    return rows;
  }

  /** A buffered line as the `chat_messages` row it becomes at flush. */
  private toMessageRow(sessionId: string, workerId: string, m: BufferedMessage) {
    return {
      sessionId,
      workerId,
      direction: m.role === "worker" ? ("inbound" as const) : ("outbound" as const),
      // PROVENANCE, from the line itself (#1244). This used to be a hardcoded `"text"`, which
      // did not merely omit the fact that an answer was spoken — it asserted the opposite, on
      // the row that IS the audit spine. `voice_note_id` and the `"voice"` message type both
      // already existed in the schema and were dead; this is what writes them.
      messageType: m.voiceNoteId === null ? ("text" as const) : ("voice" as const),
      // The FK is SET NULL, so a clip erased by a DSAR leaves the line and drops the pointer —
      // the words a worker said survive their audio being destroyed, which is the correct
      // asymmetry for an audit trail.
      voiceNoteId: m.voiceNoteId,
      // Verbatim. An assistant line still carries the literal `{{worker_name}}`
      // placeholder here — the real name is interpolated ONLY into the live reply.
      bodyText: m.text,
      // `created_at` is EXPLICIT: these rows are written at flush but happened over the
      // preceding minutes, and defaulting would stamp a thirty-turn interview as thirty
      // simultaneous messages, destroying the order `listMessages` and the extraction
      // transcript both read.
      createdAt: new Date(m.at),
    };
  }

  /** A turn that did not happen: nothing buffered, nothing written, safe to retry. */
  private degradedResponse(
    sessionId: string,
    reply: string,
    opts: { blocked?: boolean } = {},
  ): PostMessageResponse {
    return this.checkedResponse(
      {
        session_id: sessionId,
        reply: reply.replace(/\{\{[^}]*\}\}/g, ""),
        // #896 — a degraded/terminal turn serves a CONSTANT ("Abhi thodi dikkat aa rahi hai…"),
        // which is exactly the kind of line a worker is most likely to have read aloud, since
        // nothing else on screen explains what went wrong. Placeholders are stripped the same
        // way on both strings.
        ...this.ttsField(reply, null),
        blocked: opts.blocked ?? false,
        is_mock: true,
        // No turn happened, so there are no chips — the same reason `progress` is null below.
        suggested_followups: [],
        suggested_options: [],
        asked_question_id: null,
        extraction_ready: false,
        // EMPTY MEANS "UNKNOWN" HERE, not "complete" — no turn happened, so there is no
        // progress to report. Clients must gate on `blocked` / `is_mock` before reading
        // it, exactly as the DTO documents.
        unanswered_essentials: [],
        // The session is still very much alive; the worker should retry into it.
        session_ended: false,
        question_kind: "ask",
        // No turn happened, so nothing constrains the answer: the worker retries by typing.
        input_mode: "text",
        // No question is on screen here, so there is no answer shape to describe.
        answer_type: null,
        // NULL, not {0,0}. No turn happened, so there is no progress to report — and a
        // zeroed bar would render as "you have answered nothing" to a worker who has
        // answered eleven questions.
        progress: null,
        occupation_label: null,
        // No prediction on a turn that served no pack question.
        lookahead: null,
      },
      sessionId,
    );
  }

  /**
   * A message posted after the interview was finalized. Terminal, idempotent, free.
   *
   * Also the RECOVERY path: a client that missed the `session_ended` flag on the
   * completing turn (an old build, a dropped response, a fresh process reusing a
   * persisted id) is told again here, on every subsequent message, rather than being
   * left to post into a dead session forever.
   */
  private terminalResponse(sessionId: string): PostMessageResponse {
    return this.checkedResponse(
      {
        session_id: sessionId,
        reply: CHAT_ALREADY_COMPLETE_REPLY,
        ...this.ttsField(CHAT_ALREADY_COMPLETE_REPLY, null),
        blocked: false,
        is_mock: true,
        // A dead session serves no question, so it offers nothing to tap.
        suggested_followups: [],
        suggested_options: [],
        asked_question_id: null,
        extraction_ready: true,
        unanswered_essentials: [],
        session_ended: true,
        question_kind: "close",
        // A dead session serves no question, so it constrains no answer either.
        input_mode: "text",
        // No question is on screen here, so there is no answer shape to describe.
        answer_type: null,
        progress: null,
        occupation_label: null,
        // No prediction on a turn that served no pack question.
        lookahead: null,
      },
      sessionId,
    );
  }

  /**
   * Outbound boundary check (belt-and-braces): every response above is constructed
   * field-by-field, so unknown fields cannot leak in; `safeParse` guards the VALUES. On
   * failure, log field PATHS only — never values (the reply carries the worker's real
   * name post-render; §2 no-PII-in-logs) — and return the constructed object. Outbound
   * validation must NEVER 500 a chat turn.
   */
  private checkedResponse(response: PostMessageResponse, sessionId: string): PostMessageResponse {
    const checked = PostMessageResponseSchema.safeParse(response);
    if (!checked.success) {
      this.logger.warn(
        `postMessage outbound validation failed session=${sessionId} ` +
          `paths=[${checked.error.issues.map((i) => i.path.join(".")).join(",")}]`,
      );
      return response;
    }
    return checked.data;
  }

  /**
   * #349 — transcript hydration. Returns this session's stored messages so the
   * app can redraw a thread it could not keep in memory (ChatBloc is a locator
   * FACTORY, so a >5-minute background re-lock drops the visible transcript
   * while every message is still safely in `chat_messages`).
   *
   * OWNERSHIP: the session id arrives in the URL and is therefore
   * ATTACKER-CONTROLLED. `SessionMessagesParamSchema` only proves it is a UUID —
   * parsing is not permission. A worker may read ONLY their own session, and a
   * miss returns **404, never 403**, for both "no such session" and "not yours":
   * a 403 would confirm the id exists and turn this route into an existence
   * oracle for another worker's session (the same IDOR class as #435). Identical
   * to the gate in `postMessage`.
   *
   * READ-ONLY → NO EVENT, deliberately. CLAUDE.md §1 binds important STATE
   * CHANGES; nothing changes here, and minting an event per screen re-entry
   * would spam the audit spine without recording a decision. The omission is a
   * choice, not an oversight.
   *
   * PII: `body_text` is the stored row verbatim, which for an outbound message
   * still holds the literal `{{worker_name}}` placeholder — the real name is
   * interpolated ONLY in `postMessage`'s live return (renderWorkerName, SG-1).
   * Hydration therefore returns the placeholder rather than the name. That is
   * the safe direction: the alternative is decrypting the worker's name into a
   * bulk read. Tracked as a known cosmetic gap, not a leak.
   *
   * REDIS FIRST, POSTGRES FALLBACK — and this route is now the ONLY way to redraw a
   * live interview. Mid-chat there are no `chat_messages` rows at all: the transcript
   * lives in the buffer until the flush, so a Postgres-only read would hand a worker
   * an empty thread — the exact bug #349 exists to fix, reintroduced by the buffer.
   * After the flush the buffer is gone and Postgres is authoritative. The two are never
   * both populated for the same session, so there is nothing to merge and no ordering
   * to reconcile: the buffer's presence IS the "interview still in flight" signal.
   *
   * FAIL-CLOSED INHERITED: a Redis outage throws 503 from `buffer.load` rather than
   * falling through to Postgres. Falling through would look like success and show the
   * worker an empty transcript for an interview that is very much still alive.
   */
  /**
   * The worker's LATEST chat session id, or null if they have none. Backs the
   * Flutter "Bada Bhai" tab resuming the signup profiling thread: `chat_session`
   * id is in-memory only client-side, so after a cold restart the app cannot find
   * the prior session and would start a fresh empty one — orphaning the answers.
   * This lets the client re-attach to its most recent session (then read its
   * transcript via {@link listMessages}) so the Q&A is always there.
   *
   * Worker id comes from the bearer (never a param) → no cross-worker leak.
   * READ-ONLY → no event, same rationale as {@link listMessages}.
   */
  async latestSession(workerId: string): Promise<{ session_id: string | null }> {
    const session = await this.chat.findLatestSessionByWorker(workerId);
    return { session_id: session?.id ?? null };
  }

  async listMessages(workerId: string, sessionId: string): Promise<SessionMessagesResponse> {
    const session = await this.chat.findSession(sessionId);
    if (!session || session.workerId !== workerId) {
      throw new NotFoundException(`Session ${sessionId} not found`);
    }

    const buffered = await this.buffer.load(sessionId);
    if (buffered && buffered.workerId === workerId && buffered.messages.length > 0) {
      // Oldest-first already: the buffer is append-only. Do NOT re-sort.
      return {
        messages: buffered.messages.map((m) => ({
          direction: m.role === "worker" ? ("inbound" as const) : ("outbound" as const),
          body_text: m.text,
          // #896 — ASSISTANT lines only. An inbound line is the worker's own words, in whatever
          // script they typed, and nothing reads those back to them.
          ...(m.role === "worker" ? {} : this.ttsField(m.text, null)),
          created_at: m.at,
        })),
      };
    }

    // Already oldest-first: the repository takes the newest CHAT_HISTORY_MAX and
    // reverses. Do NOT re-sort here.
    const rows = await this.chat.listMessages(sessionId);

    // Mapped FIELD-BY-FIELD, never spread: `chat_messages` also carries id,
    // worker_id, message_type, voice_note_id and a metadata JSONB, none of which
    // the client needs to redraw bubbles. Spreading the row would silently
    // publish any future column to the client.
    return {
      messages: rows.map((row) => ({
        direction: row.direction,
        body_text: row.bodyText,
        // #896 — the durable half of the same rule as the buffer branch above. The stored line
        // looks ITSELF up: `chat_messages` carries no question_key, which is exactly why the
        // sidecar is keyed by reply text rather than by key.
        ...(row.direction === "inbound" ? {} : this.ttsField(row.bodyText ?? "", null)),
        created_at: row.createdAt.toISOString(),
      })),
    };
  }

  /**
   * The worker's DECRYPTED `full_name`, or `null` when there is none / it cannot be
   * decrypted. ONE read per chat turn; both consumers (R32 outbound redaction and
   * the AI-PERSONA-2 vocative) take the same value.
   *
   * The plaintext never leaves this class: it is used to REMOVE text on the way out
   * (`redactKnownName`) and to interpolate the vocative in the client-facing reply
   * only. It is never logged, evented, stored, or sent to the ai-service/LLM.
   *
   * Never throws. A malformed / rotated-key / tampered token degrades to `null` —
   * a key rotation must not break every worker's chat at once — and the warning
   * carries the opaque worker id ONLY, never the token or the decrypted value.
   */
  private async workerFullName(workerId: string): Promise<string | null> {
    const worker = await this.workers.findById(workerId);
    if (!worker?.fullName) return null;
    try {
      // full_name is encrypted at rest (TD21) — decrypt here, never log the value.
      return this.pii.decrypt(worker.fullName);
    } catch {
      this.logger.warn(
        `could not decrypt full_name for worker ${workerId}; ` +
          `reply stays name-less and the outbound turn is not name-redacted`,
      );
      return null;
    }
  }

  /**
   * `{ tts_text }` for a reply, or `{}` when no Devanagari twin is authored (#896).
   *
   * SPREAD RATHER THAN A NULLABLE FIELD, so an unauthored reply produces a body with the key
   * ABSENT — the shape the DTO documents and the one the client treats as "speak the romanized
   * text", which is today's behaviour. `tts_text: undefined` would serialize the same over JSON
   * but reads, in every call site below, as a field somebody forgot to fill.
   *
   * TAKES THE RAW ENGINE STRING. The sidecar is keyed by the reply the engine produced, before
   * `{{worker_name}}` becomes a real name; the twin is then rendered through the SAME
   * {@link renderPackText} as the shown text so the two cannot diverge on the vocative.
   */
  private ttsField(reply: string, fullName: string | null): { tts_text?: string } {
    const field = ttsField(reply);
    return field.tts_text === undefined
      ? {}
      : { tts_text: this.renderPackText(field.tts_text, fullName) };
  }

  /**
   * Pack copy → exactly what a worker may see: the vocative interpolated, and any OTHER
   * `{{token}}` stripped rather than shown.
   *
   * ONE DEFINITION, USED BY EVERY STRING THAT REACHES THE SCREEN. The interpolation and the
   * catch-all strip used to be spelled inline at the single point that needed them; the lookahead
   * added a second and a third (a predicted prompt, a predicted why-text), and those are rendered
   * on the client WITHOUT a round trip, so a spelling that drifted here would surface as literal
   * `{{worker_name}}` characters on a screen with nothing downstream to catch them.
   */
  private renderPackText(text: string, fullName: string | null): string {
    return this.renderWorkerName(text, fullName).replace(/\{\{[^}]*\}\}/g, "");
  }

  /**
   * AI-PERSONA-2 — replace the ai-service's ``{{worker_name}}`` placeholder with
   * the worker's real FIRST name, deterministically and PII-safely. Called ONLY on
   * the value returned to the client (never on the stored message or any event —
   * SG-1). The name is decrypted SERVER-SIDE by `workerFullName` (TD21:
   * `workers.full_name` is encrypted at rest) and is NEVER logged, evented, put in
   * `ai_jobs`, or sent to the ai-service/LLM.
   *
   * Null / not-yet-set / undecryptable name → strip the token AND its trailing
   * " ji, " so the reply degrades to a clean no-vocative line (no stray "{{ }}").
   */
  private renderWorkerName(reply: string, fullName: string | null): string {
    // Fast path: nothing to interpolate (e.g. a mid-interview ack turn).
    if (!reply.includes(WORKER_NAME_PLACEHOLDER)) return reply;

    const firstName = fullName ? (fullName.trim().split(/\s+/)[0] ?? "") : "";

    // Function replacements (not string) so a worker-controlled name containing
    // `$&`, `$'`, `$$`, etc. is inserted literally — String.replaceAll interprets
    // those special patterns only in a STRING replacement, never a function one.
    if (firstName) {
      return reply
        .replaceAll(`${WORKER_NAME_PLACEHOLDER} ji, `, () => `${firstName} ji, `)
        .replaceAll(WORKER_NAME_PLACEHOLDER, () => firstName);
    }
    // No usable name: drop the vocative token and its trailing " ji, " cleanly.
    return reply
      .replaceAll(`${WORKER_NAME_PLACEHOLDER} ji, `, () => "")
      .replaceAll(WORKER_NAME_PLACEHOLDER, () => "");
  }

  /**
   * Auto-trigger profile extraction once the interview first becomes
   * extraction-ready, so no manual `POST /profile/extract` is needed.
   *
   * Duplicate-extraction protection (three layers):
   *  1. Called only from the readiness FLIP, which is itself gated by the
   *     `extraction_ready_emitted` marker → at most once per session across turns.
   *  2. Skips if the worker already has a profile row **that actually extracted
   *     something** (`latestProfile` + `hasExtractedContent`) → repeated signals /
   *     re-onboarding never create a second profile. See T3 below for why the
   *     content check is load-bearing and not merely defensive.
   *  3. `ProfilesService.extract` enqueues a BullMQ job whose processor is
   *     idempotent per `ai_job` (it returns the prior profile_id on redelivery),
   *     so `profile.extraction_completed` is emitted exactly once.
   *
   * T3 — WHY LAYER 2 READS CONTENT AND NOT MERE EXISTENCE (the audit's #2 gap).
   * This used to skip on ANY profile row. Combined with the AI-down path — where
   * `AiService.extractProfile` fabricates `DraftProfileSchema.parse({})` with
   * `blocked: false` and the processor persisted it — one unreachable ai-service
   * during one interview left the worker with an EMPTY profile row that this guard
   * then treated as "already profiled" FOREVER: no later turn, no re-completed
   * interview, and no new session ever produced another extraction. A worker whose
   * only interview happened to land during an outage was permanently unprofiled and
   * permanently unable to become profiled, silently.
   *
   * Reusing `hasExtractedContent` (rather than, say, testing `profileStatus`) is
   * deliberate: it is the identical predicate `ProfilesService.extract` already uses
   * to decide whether a completed ai_job may dedupe, so the two guards can never
   * disagree about the same row — and it correctly keeps a content-poor but REAL
   * extraction (TD94: a plain "CNC operator" the gazetteer cannot canonicalize, whose
   * content lives only in the rich draft) on the SKIP side, which is what stops this
   * from becoming the unbounded re-extraction loop issue #420 was filed about.
   *
   * The retry is BOUNDED, which is why relaxing the guard is safe: this is reachable
   * at most once per chat session (layer 1), and `ProfilesService.extract` applies its
   * own session-scoped dedupe on top — so a placeholder costs one fresh attempt per
   * genuinely new interview, never a loop. Erring this way is also the direction
   * `ProfilesService.extract` already documents as correct: "being wrong in that
   * direction leaves a worker with no profile at all — strictly worse than the double
   * spend this guards".
   *
   * Never throws: a failed trigger must not break the chat reply. Enqueue failures
   * are already recorded by `extract` (ai_job → failed + `profile.extraction_failed`).
   * (Residual same-instant double-fire on one session is bounded by the single
   * sequential author assumption; the hard guarantee is the TD14 dedup constraint.)
   */
  private async autoTriggerExtraction(
    workerId: string,
    sessionId: string,
    ctx: RequestContext,
  ): Promise<void> {
    try {
      const existing = await this.workers.latestProfile(workerId);
      if (existing && hasExtractedContent(existing)) {
        this.logger.log(
          `auto-extract skipped session=${sessionId}: worker already has profile ${existing.id}`,
        );
        return;
      }
      if (existing) {
        // The T3 self-heal actually firing. Logged at the same level and with the same
        // opaque-ids-only discipline as the skip above, so an operator can tell the two
        // apart in a staging outage instead of seeing silence. Mirrors the equivalent
        // line in `ProfilesService.extract` ("extract re-running ... empty profile").
        this.logger.log(
          `auto-extract re-running session=${sessionId}: existing profile ${existing.id} ` +
            `extracted no content (placeholder), not treating it as a profile`,
        );
      }
      const { ai_job_id } = await this.profiles.extract(
        { worker_id: workerId, session_id: sessionId },
        ctx,
      );
      this.logger.log(`auto-extract triggered session=${sessionId} ai_job=${ai_job_id}`);
    } catch (err) {
      this.logger.warn(
        `auto-extract trigger failed session=${sessionId} (non-fatal, chat continues): ${String(err)}`,
      );
    }
  }
}
