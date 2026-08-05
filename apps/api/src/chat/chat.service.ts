import { Inject, Injectable, Logger, NotFoundException, forwardRef } from "@nestjs/common";
import { ConversationStateSchema } from "@badabhai/ai-contracts";
import type { ServerConfig } from "@badabhai/config";
import type { RequestContext } from "../common/request-context";
import { SERVER_CONFIG } from "../config/config.module";
import { EventsService } from "../events/events.service";
import { WorkersRepository } from "../workers/workers.repository";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { redactKnownName } from "../common/redact-known-name";
import { AiService } from "../ai/ai.service";
import { ProfilesService } from "../profiles/profiles.service";
// T3: the SAME "did this extraction extract anything?" predicate ProfilesService
// dedupes on (issue #420). A pure leaf function — no new module edge, no new cycle.
import { hasExtractedContent } from "../profiles/profile-content";
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

// AI-PERSONA-2: the ai-service emits this literal token (never a real name) at the
// vocative slots. The real first name is interpolated over it here in the API,
// POST-emit, only in the value returned to the client — see renderWorkerName.
const WORKER_NAME_PLACEHOLDER = "{{worker_name}}";

/**
 * Served when the AI service is unreachable and no turn happened.
 *
 * DELIBERATELY NOT a copy of the ai-service's own degraded line, and deliberately not a
 * question. This is the same split the codebase already makes between Python's
 * `_BLOCKED_REPLY` and Flutter's `kChatBlockedNotice`: each surface says the thing IT
 * knows. The ai-service's fallback continues an interview it is still conducting; this
 * one is served when there is no interview happening at all, so asking a question here
 * would invite an answer nothing is listening for.
 *
 * On-persona by the same rules the guard enforces on the far side: "aap", no vocative,
 * no exclamation mark, no emoji, two short lines.
 */
const CHAT_UNAVAILABLE_REPLY =
  "Abhi thodi dikkat aa rahi hai. Ek minute baad dobara bhejiye.";

