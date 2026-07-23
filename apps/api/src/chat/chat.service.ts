import { Inject, Injectable, Logger, NotFoundException, forwardRef } from "@nestjs/common";
import { ConversationStateSchema, type ConversationState } from "@badabhai/ai-contracts";
import type { ServerConfig } from "@badabhai/config";
import type { RequestContext } from "../common/request-context";
import { SERVER_CONFIG } from "../config/config.module";
import { EventsService } from "../events/events.service";
import { WorkersRepository } from "../workers/workers.repository";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { AiService } from "../ai/ai.service";
import { ProfilesService } from "../profiles/profiles.service";
// T3: the SAME "did this extraction extract anything?" predicate ProfilesService
// dedupes on (issue #420). A pure leaf function — no new module edge, no new cycle.
import { hasExtractedContent } from "../profiles/profile-content";
import { ChatRepository } from "./chat.repository";
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

    // 1. Store inbound message + emit.
    const inbound = await this.chat.insertMessage({
      sessionId: dto.session_id,
      workerId: workerId,
      direction: "inbound",
      messageType: "text",
      bodyText: dto.text,
    });
    await this.events.emit({
      event_name: "chat.message_received",
      actor: { actor_type: "worker", actor_id: workerId },
      subject: { subject_type: "chat_message", subject_id: inbound.id },
      payload: {
        session_id: dto.session_id,
        worker_id: workerId,
        message_id: inbound.id,
        message_type: "text",
        has_voice_note: false,
      },
      // One received-event per stored inbound message. (A full-turn HTTP retry
      // creates a NEW message row → new id → distinct event; deduping THAT needs a
      // client-supplied request key threaded to insertMessage — out of TD18 scope.)
      idempotencyKey: `chat.message_received:${inbound.id}`,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    // 2. Load the persisted interview state (carried across turns) + role family.
    //    This is what keeps the interview from restarting at Q1 every message.
    //    Re-validate at the boundary: a malformed/stale JSONB row degrades to a
    //    fresh interview instead of throwing (defaults are filled for partial rows).
    const loaded = ConversationStateSchema.nullable().safeParse(session.conversationState ?? null);
    if (!loaded.success) {
      this.logger.warn(
        `session ${dto.session_id} had an invalid conversation_state; restarting interview`,
      );
    }
    const priorState: ConversationState | null = loaded.success ? loaded.data : null;
    const roleFamily = priorState?.role_family ?? DEFAULT_ROLE_FAMILY;
    // Idempotency marker for profile.extraction_ready: read from the RAW JSONB
    // (ConversationStateSchema strips this key, so the interview engine never
    // sees it). Lets us emit the readiness event once — on the flip — instead of
    // on every turn after the interview becomes extraction-ready.
    const priorReadyEmitted = Boolean(
      (session.conversationState as { extraction_ready_emitted?: boolean } | null)
        ?.extraction_ready_emitted,
    );
    this.logger.log(
      `state loaded session=${dto.session_id} turn=${priorState?.turn_count ?? 0} ` +
        `role_family=${roleFamily} asked=[${priorState?.asked_question_ids?.join(",") ?? ""}]`,
    );

    // 3. Ask the AI service, PASSING the loaded state (pseudonymizes internally;
    //    stateful mock fallback if the service is down).
    //    PERF-2: `history` ships EMPTY on purpose — the turn is stateless on the
    //    ai-service side (COST-3): /profiling/respond keys off message_text +
    //    conversation_state only, build_chat_messages already ignores history, and
    //    a null-state turn mints a FRESH ConversationState (it never reconstructs
    //    state from history). The field itself STAYS in the payload — it is part
    //    of the shipped ProfilingTurnInput contract (invariant #8) — only its
    //    contents were dead weight. Extraction is unaffected: it assembles the
    //    FULL transcript itself (profile-extraction.processor.ts buildTranscript),
    //    not via this path.
    this.logger.log(
      `state sent session=${dto.session_id} conversation_state=${priorState ? "present" : "null"} role_family=${roleFamily}`,
    );
    const aiResult = await this.ai.profilingRespond({
      session_id: dto.session_id,
      worker_ref: workerId,
      message_text: dto.text,
      history: [],
      conversation_state: priorState,
      role_family: roleFamily,
    });
    this.logger.log(
      `state received session=${dto.session_id} asked_question_id=${aiResult.asked_question_id ?? "-"} ` +
        `turn=${aiResult.updated_state?.turn_count ?? "-"} extraction_ready=${aiResult.extraction_ready}`,
    );

    // 4. Store outbound message + emit. (unchanged — events keep flowing)
    const outbound = await this.chat.insertMessage({
      sessionId: dto.session_id,
      workerId: workerId,
      direction: "outbound",
      messageType: "text",
      // ⚠️ SG-1 / PII-TRAP (AI-PERSONA-2): store the RAW reply_text — it carries the
      // literal {{worker_name}} placeholder, NEVER the worker's real name. Do NOT
      // interpolate the name before this insert or before the event emit below:
      // this row is the audit spine (its history feeds the EXTRACTION transcript —
      // since PERF-2, stored messages no longer reach the next AI turn at all) and
      // must stay PII-free. The real name is stitched in ONLY at the client return
      // (step 7, renderWorkerName). Keep interpolation OUT of this path.
      bodyText: aiResult.reply_text,
      metadata: { is_mock: aiResult.is_mock, blocked: aiResult.blocked },
    });
    await this.events.emit({
      event_name: "chat.message_sent",
      actor: { actor_type: "ai_service" },
      subject: { subject_type: "chat_message", subject_id: outbound.id },
      payload: {
        session_id: dto.session_id,
        worker_id: workerId,
        message_id: outbound.id,
        message_type: "text",
      },
      idempotencyKey: `chat.message_sent:${outbound.id}`,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    // 5. Emit profile.extraction_ready ONCE — on the turn the engine flips
    //    `extraction_ready` (the frozen v1 contract this signal was added for).
    //    Lets the backend gate extraction on a worker signal instead of guessing.
    //    PII-free: ids, role-family slug, interview topic ids + counts only.
    //    Require updated_state: the contract permits extraction_ready WITHOUT
    //    updated_state, but emitting then would be an empty/misleading signal AND
    //    would skip the marker in step 6 (→ re-emit next turn). Flip == ready now,
    //    not previously emitted, and we have the state to describe it.
    const st = aiResult.updated_state;
    const becameReady = aiResult.extraction_ready && st != null && !priorReadyEmitted;
    if (becameReady && st) {
      await this.events.emit({
        event_name: "profile.extraction_ready",
        actor: { actor_type: "worker", actor_id: workerId },
        subject: { subject_type: "chat_session", subject_id: dto.session_id },
        payload: {
          worker_id: workerId,
          session_id: dto.session_id,
          role_family: st.role_family,
          turn_count: st.turn_count,
          answered_topics: st.answered_topics,
        },
        // Exactly one readiness signal per session, even if the marker-write below
        // is lost and the same turn is retried (TD18 — DB-enforced, not just the
        // in-state marker).
        idempotencyKey: `profile.extraction_ready:${dto.session_id}`,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
      this.logger.log(
        `extraction_ready emitted session=${dto.session_id} turn=${st.turn_count} ` +
          `answered=[${st.answered_topics.join(",")}]`,
      );

      // Auto-trigger profile extraction on the flip — no manual /profile/extract
      // needed. Fires on the SAME once-per-session guard as the event above.
      await this.autoTriggerExtraction(workerId, dto.session_id, ctx);
    }

    // 6. Persist the UPDATED interview state so the next turn continues from here
    //    (never restarts). Falls back to a plain touch when no state was returned.
    //    NOTE: this read-modify-write is intentionally last-write-wins — a session
    //    has a single author (one worker typing sequentially). Revisit if a session
    //    ever gets concurrent writers (multi-device / async voice notes).
    const now = new Date();
    if (aiResult.updated_state) {
      const stateToPersist: Record<string, unknown> = {
        ...(aiResult.updated_state as unknown as Record<string, unknown>),
      };
      // Carry the readiness marker forward once ready so step 5 does not re-emit
      // on EVERY later turn. The marker is the FAST path (skips work next turn);
      // it is NOT the correctness guarantee. If this marker-write is lost and the
      // SAME turn is retried, the readiness emit in step 5 is still exactly-once
      // because it carries an `idempotencyKey` and the events table enforces
      // dedup at insert (ON CONFLICT DO NOTHING) — the TD18 fix, now applied
      // platform-wide at every emit site with a stable key.
      if (aiResult.extraction_ready || priorReadyEmitted) {
        stateToPersist.extraction_ready_emitted = true;
      }
      await this.chat.saveConversationState(dto.session_id, stateToPersist, now);
      this.logger.log(
        `state persisted session=${dto.session_id} turn=${aiResult.updated_state.turn_count} ` +
          `asked=[${aiResult.updated_state.asked_question_ids.join(",")}] ` +
          `answered=[${aiResult.updated_state.answered_topics.join(",")}]`,
      );
    } else {
      await this.chat.touchSession(dto.session_id, now);
    }

    // 7. Personalize ONLY the client-returned reply — post-store, post-emit — by
    //    interpolating the worker's real first name over the {{worker_name}} token.
    //    The stored message (step 4) + every event above still hold the placeholder.
    //
    //    CHAT-UE-1: surface the engine's completeness signal on the reply.
    //    `updated_state` is GENUINELY null on the REAL service's blocked leg
    //    (pseudonymize fails closed → ProfilingTurnOutput.updated_state None; the
    //    contract is `.nullable()`) → `?? []` (never throw). The mock/AI-down
    //    fallback is NOT that leg: it always returns a full state, whose
    //    unanswered_essentials mockProfilingTurn recomputes every turn. A malformed
    //    VALUE from a future engine bug (non-string member / non-array) is coerced
    //    to its string members here, BEFORE the outbound check — a chat turn must
    //    never 500 on a progress field.
    const rawUnanswered: unknown = aiResult.updated_state?.unanswered_essentials ?? [];
    const unansweredEssentials = Array.isArray(rawUnanswered)
      ? rawUnanswered.filter((t): t is string => typeof t === "string")
      : [];
    // This coercion is EXPECTED dead code behind the AiService typed seam (post()
    // schema-parses both legs, so step 7 only ever sees string[] or null) - but if a
    // future refactor makes it reachable, the degrade must be OBSERVABLE, not silent:
    // field name + drop count only, never the values (SG-2 / no-PII-in-logs).
    if (!Array.isArray(rawUnanswered)) {
      this.logger.warn(
        `postMessage coerced unanswered_essentials session=${dto.session_id} non-array -> []`,
      );
    } else if (unansweredEssentials.length !== rawUnanswered.length) {
      this.logger.warn(
        `postMessage coerced unanswered_essentials session=${dto.session_id} ` +
          `dropped=${rawUnanswered.length - unansweredEssentials.length} non-string member(s)`,
      );
    }
    const response: PostMessageResponse = {
      session_id: dto.session_id,
      reply: await this.renderWorkerName(aiResult.reply_text, workerId),
      blocked: aiResult.blocked,
      is_mock: aiResult.is_mock,
      suggested_followups: aiResult.suggested_followups,
      // Additive (backward compatible): lets the client/test see interview progress.
      asked_question_id: aiResult.asked_question_id,
      extraction_ready: aiResult.extraction_ready,
      // CHAT-UE-1 (additive): ESSENTIAL topics not yet answered, in ESSENTIAL_TOPICS
      // order; empty = complete; topic ids only, never PII.
      unanswered_essentials: unansweredEssentials,
    };
    // Outbound boundary check (belt-and-braces): the object above is constructed
    // field-by-field, so unknown engine fields cannot leak in; safeParse guards the
    // VALUES. On failure, log field PATHS only — never values (the reply carries the
    // worker's real name post-render; §2 no-PII-in-logs) — and fall back to the
    // explicitly constructed object. Outbound validation must NEVER 500 a chat turn.
    const checked = PostMessageResponseSchema.safeParse(response);
    if (!checked.success) {
      this.logger.warn(
        `postMessage outbound validation failed session=${dto.session_id} ` +
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
   */
  async listMessages(workerId: string, sessionId: string): Promise<SessionMessagesResponse> {
    const session = await this.chat.findSession(sessionId);
    if (!session || session.workerId !== workerId) {
      throw new NotFoundException(`Session ${sessionId} not found`);
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
   * AI-PERSONA-2 — replace the ai-service's ``{{worker_name}}`` placeholder with
   * the worker's real FIRST name, deterministically and PII-safely. Called ONLY on
   * the value returned to the client (never on the stored message or any event —
   * SG-1). The name is decrypted SERVER-SIDE (TD21: `workers.full_name` is
   * encrypted at rest) and is NEVER logged, evented, put in `ai_jobs`, or sent to
   * the ai-service/LLM.
   *
   * Null / not-yet-set / undecryptable name → strip the token AND its trailing
   * " ji, " so the reply degrades to a clean no-vocative line (no stray "{{ }}").
   */
  private async renderWorkerName(reply: string, workerId: string): Promise<string> {
    // Fast path: nothing to interpolate (e.g. a mid-interview ack turn) → no DB read.
    if (!reply.includes(WORKER_NAME_PLACEHOLDER)) return reply;

    let firstName = "";
    const worker = await this.workers.findById(workerId);
    if (worker?.fullName) {
      try {
        // full_name is encrypted at rest (TD21) — decrypt here, never log the value.
        firstName = this.pii.decrypt(worker.fullName).trim().split(/\s+/)[0] ?? "";
      } catch {
        // Malformed / rotated-key / tampered token must NOT 500 the chat reply
        // (a key rotation would otherwise break every worker at once). Degrade to
        // the name-less line, same as no name set. Never log the token/error.
        this.logger.warn(
          `could not decrypt full_name for worker ${workerId}; reply stays name-less`,
        );
      }
    }

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
