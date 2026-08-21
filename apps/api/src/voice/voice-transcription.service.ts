import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { EventsService } from "../events/events.service";
import { AiCostRecorder } from "../ai/ai-cost-recorder.service";
import { AiTraceRecorder } from "../ai/ai-trace-recorder.service";
import { toAiJobUsage } from "../ai/ai-job-usage";
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
    // #738 — the emitter that was private to `ProfileExtractionProcessor`, which is why this
    // path recorded no spend at all. `AiModule` is @Global, so `VoiceModule` gains no import edge.
    private readonly aiCost: AiCostRecorder,
    // 0083 — the same six call sites as `aiCost`, one table further. Also from the @Global
    // `AiModule`, so this module still gains no import edge.
    private readonly aiTraces: AiTraceRecorder,
  ) {}

  /**
   * Transcribe ONE clip on the request path and hand back the words.
   *
   * WHY THERE IS NO QUEUE HERE. The chat voice-note flow is right to be asynchronous: a 120 s
   * note can take five provider calls, and nothing is waiting on the result. A profiling answer
   * is the opposite — the worker is holding the phone, the engine cannot choose question n+1
   * without answer n's text, and the clip is capped at {@link MAX_PROFILING_ANSWER_SECONDS},
   * which keeps Sarvam on a SINGLE synchronous call and never enters the chunked path. Queueing
   * it would add a poll loop and a strand for no latency saved.
   *
   * `terminal: true`, because there is no second attempt: the caller is an HTTP request, and if
   * this fails the honest thing is to tell the worker so while their finger is still on the
   * screen. That is the whole reason `terminal` is a parameter rather than queue arithmetic.
   *
   * RETURNS A RESULT RATHER THAN THROWING, unlike {@link transcribe}. The caller is not deciding
   * whether to retry — it is deciding what to show a worker who just spoke, and "their answer did
   * not arrive" is a turn outcome rather than an exception.
   */
  async transcribeNow(input: {
    voiceNoteId: string;
    workerId: string;
    maxSeconds: number;
    ctx: { correlationId: string; requestId: string };
  }): Promise<
    { ok: true; text: string; durationSeconds: number | null } | { ok: false; errorCode: string }
  > {
    const note = await this.voice.findById(input.voiceNoteId);
    // 404 for both not-found and not-owner, so a note id is never an existence oracle. The
    // service-level guard inside `transcribe` is the second wall, not this one's replacement.
    if (!note || note.workerId !== input.workerId) {
      throw new NotFoundException(`Voice note ${input.voiceNoteId} not found`);
    }
    if ((note.durationSeconds ?? 0) > input.maxSeconds) {
      // The cap is what keeps this a single provider call. A longer clip is not "slower", it is
      // a different code path with a different cost and a multi-minute ceiling.
      throw new BadRequestException(
        `A profiling answer may be at most ${input.maxSeconds} seconds`,
      );
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
      payload: { voice_note_id: note.id, worker_id: note.workerId, ai_job_id: job.id },
      idempotencyKey: `voice_note.transcription_requested:${job.id}`,
      correlationId: input.ctx.correlationId,
      requestId: input.ctx.requestId,
    });

    try {
      await this.transcribe(
        {
          voiceNoteId: note.id,
          workerId: note.workerId,
          storagePath: note.storagePath,
          durationSeconds: note.durationSeconds,
          languageCode: null,
          aiJobId: job.id,
          correlationId: input.ctx.correlationId,
          requestId: input.ctx.requestId,
        },
        // THE FORM WANTS THE WORKER'S OWN HINGLISH BACK, not English. The engine's capture layer
        // — the city gazetteer, the yes/no lexicon, the chip labels — is written against what
        // the worker actually says. It also deletes a real, UNLEDGERED Sarvam translate call
        // (R9) from the critical path: `translate.py` imports no cost tracker and takes no
        // worker ref, so every one of those calls today is spend nothing records. Set only for
        // THIS surface; `GET /voice/:id` still returns `transcript_english` for chat notes,
        // because flipping the default would change a shipped response.
        { terminal: true, translateToEnglish: false },
      );
    } catch (err) {
      // `transcribe` has already written the terminal record and the one failed event. All that
      // is left is to say WHICH failure, so the caller can tell the worker something true.
      const reason = err instanceof Error ? err.message : String(err);
      const errorCode = /transcription degraded: (\w+)/.exec(reason)?.[1] ?? "stt_failed";
      return { ok: false, errorCode };
    }

    // READ THE ROW BACK rather than plumbing the transcript out of `transcribe`. The row is what
    // every other reader sees, and the already-paid idempotency guard means a retried request
    // returns the SAME words rather than buying them twice.
    const done = await this.voice.findById(note.id);
    return { ok: true, text: done?.transcriptText ?? "", durationSeconds: note.durationSeconds };
  }

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
    { terminal, translateToEnglish }: { terminal: boolean; translateToEnglish?: boolean },
  ): Promise<{ voice_note_id: string }> {
    const { voiceNoteId, workerId, languageCode, aiJobId, correlationId, requestId } = job;

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

      const request = {
          voice_note_id: voiceNoteId,
          storage_path: storagePath,
          duration_seconds: durationSeconds,
          language_code: languageCode ?? undefined,
          // Opaque UUID (PII-free) — attributes real STT chunk spend (D-2: a 120s
          // note is up to 5 provider calls) to this worker's TD27 per-user daily
          // budget, same as chat/extraction/resume already do.
          worker_ref: ownerId,
          // Omitted (rather than `true`) for every existing caller, so the ai-service default
          // governs exactly as it did before this parameter existed.
          ...(translateToEnglish === undefined ? {} : { translate_to_english: translateToEnglish }),
      };

      const result = await this.ai.transcribe(request, { correlationId, requestId });

      // THE COST RECORD, EMITTED BEFORE THE DEGRADED-RESULT THROW BELOW — deliberately (#738).
      //
      // A real call that fails PART-WAY still paid for the chunks that returned, and the adapter
      // reports exactly that (`real_call` follows the money, not `is_mock`). Putting this after
      // the throw would drop precisely that spend: money spent on a call that then broke, which
      // is the spend most worth having a record of. It never throws, so it cannot convert a
      // transcription into a failure.
      //
      // BOTH IDS COME FROM THE ROW, NOT THE PAYLOAD — the same authority every other decision
      // in this method takes (see the note above `ownerId`). `note.sessionId` is NOT NULL on
      // `voice_notes`, so a clip always names the interview it was spoken into, and a
      // voice-led interview's STT spend lands on the same session total as its model turns.
      await this.aiCost.record(
        result.ai_metadata ?? null,
        "stt_transcription",
        aiJobId,
        correlationId,
        requestId,
        { workerId: ownerId, sessionId: note.sessionId },
      );

      // AND THE TRACE (0083), on the same metadata and the same row-derived ids.
      //
      // ⚠ THIS ROW CARRIES NO TEXT TODAY, AND SAYING SO IS THE POINT. The trace text comes off
      // `AICallMetadata`, written by `AIRouter._record_trace_text` — and STT does not go through
      // `AIRouter` at all (`app/stt.py` is its own path with no task span). So `prompt_text` and
      // `response_text` are both absent and the row is metadata only: which call, which model,
      // how long it took, whether it worked.
      //
      // THE EARLIER CUT STORED THE TRANSCRIPT HERE, AND THAT WAS THE WORST INSTANCE OF THE BUG
      // this call site now avoids: the transcript is the worker's SPOKEN WORDS, straight off the
      // provider with nothing taken out, and it was being written into `response_enc` verbatim.
      // The transcript's system of record is `voice_notes.transcript_text`; a second, differently
      // gated copy of it was never worth having, and an unpseudonymized one certainly was not.
      //
      // WIRED ANYWAY, and not deleted: the cost row and the trace row must stay 1:1 across all
      // six surfaces (that symmetry is what `ai-cost-coverage.test.ts` and the six-call-site
      // review both lean on), and the metadata a failed transcription leaves behind is exactly
      // what a "why did this note come back empty" question needs. If STT is ever routed through
      // `AIRouter`, this line starts carrying masked text with no edit here.
      await this.aiTraces.capture(
        result.ai_metadata ?? null,
        "stt_transcription",
        aiJobId,
        correlationId,
        { workerId: ownerId, sessionId: note.sessionId },
      );

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
      // USAGE ON THE JOB ROW, AND IT WAS MISSING FOR EVERY TRANSCRIPTION EVER RUN.
      //
      // `markCompleted` has taken an optional `usage` since the extraction path needed it;
      // this call site passed none, so `ai_jobs.cost_inr` / `model_name` / the three token
      // columns stayed permanently NULL for `job_type = 'transcription'` — while the cost of
      // the SAME call was being emitted to the event spine eleven lines above. Anything asking
      // the jobs table "what did transcription cost?" got NULL, which reads as free.
      //
      // The mapper is shared (`ai/ai-job-usage.ts`) rather than re-implemented: it used to be
      // private to `ProfileExtractionProcessor`, and being unreachable from here is precisely
      // why this line was written without it. It returns `undefined` on null metadata, so the
      // mock / blocked / unreachable paths still leave the columns null rather than writing a
      // zero that cannot be told apart from a real free call.
      await this.aiJobs.markCompleted(
        aiJobId,
        { voice_note_id: voiceNoteId },
        toAiJobUsage(result.ai_metadata ?? null),
      );

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