/** Served on a message posted to an interview that has already been finalized. */
const CHAT_ALREADY_COMPLETE_REPLY =
  "Aapki baat poori ho chuki hai. Profile taiyaar ho rahi hai.";

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly chat: ChatRepository,
    private readonly workers: WorkersRepository,
    private readonly pii: PiiCryptoService,
    private readonly events: EventsService,
    private readonly ai: AiService,
    private readonly buffer: ChatTranscriptBuffer,
    // forwardRef: ProfilesModule imports ChatModule (for the transcript), so the
    // dependency is circular. Used to auto-trigger extraction on the readiness flip.
    @Inject(forwardRef(() => ProfilesService)) private readonly profiles: ProfilesService,
  ) {}

  async startSession(workerId: string, ctx: RequestContext) {
    const worker = await this.workers.findById(workerId);
    if (!worker) throw new NotFoundException(`Worker ${workerId} not found`);

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

    const openingText = await this.ai.profilingOpening();
    // `null` = AI service unreachable. Omit the key and let the client render its own
    // constant, rather than inventing a second copy of the copy here.
    if (openingText === null) return base;

    // Outbound boundary check, following `postMessage` below: the object is built
    // field-by-field so nothing unknown can leak in, and safeParse guards the VALUES.
    // Log field PATHS only, never values, and return the constructed object either
    // way — opening a chat session must NEVER 500 over its greeting.
    //
    // Returns `response`, not `checked.data`, unlike `postMessage`: `started_at` is a
    // Date and the schema's `z.union([z.string(), z.date()])` would hand back the
    // parsed branch. The controller serializes the Date itself, so passing the
    // original through keeps this endpoint's body byte-identical to before.
    const response: StartSessionResponse = { ...base, opening_text: openingText };
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
      return this.terminalResponse(dto.session_id);
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
      return this.checkedResponse(
        {
          session_id: dto.session_id,
          reply: CHAT_ALREADY_COMPLETE_REPLY,
          blocked: false,
          is_mock: true,
          suggested_followups: [],
          asked_question_id: null,
          extraction_ready: reflushed,
          unanswered_essentials: [],
          session_ended: reflushed,
        },
        dto.session_id,
      );
    }

    // 2. The turn budget. API-AUTHORITATIVE: the model is still called on the final
    //    turn (one code path), but it is told to close rather than ask, and completion
    //    is forced whatever comes back. A model must never extend its own interview.
    const turnIndex = buffer.turnCount + 1;
    const forceComplete = turnIndex >= this.config.CHAT_MAX_TURNS;

    // 3. R32 — strip the worker's OWN name from everything crossing the boundary. Read
    //    ONCE per turn and reused by `renderWorkerName` below, so it costs no extra DB
    //    hop over what the vocative already needed. `null` (no name, or an
    //    undecryptable token) means "send it as it was": fail SAFE, because the
    //    ai-service's fail-closed pseudonymize gate is still in front of the LLM and a
    //    key rotation must never make chat unusable.
    //
    //    HISTORY IS REDACTED TOO, and that is new. History used to ship empty (PERF-2),
    //    so `message_text` was the only egress leg. Re-arming history widened the
    //    surface: a name the worker typed on turn two would otherwise ride to the
    //    provider on turn twenty. The buffer keeps their actual words; only the copy
    //    that leaves is redacted.
    const workerFullName = await this.workerFullName(workerId);
    const window = this.config.CHAT_HISTORY_WINDOW_TURNS;
    // A turn is a worker+assistant pair, so the window is doubled into messages.
    const recent = window > 0 ? buffer.messages.slice(-(window * 2)) : buffer.messages;
    const history = recent.map((m) => ({
      role: m.role,
      text: redactKnownName(m.text, workerFullName),
    }));

    const aiResult = await this.ai.profilingRespond({
      session_id: dto.session_id,
      worker_ref: workerId,
      message_text: redactKnownName(dto.text, workerFullName),
      history,
      conversation_state: {
        ...ConversationStateSchema.parse({}),
        role_family: buffer.roleFamily || DEFAULT_ROLE_FAMILY,
        turn_count: buffer.turnCount,
        captured: buffer.captured,
      },
      role_family: buffer.roleFamily || DEFAULT_ROLE_FAMILY,
      force_complete: forceComplete,
    });

    // 4. AI service unreachable. NO TURN HAPPENED — the buffer is not touched at all,
    //    so a retry is exactly safe: no duplicated worker line, no orphan half-turn,
    //    no topic lost. This is why `profilingRespond` returns null instead of
    //    fabricating a turn (the old `mockProfilingTurn`, now deleted).
    if (aiResult === null) {
      this.logger.warn(
        `chat turn dropped session=${dto.session_id} turn=${turnIndex}: AI service ` +
          `unreachable; buffer left untouched so the worker can retry`,
      );
      return this.degradedResponse(dto.session_id, CHAT_UNAVAILABLE_REPLY);
    }

    // 5. Pseudonymization failed closed on the far side. Also a no-op, and here that is
    //    a PRIVACY WIN over the old flow rather than just a symmetry: the previous
    //    design stored the inbound row BEFORE calling the AI service, so the very
    //    message that was blocked for carrying a phone number still landed verbatim in
    //    `chat_messages` and rode into the extraction corpus. Buffering means it never
    //    enters the transcript at all — the worker rephrases, and only the rephrasing
    //    is kept.
    if (aiResult.blocked) {
      return this.degradedResponse(
        dto.session_id,
        this.renderWorkerName(aiResult.reply_text, workerFullName),
        { blocked: true },
      );
    }

    // 6. Append BOTH sides, verbatim. `dto.text` is the worker's actual words (the
    //    audit spine), and the assistant line is the RAW reply carrying the literal
    //    `{{worker_name}}` placeholder — NEVER the interpolated name (SG-1). These are
    //    the exact strings the flush will write to `chat_messages`, so interpolating
    //    here would put a real name in the audit spine and in the extraction corpus.
    const stamp = now.toISOString();
    buffer.messages.push({ role: "worker", text: dto.text, at: stamp });
    buffer.messages.push({ role: "assistant", text: aiResult.reply_text, at: stamp });

    const st = aiResult.updated_state;
    // NEVER below the API's own arithmetic. `turn_count` is echoed by the ai-service and
    // is only schema-checked as a non-negative int, so a version-skewed or buggy service
    // returning a stalled value (0, or the same number every turn) would freeze the
    // counter — `forceComplete` could then never fire and the interview would run
    // unbounded, one real LLM call per turn, with no completion and no flush. The cap is
    // documented as API-authoritative; `Math.max` is what makes that true.
    buffer.turnCount = Math.max(turnIndex, st?.turn_count ?? 0);
    buffer.captured = st?.captured ?? buffer.captured;
    buffer.roleFamily = st?.role_family || buffer.roleFamily || DEFAULT_ROLE_FAMILY;

    const unansweredEssentials = this.coerceStringList(
      st?.unanswered_essentials,
      dto.session_id,
    );

    // 7. Save BEFORE finalizing, never after. If the flush then fails, the completed
    //    buffer survives and the next POST (or a retry) re-attempts it; if we dropped
    //    the key first, a failed flush would destroy the only copy of the interview.
    // The cap is ORed in, not merely SENT. The ai-service applies it too (its own
    // `cap_fired` includes `force_complete`), so today this is redundant — but the
    // comment at step 2 promises "completion is forced whatever comes back", and this is
    // the line that makes that true. Without it, an ai-service that returned
    // `extraction_ready: false` on the capped turn would leave the worker chatting past
    // the budget forever: one real LLM call per turn, no completion, no flush, no
    // profile, and no error to notice. Defence in depth on the per-worker cost ceiling.
    const complete = aiResult.extraction_ready || forceComplete;
    if (complete) {
      buffer.completedAt = stamp;
      buffer.completionReason = st?.completion_reason ?? (forceComplete ? "turn_cap" : null) ?? undefined;
    }
    await this.buffer.save(dto.session_id, buffer);

    this.logger.log(
      `turn buffered session=${dto.session_id} turn=${buffer.turnCount} ` +
        `captured=${Object.keys(buffer.captured).length} missing=${unansweredEssentials.length} ` +
        `complete=${complete}`,
    );

    // TERMINAL ONLY IF IT ACTUALLY LANDED. `complete` says the interview should end;
    // `flushed` says the transcript is durable. They differ exactly when the flush
    // transaction rolled back, and conflating them loses the whole interview — see
    // finalizeInterview's catch.
    const flushed = complete ? await this.finalizeInterview(workerId, dto.session_id, buffer, ctx) : false;
    const terminal = complete && flushed;

    // 8. Personalize ONLY the client-returned reply — post-buffer, post-flush, post-emit
    //    — by interpolating the worker's real first name over the `{{worker_name}}`
    //    token. Everything durable still holds the placeholder.
    const response: PostMessageResponse = {
      session_id: dto.session_id,
      reply: this.renderWorkerName(aiResult.reply_text, workerFullName).replace(
        /\{\{[^}]*\}\}/g,
        "",
      ),
      blocked: false,
      is_mock: aiResult.is_mock,
      // THE CHIPS. Same field the deterministic bank filled from a hardcoded per-topic
      // list, so the Flutter client renders them unchanged — but they are now written
      // by the model for the question it actually asked, which is what makes
      // tap-to-answer work for a trade nobody wrote a question pack for.
      suggested_followups: aiResult.suggested_followups,
      // Now the Resume Field Set id this turn asked about, not a question-bank id.
      asked_question_id: aiResult.asked_question_id,
      extraction_ready: terminal,
      // Required RFS fields still missing. Empty = complete. Field ids only, never PII.
      unanswered_essentials: unansweredEssentials,
      // The session just became terminal. Telling the client is what lets it drop its
      // cached session id and open a fresh one next time — without this it posts into a
      // dead session for the rest of the process. Withheld when the flush failed, so the
      // client keeps the session and its next POST re-drives the flush.
      session_ended: terminal,
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
              message_type: "text",
              ...(inbound ? { has_voice_note: false } : {}),
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

  /** A buffered line as the `chat_messages` row it becomes at flush. */
  private toMessageRow(sessionId: string, workerId: string, m: BufferedMessage) {
    return {
      sessionId,
      workerId,
      direction: m.role === "worker" ? ("inbound" as const) : ("outbound" as const),
      messageType: "text" as const,
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
        blocked: opts.blocked ?? false,
        is_mock: true,
        suggested_followups: [],
        asked_question_id: null,
        extraction_ready: false,
        // EMPTY MEANS "UNKNOWN" HERE, not "complete" — no turn happened, so there is no
        // progress to report. Clients must gate on `blocked` / `is_mock` before reading
        // it, exactly as the DTO documents.
        unanswered_essentials: [],
        // The session is still very much alive; the worker should retry into it.
        session_ended: false,
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
        blocked: false,
        is_mock: true,
        suggested_followups: [],
        asked_question_id: null,
        extraction_ready: true,
        unanswered_essentials: [],
        session_ended: true,
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
  private checkedResponse(
    response: PostMessageResponse,
    sessionId: string,
  ): PostMessageResponse {
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
   * Coerce a progress list to its string members. EXPECTED dead code behind the
   * `AiService` typed seam (the response is schema-parsed, so this only ever sees
   * `string[]` or null) — but if a future refactor makes it reachable, the degrade must
   * be OBSERVABLE rather than silent: field name + drop count only, never the values.
   */
  private coerceStringList(raw: unknown, sessionId: string): string[] {
    const list = raw ?? [];
    if (!Array.isArray(list)) {
      this.logger.warn(
        `postMessage coerced unanswered_essentials session=${sessionId} non-array -> []`,
      );
      return [];
    }
    const strings = list.filter((t): t is string => typeof t === "string");
    if (strings.length !== list.length) {
      this.logger.warn(
        `postMessage coerced unanswered_essentials session=${sessionId} ` +
          `dropped=${list.length - strings.length} non-string member(s)`,
      );
    }
    return strings;
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
