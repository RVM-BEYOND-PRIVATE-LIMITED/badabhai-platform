import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { ConversationMessage } from "@badabhai/ai-contracts";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { WorkersRepository } from "../workers/workers.repository";
import { AiService } from "../ai/ai.service";
import { ChatRepository } from "./chat.repository";
import type { PostMessageDto } from "./chat.dto";

@Injectable()
export class ChatService {
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

    // 2. Ask the AI service (pseudonymizes internally; mock fallback if down).
    const history = await this.buildHistory(dto.session_id);
    const aiResult = await this.ai.profilingRespond({
      session_id: dto.session_id,
      worker_ref: dto.worker_id,
      message_text: dto.text,
      history,
    });

    // 3. Store outbound message + emit.
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

    await this.chat.touchSession(dto.session_id, new Date());

    return {
      session_id: dto.session_id,
      reply: aiResult.reply_text,
      blocked: aiResult.blocked,
      is_mock: aiResult.is_mock,
      suggested_followups: aiResult.suggested_followups,
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
