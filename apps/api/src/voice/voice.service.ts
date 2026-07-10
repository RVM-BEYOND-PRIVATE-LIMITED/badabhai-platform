import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { ChatRepository } from "../chat/chat.repository";
import { AiJobsRepository } from "../profiles/ai-jobs.repository";
import { StorageService } from "../storage/storage.service";
import {
  VOICE_TRANSCRIPTION_QUEUE,
  type VoiceTranscriptionJobData,
} from "../queue/queue.constants";
import { VoiceRepository } from "./voice.repository";
import type { UploadVoiceNoteDto, TranscribeVoiceNoteDto } from "./voice.dto";

/**
 * Voice-note handling — Phase 1.
 *
 * Upload is a placeholder (no real audio handling): the client provides the
 * already-uploaded storage path, the duration is validated (<= 120s), and a
 * record is created with retention metadata. Transcription is async: it enqueues
 * a BullMQ job (mirrors profile extraction) which calls the AI service on the
 * gated, mock-by-default STT path. No raw audio/transcript ever reaches events.
 */
@Injectable()
export class VoiceService {
  constructor(
    private readonly voice: VoiceRepository,
    private readonly chat: ChatRepository,
    private readonly events: EventsService,
    private readonly aiJobs: AiJobsRepository,
    @InjectQueue(VOICE_TRANSCRIPTION_QUEUE)
    private readonly transcriptionQueue: Queue<VoiceTranscriptionJobData>,
    private readonly storage: StorageService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  /**
   * Mint a signed upload URL into the private voice-notes bucket. The object key
   * is SERVER-controlled (opaque UUIDs only — never a client-chosen path), and
   * the same `voice-notes/<workerId>/` prefix is what `upload` later requires,
   * so a worker can only register objects minted for them. Fail-closed dormancy:
   * with VOICE_NOTES_BUCKET unset (the default) this surface is OFF (503).
   * NO event: issuance is not a state change — `voice_note.uploaded` (emitted by
   * `upload`) remains the registration event. The signed URL embeds a token and
   * is NEVER logged or emitted (same rule as the resume download URL).
   */
  async createUploadUrl(workerId: string) {
    const bucket = this.config.VOICE_NOTES_BUCKET;
    if (!bucket) {
      throw new ServiceUnavailableException("voice uploads not enabled");
    }

    const objectKey = `voice-notes/${workerId}/${randomUUID()}.m4a`;
    const { url, expiresIn } = await this.storage.createSignedUploadUrl(objectKey, bucket);

    return { storage_path: objectKey, upload_url: url, expires_in: expiresIn };
  }

  async upload(workerId: string, dto: UploadVoiceNoteDto, ctx: RequestContext) {
    // The worker is authenticated (WorkerAuthGuard); ownership is what matters.
    // A worker may only attach a note to their OWN session. 404 for both
    // not-found and not-owner (no existence oracle for another worker's session).
    const session = await this.chat.findSession(dto.session_id);
    if (!session || session.workerId !== workerId) {
      throw new NotFoundException(`Session ${dto.session_id} not found`);
    }

    // The path must be one WE minted for THIS worker (createUploadUrl): a worker
    // may not register an object under another worker's prefix (or an arbitrary
    // bucket location). The prefix carries only opaque UUIDs — no PII.
    if (!dto.storage_path.startsWith(`voice-notes/${workerId}/`)) {
      throw new BadRequestException("storage_path not owned by caller");
    }

    const note = await this.voice.create({
      workerId: workerId,
      sessionId: dto.session_id,
      storagePath: dto.storage_path,
      durationSeconds: Math.round(dto.duration_seconds),
      // retentionPolicy / storageClass use schema defaults (retain_indefinitely / hot)
    });

    await this.events.emit({
      event_name: "voice_note.uploaded",
      actor: { actor_type: "worker", actor_id: workerId },
      subject: { subject_type: "voice_note", subject_id: note.id },
      payload: {
        voice_note_id: note.id,
        worker_id: workerId,
        session_id: dto.session_id,
        duration_seconds: dto.duration_seconds,
        storage_path: dto.storage_path,
      },
      idempotencyKey: `voice_note.uploaded:${note.id}`,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    return { voice_note_id: note.id, duration_seconds: note.durationSeconds };
  }

  /**
   * Enqueue an async transcription job (BullMQ/Redis). Returns immediately with
   * the ai_job_id; the client polls `GET /ai-jobs/:id` until completed. The work
   * runs in VoiceTranscriptionProcessor (emits transcription_completed/failed).
   */
  async requestTranscription(
    workerId: string,
    dto: TranscribeVoiceNoteDto,
    ctx: RequestContext,
  ) {
    const note = await this.voice.findById(dto.voice_note_id);
    // Ownership: a worker may only transcribe their OWN note. 404 for both
    // not-found and not-owner (no existence oracle for another worker's note).
    if (!note || note.workerId !== workerId) {
      throw new NotFoundException(`Voice note ${dto.voice_note_id} not found`);
    }

    const job = await this.aiJobs.create({
      jobType: "transcription",
      status: "queued",
      inputRef: { voice_note_id: note.id, worker_id: note.workerId },
    });

    await this.events.emit({
      event_name: "voice_note.transcription_requested",
      actor: { actor_type: "worker", actor_id: note.workerId },
      subject: { subject_type: "ai_job", subject_id: job.id },
      payload: {
        voice_note_id: note.id,
        worker_id: note.workerId,
        ai_job_id: job.id,
      },
      idempotencyKey: `voice_note.transcription_requested:${job.id}`,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    // If enqueue fails (e.g. Redis down), give the job a terminal state so it is
    // not orphaned in "queued" and the requested event is balanced by a failed.
    try {
      await this.transcriptionQueue.add("transcribe", {
        voiceNoteId: note.id,
        workerId: note.workerId,
        storagePath: note.storagePath,
        durationSeconds: note.durationSeconds,
        languageCode: null,
        aiJobId: job.id,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
    } catch (err) {
      const reason = `enqueue failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 240)}`;
      await this.aiJobs.markFailed(job.id, reason);
      await this.events.emit({
        event_name: "voice_note.transcription_failed",
        actor: { actor_type: "system" },
        subject: { subject_type: "ai_job", subject_id: job.id },
        payload: {
          voice_note_id: note.id,
          worker_id: note.workerId,
          ai_job_id: job.id,
          reason,
        },
        // One terminal failure per job. Shares the key namespace with the
        // processor's terminal-failure emit: a job fails EITHER at enqueue here OR
        // in the processor, never both, so at most one row is ever written.
        idempotencyKey: `voice_note.transcription_failed:${job.id}`,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
      throw new ServiceUnavailableException("Could not enqueue transcription job; please retry");
    }

    return { ai_job_id: job.id, status: "queued" as const };
  }

  /**
   * Read one voice note (the client polls this after transcription completes).
   * Ownership: 404 for both not-found and not-owner (no existence oracle for
   * another worker's note). Transcript text is raw worker free-text returned
   * ONLY to its owner over the authenticated channel — it never enters events,
   * ai_jobs, or logs. Read-only → NO event.
   */
  async getNote(workerId: string, voiceNoteId: string) {
    const note = await this.voice.findById(voiceNoteId);
    if (!note || note.workerId !== workerId) {
      throw new NotFoundException(`Voice note ${voiceNoteId} not found`);
    }

    return {
      voice_note_id: note.id,
      duration_seconds: note.durationSeconds,
      transcript_text: note.transcriptText,
      transcript_english: note.transcriptEnglish,
      transcript_confidence: note.transcriptConfidence,
    };
  }
}
