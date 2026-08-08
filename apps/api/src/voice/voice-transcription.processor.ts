import { Processor, WorkerHost } from "@nestjs/bullmq";
import type { Job } from "bullmq";
import { VoiceTranscriptionService } from "./voice-transcription.service";
import {
  VOICE_TRANSCRIPTION_QUEUE,
  type VoiceTranscriptionJobData,
} from "../queue/queue.constants";

/**
 * The BullMQ ADAPTER for voice transcription — and nothing else.
 *
 * Everything this used to do lives in {@link VoiceTranscriptionService} now (CLAUDE.md §4:
 * business logic belongs in a service, not a queue handler). What is left is the three facts
 * only BullMQ knows:
 *
 *   1. the job payload,
 *   2. whether this attempt is the LAST one — `attemptsMade` is zero-based, so attempt N of
 *      `opts.attempts` is final when `attemptsMade + 1 >= attempts`; the service needs the
 *      answer to decide whether to write the terminal record, and cannot derive it,
 *   3. that a thrown error is how a failure is reported back to the queue.
 *
 * `opts.attempts ?? 1` keeps the old defensive default: a queue configured with no explicit
 * attempt count retries nothing, so the first failure is final and the terminal record is
 * written rather than lost.
 */
@Processor(VOICE_TRANSCRIPTION_QUEUE)
export class VoiceTranscriptionProcessor extends WorkerHost {
  constructor(private readonly transcription: VoiceTranscriptionService) {
    super();
  }

  async process(job: Job<VoiceTranscriptionJobData>): Promise<{ voice_note_id: string }> {
    const maxAttempts = job.opts.attempts ?? 1;
    return this.transcription.transcribe(job.data, {
      terminal: job.attemptsMade + 1 >= maxAttempts,
    });
  }
}
