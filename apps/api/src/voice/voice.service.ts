import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { WorkersRepository } from "../workers/workers.repository";
import { ChatRepository } from "../chat/chat.repository";
import { VoiceRepository } from "./voice.repository";
import type { UploadVoiceNoteDto } from "./voice.dto";

/**
 * Voice-note handling — PLACEHOLDER for Phase 1.
 *
 * No real audio upload or STT (Sarvam) integration. The duration is validated
 * (<= 120s) and a record is created with retention metadata. Transcription is a
 * later slice (would enqueue voice_note.transcription_requested).
 */
@Injectable()
export class VoiceService {
  constructor(
    private readonly voice: VoiceRepository,
    private readonly workers: WorkersRepository,
    private readonly chat: ChatRepository,
    private readonly events: EventsService,
  ) {}

  async upload(dto: UploadVoiceNoteDto, ctx: RequestContext) {
    const worker = await this.workers.findById(dto.worker_id);
    if (!worker) throw new NotFoundException(`Worker ${dto.worker_id} not found`);

    const session = await this.chat.findSession(dto.session_id);
    if (!session) throw new NotFoundException(`Session ${dto.session_id} not found`);
    if (session.workerId !== dto.worker_id) {
      throw new BadRequestException("worker_id does not match the session owner");
    }

    const note = await this.voice.create({
      workerId: dto.worker_id,
      sessionId: dto.session_id,
      storagePath: dto.storage_path,
      durationSeconds: Math.round(dto.duration_seconds),
      // retentionPolicy / storageClass use schema defaults (retain_indefinitely / hot)
    });

    await this.events.emit({
      event_name: "voice_note.uploaded",
      actor: { actor_type: "worker", actor_id: dto.worker_id },
      subject: { subject_type: "voice_note", subject_id: note.id },
      payload: {
        voice_note_id: note.id,
        worker_id: dto.worker_id,
        session_id: dto.session_id,
        duration_seconds: dto.duration_seconds,
        storage_path: dto.storage_path,
      },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    return { voice_note_id: note.id, duration_seconds: note.durationSeconds };
  }
}
