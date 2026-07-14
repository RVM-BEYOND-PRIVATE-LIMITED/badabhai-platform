import { Inject, Injectable, Logger, NotFoundException, forwardRef } from "@nestjs/common";
import {
  ConversationStateSchema,
  type ConversationMessage,
  type ConversationState,
} from "@badabhai/ai-contracts";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { WorkersRepository } from "../workers/workers.repository";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { AiService } from "../ai/ai.service";
import { ProfilesService } from "../profiles/profiles.service";
import { ChatRepository } from "./chat.repository";
import type { PostMessageDto } from "./chat.dto";

const DEFAULT_ROLE_FAMILY = "cnc_vmc";

// AI-PERSONA-2: the ai-service emits this literal token (never a real name) at the
// vocative slots. The real first name is interpolated over it here in the API,
// POST-emit, only in the value returned to the client — see renderWorkerName.
const WORKER_NAME_PLACEHOLDER = "{{worker_name}}";

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
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
    return { session_id: session.id, status: session.status, started_at: session.startedAt };
  }

  async postMessage(workerId: string, dto: PostMessageDto, ctx: RequestContext) {
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
    const history = await this.buildHistory(dto.session_id);
    this.logger.log(
      `state sent session=${dto.session_id} conversation_state=${priorState ? "present" : "null"} role_family=${roleFamily}`,
    );
    const aiResult = await this.ai.profilingRespond({
      session_id: dto.session_id,
      worker_ref: workerId,
      message_text: dto.text,
      history,
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
      // this row is the audit spine (its history also feeds the next AI turn) and
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
    return {
      session_id: dto.session_id,
      reply: await this.renderWorkerName(aiResult.reply_text, workerId),
      blocked: aiResult.blocked,
      is_mock: aiResult.is_mock,
      suggested_followups: aiResult.suggested_followups,
      // Additive (backward compatible): lets the client/test see interview progress.
      asked_question_id: aiResult.asked_question_id,
      extraction_ready: aiResult.extraction_ready,
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

    if (firstName) {
      return reply
        .replaceAll(`${WORKER_NAME_PLACEHOLDER} ji, `, `${firstName} ji, `)
        .replaceAll(WORKER_NAME_PLACEHOLDER, firstName);
    }
    // No usable name: drop the vocative token and its trailing " ji, " cleanly.
    return reply
      .replaceAll(`${WORKER_NAME_PLACEHOLDER} ji, `, "")
      .replaceAll(WORKER_NAME_PLACEHOLDER, "");
  }

  /**
   * Auto-trigger profile extraction once the interview first becomes
   * extraction-ready, so no manual `POST /profile/extract` is needed.
   *
   * Duplicate-extraction protection (three layers):
   *  1. Called only from the readiness FLIP, which is itself gated by the
   *     `extraction_ready_emitted` marker → at most once per session across turns.
   *  2. Skips if the worker already has a profile row (`latestProfile`) → repeated
   *     signals / re-onboarding never create a second profile.
   *  3. `ProfilesService.extract` enqueues a BullMQ job whose processor is
   *     idempotent per `ai_job` (it returns the prior profile_id on redelivery),
   *     so `profile.extraction_completed` is emitted exactly once.
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
      if (existing) {
        this.logger.log(
          `auto-extract skipped session=${sessionId}: worker already has profile ${existing.id}`,
        );
        return;
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

  /** Build conversation history (excluding the just-stored inbound message). */
  private async buildHistory(sessionId: string): Promise<ConversationMessage[]> {
    const messages = await this.chat.listMessages(sessionId);
    return messages
      .filter((m) => m.bodyText)
      .map((m) => ({
        role: m.direction === "inbound" ? ("worker" as const) : ("assistant" as const),
        text: m.bodyText ?? "",
      }));
  }
}
