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

    // …AND THE SAME QUESTION ASKED OF THE THING WE ACTUALLY PAY FOR.
    //
    // The job-status guard above is necessary and not sufficient. `markRunning` fires at the
    // top of EVERY attempt, so a retry sees `running`, never `completed`, and falls straight
    // through to a second provider call. That is a real double-charge whenever the Sarvam call
    // succeeded and something AFTER it did not — `setTranscript` hitting a connection blip, the
    // completion emit throwing, the worker being killed between the two. BullMQ retries the
    // whole `process`, and the transcript we already bought is thrown away.
    //
    // `transcript_text IS NOT NULL` is the durable record of "we have already paid for this
    // audio". Compared against null EXPLICITLY, never truthiness: an empty string is a
    // legitimate transcript (the worker said nothing into the mic) and it cost exactly as much
    // as a full one.
    const note = await this.voice.findById(voiceNoteId);
    if (note?.transcriptText !== null && note?.transcriptText !== undefined) {
      this.logger.log(
        `voice note ${voiceNoteId} already carries a transcript; completing job ${aiJobId} ` +
          `without a second provider call`,
      );
      await this.aiJobs.markCompleted(aiJobId, { voice_note_id: voiceNoteId });
      return { voice_note_id: voiceNoteId };
    }

    try {
      await this.aiJobs.markRunning(aiJobId);

      const result = await this.ai.transcribe({
        voice_note_id: voiceNoteId,
        storage_path: storagePath,
        duration_seconds: durationSeconds,
        language_code: languageCode ?? undefined,
        // Opaque UUID (PII-free) — attributes real STT chunk spend (D-2: a 120s
        // note is up to 5 provider calls) to this worker's TD27 per-user daily
        // budget, same as chat/extraction/resume already do.
        worker_ref: workerId,
      });

      // A DEGRADED RESULT IS A FAILURE, AND IT USED TO BE RECORDED AS A SUCCESS.
      //
      // The adapter distinguishes three empty transcripts — `stt_budget_blocked` (we refused to
      // call the provider), `stt_call_failed` (the call failed), `stt_service_unreachable` (the
      // ai-service never answered) — from the fourth, which is the worker genuinely saying
      // nothing. Until `error_code` was carried on the wire, all four arrived here identical:
      // an empty string. This method stored it, marked the job `completed`, and emitted
      // `transcription_completed` with `transcript_length: 0`.
      //
      // In chat that degrades a reply. In a voice-driven form the worker speaks their answer
      // into a noisy yard and it disappears behind a green tick — no retry, no signal, and the
      // audio already bought and stored.
      //
      // THROWN RATHER THAN HANDLED HERE ON PURPOSE. The catch below already owns what
      // "terminal" means: BullMQ retries (`stt_call_failed` and `stt_service_unreachable` are
      // frequently transient), and only the final attempt writes `markFailed` and the one
      // `transcription_failed` event. Duplicating that here would give this file a second,
      // quietly divergent definition of failure. `stt_budget_blocked` will not recover on a
      // retry, but a retry of it costs nothing — no provider call is made — and the terminal
      // record is identical.
      if (result.error_code) {
        throw new Error(`transcription degraded: ${result.error_code}`);
      }

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
