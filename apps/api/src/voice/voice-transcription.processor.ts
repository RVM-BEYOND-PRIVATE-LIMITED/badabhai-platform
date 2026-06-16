import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { EventsService } from "../events/events.service";
import { AiService } from "../ai/ai.service";
import { AiJobsRepository } from "../profiles/ai-jobs.repository";
import { VoiceRepository } from "./voice.repository";
import {
  VOICE_TRANSCRIPTION_QUEUE,
  type VoiceTranscriptionJobData,
} from "../queue/queue.constants";

/**
 * Runs voice transcription off the request path (mirrors the profile-extraction
 * processor). The AI service keeps the real Sarvam call gated off (mock by
 * default) and falls back safely if it is down, so no raw audio leaves and no
 * transcript text reaches the event stream — the completed event carries only
 * length + confidence. Emits transcription_completed on success and
 * transcription_failed on terminal failure. In-process for Phase 1.
 */
@Processor(VOICE_TRANSCRIPTION_QUEUE)
export class VoiceTranscriptionProcessor extends WorkerHost {
  private readonly logger = new Logger(VoiceTranscriptionProcessor.name);

  constructor(
    private readonly voice: VoiceRepository,
    private readonly aiJobs: AiJobsRepository,
    private readonly events: EventsService,
    private readonly ai: AiService,
  ) {
    super();
  }

  async process(job: Job<VoiceTranscriptionJobData>): Promise<{ voice_note_id: string }> {
    const { voiceNoteId, workerId, storagePath, durationSeconds, languageCode, aiJobId, correlationId, requestId } =
      job.data;

    // Idempotency: a prior attempt may have already completed (e.g. BullMQ
    // stalled-job redelivery) — don't re-transcribe; return the recorded id.
    const existing = await this.aiJobs.findById(aiJobId);
    if (existing?.status === "completed") {
      this.logger.log(`transcription job ${aiJobId} already completed; skipping reprocess`);
      return { voice_note_id: voiceNoteId };
    }

    try {
      await this.aiJobs.markRunning(aiJobId);

      const result = await this.ai.transcribe({
        voice_note_id: voiceNoteId,
        storage_path: storagePath,
        duration_seconds: durationSeconds,
        language_code: languageCode ?? undefined,
      });

      // Persist the transcript + English translation ONLY on the voice_notes row
      // (never in events/jobs).
      await this.voice.setTranscript(
        voiceNoteId,
        result.transcript_text,
        result.confidence,
        result.english_text ?? "",
      );
      await this.aiJobs.markCompleted(aiJobId, { voice_note_id: voiceNoteId });

      await this.events.emit({
        event_name: "voice_note.transcription_completed",
        actor: { actor_type: "ai_service" },
        subject: { subject_type: "voice_note", subject_id: voiceNoteId },
        payload: {
          voice_note_id: voiceNoteId,
          worker_id: workerId,
          ai_job_id: aiJobId,
          transcript_confidence: result.confidence,
          transcript_length: result.transcript_text.length,
          transcript_english_length: (result.english_text ?? "").length,
        },
        // Exactly one completion per job, even under BullMQ stalled-job
        // redelivery that races past the early-return idempotency guard above.
        idempotencyKey: `voice_note.transcription_completed:${aiJobId}`,
        correlationId,
        requestId,
      });

      return { voice_note_id: voiceNoteId };
    } catch (err) {
      const reason = (err instanceof Error ? err.message : String(err)).slice(0, 256);
      const maxAttempts = job.opts.attempts ?? 1;
      const isFinalAttempt = job.attemptsMade + 1 >= maxAttempts;

      // Record the terminal failure once (BullMQ retries before this).
      if (isFinalAttempt) {
        await this.aiJobs.markFailed(aiJobId, reason);
        await this.events.emit({
          event_name: "voice_note.transcription_failed",
          actor: { actor_type: "system" },
          subject: { subject_type: "ai_job", subject_id: aiJobId },
          payload: { voice_note_id: voiceNoteId, worker_id: workerId, ai_job_id: aiJobId, reason },
          // One terminal failure per job (final attempt). Shares the key namespace
          // with the enqueue-failure emit in VoiceService — mutually exclusive.
          idempotencyKey: `voice_note.transcription_failed:${aiJobId}`,
          correlationId,
          requestId,
        });
      }
      this.logger.warn(`transcription job ${aiJobId} failed (attempt ${job.attemptsMade + 1}): ${reason}`);
      throw err; // rethrow so BullMQ records/retries the failure
    }
  }
}
