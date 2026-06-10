import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import {
  ConversationStateSchema,
  type ConversationMessage,
  type ConversationState,
} from "@badabhai/ai-contracts";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { WorkersRepository } from "../workers/workers.repository";
import { AiService } from "../ai/ai.service";
import { ChatRepository } from "./chat.repository";
import type { PostMessageDto } from "./chat.dto";

const DEFAULT_ROLE_FAMILY = "cnc_vmc";

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly chat: ChatRepository,
    private readonly workers: WorkersRepository,
    private readonly events: EventsService,
    private readonly ai: AiService,
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
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
    return { session_id: session.id, status: session.status, started_at: session.startedAt };
  }

  async postMessage(dto: PostMessageDto, ctx: RequestContext) {
    const session = await this.chat.findSession(dto.session_id);
    if (!session) throw new NotFoundException(`Session ${dto.session_id} not found`);
    if (session.workerId !== dto.worker_id) {
      throw new BadRequestException("worker_id does not match the session owner");
    }

    // 1. Store inbound message + emit.
    const inbound = await this.chat.insertMessage({
      sessionId: dto.session_id,
      workerId: dto.worker_id,
      direction: "inbound",
      messageType: "text",
      bodyText: dto.text,
    });
    await this.events.emit({
      event_name: "chat.message_received",
      actor: { actor_type: "worker", actor_id: dto.worker_id },
      subject: { subject_type: "chat_message", subject_id: inbound.id },
      payload: {
        session_id: dto.session_id,
        worker_id: dto.worker_id,
        message_id: inbound.id,
        message_type: "text",
        has_voice_note: false,
      },
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
      worker_ref: dto.worker_id,
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
      workerId: dto.worker_id,
      direction: "outbound",
      messageType: "text",
      bodyText: aiResult.reply_text,
      metadata: { is_mock: aiResult.is_mock, blocked: aiResult.blocked },
    });
    await this.events.emit({
      event_name: "chat.message_sent",
      actor: { actor_type: "ai_service" },
      subject: { subject_type: "chat_message", subject_id: outbound.id },
      payload: {
        session_id: dto.session_id,
        worker_id: dto.worker_id,
        message_id: outbound.id,
        message_type: "text",
      },
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
        actor: { actor_type: "worker", actor_id: dto.worker_id },
        subject: { subject_type: "chat_session", subject_id: dto.session_id },
        payload: {
          worker_id: dto.worker_id,
          session_id: dto.session_id,
          role_family: st.role_family,
          turn_count: st.turn_count,
          answered_topics: st.answered_topics,
        },
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
      this.logger.log(
        `extraction_ready emitted session=${dto.session_id} turn=${st.turn_count} ` +
          `answered=[${st.answered_topics.join(",")}]`,
      );
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
      // on EVERY later turn. NOTE: this does NOT make the emit idempotent under an
      // at-least-once retry of the *same* turn (emit in step 5 commits before this
      // marker) — that is the platform-wide event-delivery property shared by all
      // emit sites (chat.message_sent, etc.), tracked as TD18 for a uniform fix.
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

    return {
      session_id: dto.session_id,
      reply: aiResult.reply_text,
      blocked: aiResult.blocked,
      is_mock: aiResult.is_mock,
      suggested_followups: aiResult.suggested_followups,
      // Additive (backward compatible): lets the client/test see interview progress.
      asked_question_id: aiResult.asked_question_id,
      extraction_ready: aiResult.extraction_ready,
    };
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
