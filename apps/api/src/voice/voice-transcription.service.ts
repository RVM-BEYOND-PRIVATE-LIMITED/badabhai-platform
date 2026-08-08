import { ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { EventsService } from "../events/events.service";
import { AiService } from "../ai/ai.service";
import { AiJobsRepository } from "../profiles/ai-jobs.repository";
import { VoiceRepository } from "./voice.repository";
import type { VoiceTranscriptionJobData } from "../queue/queue.constants";

/**
 * Transcribe one voice note: idempotency, the provider call, the degraded-result decision,
 * persistence, and the terminal record. Everything that is not queue plumbing.
 *
 * WHY IT IS A SERVICE AND NOT A `process()` METHOD. All of this lived inside
 * `VoiceTranscriptionProcessor.process` — 127 lines of which only four were queue-shaped (the
 * `@Processor` wiring, the `job.data` destructure, the attempt arithmetic, and the rethrow).
 * CLAUDE.md §4 puts business logic in services, and the cost of ignoring that here is concrete
 * rather than stylistic: the voice form's synchronous ≤30s answer path needs to run EXACTLY this
 * sequence without a queue hop, and with the logic welded to a `WorkerHost` its only options were
 * to fake a `Job` object or to fork the code. A fork would drift on the parts that matter most —
 * which results count as degraded, and what "already paid for" means.
 *
 * IT HAS A CALLER TODAY. The processor below delegates to it, so this is not a repository waiting
 * for a consumer; it is the same code, reachable.
 */
@Injectable()
export class VoiceTranscriptionService {
  private readonly logger = new Logger(VoiceTranscriptionService.name);

  constructor(
    private readonly voice: VoiceRepository,
    private readonly aiJobs: AiJobsRepository,
    private readonly events: EventsService,
    private readonly ai: AiService,
  ) {}

  /**
   * @param terminal Whether a failure here is FINAL — i.e. the caller will not try again.
   *
   * A POLICY INPUT, NOT QUEUE PLUMBING, and that distinction is what lets this method be shared.
   * "Will this be retried?" is a fact only the caller knows: BullMQ derives it from
   * `attemptsMade` against `opts.attempts`, and a synchronous request-path caller simply passes
   * `true` because there is no second attempt. The terminal record — `markFailed` plus exactly
   * one `voice_note.transcription_failed` — must be written once and only by whoever knows the
   * answer, so the answer is passed in rather than guessed at.
   *
   * Always rethrows on failure. The caller decides what a thrown error means to it (BullMQ
   * retries; a request path maps it to a response), and swallowing it here would take that
   * choice away.
   */
  async transcribe(
    job: VoiceTranscriptionJobData,
    { terminal }: { terminal: boolean },
  ): Promise<{ voice_note_id: string }> {
    const {
      voiceNoteId,
      workerId,
      languageCode,
      aiJobId,
      correlationId,
      requestId,
    } = job;

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
    // whole handler, and the transcript we already bought is thrown away.
    //
    // `transcript_text IS NOT NULL` is the durable record of "we have already paid for this
    // audio". Compared against null EXPLICITLY, never truthiness: an empty string is a
    // legitimate transcript (the worker said nothing into the mic) and it cost exactly as much
    // as a full one.
    const note = await this.voice.findById(voiceNoteId);

    // THE ROW IS THE AUTHORITY ON WHOSE AUDIO THIS IS — not the payload.
    //
    // `storage_path` is the argument that decides WHICH BYTES get fetched and sent to the
    // provider, and `worker_id` decides whose budget pays and whose id rides the event. Taking
    // either from the caller means a caller who can name another worker's `voice_note_id` can
    // have that worker's audio transcribed, billed to them, and the transcript written onto a
    // row of the attacker's choosing — readable afterwards through `GET /voice/:id`.
    //
    // That is unreachable through the queue, whose only producer is
    // `VoiceService.requestTranscription` (it 404s on `note.workerId !== workerId`). But the
    // stated purpose of exporting this service is a SECOND, synchronous caller on the request
    // path, where ids naturally come from the request. Authorization that lives only in one
    // caller stops being authorization the moment there are two, so it lives here — the row is
    // already loaded for the already-paid guard below, which makes this nearly free.
    //
    // Guards sit BEFORE the try: a rejected call must not write `markFailed` or emit a
    // `transcription_failed` against a job it was never entitled to touch.
    if (!note) {
      throw new NotFoundException(`voice note ${voiceNoteId} not found`);
    }
    if (note.workerId !== workerId) {
      // No ids in the message — this is reachable from a request path, and the response must
      // not confirm whose note it is. The log below carries prefixes for the audit trail.
      this.logger.warn(
        `transcription REFUSED: job ${aiJobId} claims worker ${workerId.slice(0, 8)}… for a ` +
          `voice note owned by ${note.workerId.slice(0, 8)}…`,
      );
      throw new ForbiddenException("voice note does not belong to this worker");
    }

    // Everything downstream reads the ROW, so the payload cannot influence which audio is
    // fetched, how long it is billed as, or whose budget pays.
    const storagePath = note.storagePath;
    const ownerId = note.workerId;
    const durationSeconds = note.durationSeconds;

    if (note.transcriptText !== null && note.transcriptText !== undefined) {
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
        worker_ref: ownerId,
      });

      // A DEGRADED RESULT IS A FAILURE, AND IT USED TO BE RECORDED AS A SUCCESS.
      //
      // The adapter distinguishes three empty transcripts — `stt_budget_blocked` (we refused to
      // call the provider), `stt_call_failed` (the call failed), `stt_service_unreachable` (the
      // ai-service never answered) — from the fourth, which is the worker genuinely saying
      // nothing. Until `error_code` was carried on the wire, all four arrived here identical:
      // an empty string. This stored it, marked the job `completed`, and emitted
      // `transcription_completed` with `transcript_length: 0`.
      //
      // In chat that degrades a reply. In a voice-driven form the worker speaks their answer
      // into a noisy yard and it disappears behind a green tick — no retry, no signal, and the
      // audio already bought and stored.
      //
      // THROWN RATHER THAN HANDLED HERE ON PURPOSE. The catch below already owns what
      // "terminal" means: the caller retries (`stt_call_failed` and `stt_service_unreachable`
      // are frequently transient), and only the terminal attempt writes `markFailed` and the
      // one `transcription_failed` event. Duplicating that here would give this file a second,
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
          worker_id: ownerId,
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

      // Record the terminal failure once (the caller retries before this).
      if (terminal) {
        await this.aiJobs.markFailed(aiJobId, reason);
        await this.events.emit({
          event_name: "voice_note.transcription_failed",
          actor: { actor_type: "system" },
          subject: { subject_type: "ai_job", subject_id: aiJobId },
          payload: { voice_note_id: voiceNoteId, worker_id: ownerId, ai_job_id: aiJobId, reason },
          // One terminal failure per job (final attempt). Shares the key namespace
          // with the enqueue-failure emit in VoiceService — mutually exclusive.
          idempotencyKey: `voice_note.transcription_failed:${aiJobId}`,
          correlationId,
          requestId,
        });
      }
      this.logger.warn(`transcription job ${aiJobId} failed (terminal=${terminal}): ${reason}`);
      throw err; // rethrow so the caller records/retries the failure
    }
  }
}
