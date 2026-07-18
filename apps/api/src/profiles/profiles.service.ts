import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { WorkersRepository } from "../workers/workers.repository";
import { ChatRepository } from "../chat/chat.repository";
import { ProfilesRepository } from "./profiles.repository";
import { AiJobsRepository } from "./ai-jobs.repository";
import {
  PROFILE_EXTRACTION_QUEUE,
  RESUME_GENERATE_QUEUE,
  type ProfileExtractionJobData,
  type ResumeGenerateJobData,
} from "../queue/queue.constants";
import type { ExtractProfileInput, ConfirmProfileInput } from "./profiles.dto";
import { hasExtractedContent } from "./profile-content";

/**
 * How long a `queued`/`running` extraction job is believed to be genuinely in
 * flight. Older than this it is treated as a zombie and a fresh extraction is
 * allowed (issue #420 review).
 *
 * 10 minutes is ~20x the longest legitimate lifecycle: the AI call has an 8s
 * timeout (`AiService.post`) and BullMQ retries it at most 3 times with 1s
 * exponential backoff (`queue.module.ts`), so a healthy job reaches a terminal
 * status in well under a minute. Nothing reaps stuck ai_jobs, and `extract`
 * INSERTs `queued` before enqueueing — a crash in that window strands a row that
 * no processor will ever touch. The window must therefore be comfortably longer
 * than any real run (so a slow-but-live job is never double-enqueued) and short
 * enough that a stranded session self-heals on a later tap rather than never.
 */
export const EXTRACTION_IN_FLIGHT_WINDOW_MS = 10 * 60 * 1000;

@Injectable()
export class ProfilesService {
  private readonly logger = new Logger(ProfilesService.name);

  constructor(
    private readonly profiles: ProfilesRepository,
    private readonly aiJobs: AiJobsRepository,
    private readonly workers: WorkersRepository,
    // Issue #435 — resolves the body-supplied session so extract() can verify the
    // caller OWNS it. ProfilesModule already imports ChatModule (forwardRef) for this
    // very repository (the processor reads transcripts through it), so this introduces
    // no new module edge and no new cycle.
    private readonly chat: ChatRepository,
    private readonly events: EventsService,
    @InjectQueue(PROFILE_EXTRACTION_QUEUE)
    private readonly extractionQueue: Queue<ProfileExtractionJobData>,
    @InjectQueue(RESUME_GENERATE_QUEUE)
    private readonly resumeGenerateQueue: Queue<ResumeGenerateJobData>,
  ) {}

  /**
   * Enqueue an async profile-extraction job (BullMQ/Redis). Returns immediately
   * with the ai_job_id; the client polls `GET /ai-jobs/:id` until completed,
   * then reads `output_ref.profile_id`. The work itself runs in
   * ProfileExtractionProcessor (which emits extraction_completed/failed).
   *
   * Session-scoped idempotency (issue #420): two independent triggers fire for
   * the same interview — the server auto-trigger in ChatService on the
   * `extraction_ready` flip, and the worker app's unconditional
   * `POST /profile/extract` on the profile-preview screen. Without a guard that
   * is 2 ai_jobs + up to 2 worker_profiles per normal completion.
   *
   * A prior job for the same (worker, session) suppresses a new one ONLY when it
   * is genuinely redundant. Every other case must still create, because being
   * wrong in that direction leaves a worker with no profile at all — strictly
   * worse than the double spend this guards:
   *  - `failed` → never dedupes; retry stays possible.
   *  - stale `queued`/`running` (older than EXTRACTION_IN_FLIGHT_WINDOW_MS) →
   *    never dedupes; treated as a zombie, since nothing reaps stuck ai_jobs.
   *  - `completed` but with an EMPTY profile (the AI-down fallback persists one
   *    with status "extracted") → never dedupes; see `hasExtractedContent`.
   *  - null `session_id` → create-always. There is no session to scope to, and
   *    deduping null-against-null would collapse genuinely unrelated calls.
   */
  async extract(input: ExtractProfileInput, ctx: RequestContext) {
    const worker = await this.workers.findById(input.worker_id);
    if (!worker) throw new NotFoundException(`Worker ${input.worker_id} not found`);

    const sessionId = input.session_id ?? null;
    if (sessionId) {
      // OWNERSHIP (issue #435). `session_id` arrives from the REQUEST BODY, so without
      // this a worker could pass someone else's session id: the job is created with
      // `input_ref = { worker_id: caller, session_id: victim's }`, and
      // ProfileExtractionProcessor.buildTranscript then reads the VICTIM's chat
      // transcript and extracts it into the CALLER's worker_profiles row. Their trade,
      // machines, experience, salary and location become the caller's profile, and
      // because both the job and the profile are attributable to the caller nothing
      // downstream flags it.
      //
      // 404 (not 403), matching ChatService.postMessage exactly, so a session id is
      // never an existence oracle for another worker's session — a miss and a
      // not-owned are byte-identical.
      //
      // Checked BEFORE the dedupe lookup below so a foreign id cannot be probed
      // through dedupe behaviour either.
      const session = await this.chat.findSession(sessionId);
      if (!session || session.workerId !== input.worker_id) {
        throw new NotFoundException(`Session ${sessionId} not found`);
      }

      const existing = await this.aiJobs.findExtractionDedupeCandidate({
        sessionId,
        workerId: input.worker_id,
        inFlightSince: new Date(Date.now() - EXTRACTION_IN_FLIGHT_WINDOW_MS),
      });
      // A completed job only counts if it actually produced something. An empty
      // profile from the AI-down fallback must NOT pin the session forever.
      const usable =
        existing !== undefined &&
        (existing.status !== "completed" || hasExtractedContent(existing.profile));

      if (existing && usable) {
        // No second `profile.extraction_requested`: one event per extraction
        // actually requested of the AI, otherwise the event spine over-reports
        // spend. The skip itself is logged (opaque UUIDs only, no PII).
        this.logger.log(
          `extract deduped session=${sessionId} worker=${input.worker_id} ` +
            `existing_ai_job=${existing.id} status=${existing.status}`,
        );
        return { ai_job_id: existing.id, status: existing.status };
      }
      if (existing) {
        this.logger.log(
          `extract re-running session=${sessionId} worker=${input.worker_id}: prior ai_job ` +
            `${existing.id} completed with an empty profile`,
        );
      }
    }

    const job = await this.aiJobs.create({
      jobType: "profile_extraction",
      status: "queued",
      inputRef: { worker_id: input.worker_id, session_id: input.session_id ?? null },
    });

    await this.events.emit({
      event_name: "profile.extraction_requested",
      actor: { actor_type: "worker", actor_id: input.worker_id },
      subject: { subject_type: "ai_job", subject_id: job.id },
      payload: {
        worker_id: input.worker_id,
        session_id: input.session_id ?? null,
        ai_job_id: job.id,
      },
      idempotencyKey: `profile.extraction_requested:${job.id}`,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    // If enqueue fails (e.g. Redis down), give the job a terminal state so it is
    // not orphaned in "queued" and the requested event is balanced by a failed.
    try {
      await this.extractionQueue.add("extract", {
        workerId: input.worker_id,
        sessionId: input.session_id ?? null,
        aiJobId: job.id,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
    } catch (err) {
      const reason = `enqueue failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 240)}`;
      await this.aiJobs.markFailed(job.id, reason);
      await this.events.emit({
        event_name: "profile.extraction_failed",
        actor: { actor_type: "system" },
        subject: { subject_type: "ai_job", subject_id: job.id },
        payload: {
          worker_id: input.worker_id,
          session_id: input.session_id ?? null,
          ai_job_id: job.id,
          reason,
        },
        // One terminal failure per job. Shares the key namespace with the
        // processor's terminal-failure emit: a job fails EITHER at enqueue here OR
        // in the processor, never both, so at most one row is ever written.
        idempotencyKey: `profile.extraction_failed:${job.id}`,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
      throw new ServiceUnavailableException("Could not enqueue extraction job; please retry");
    }

    return { ai_job_id: job.id, status: "queued" as const };
  }

  async confirm(input: ConfirmProfileInput, ctx: RequestContext) {
    const profile = await this.profiles.findById(input.profile_id);
    // Ownership: a worker may only confirm their OWN profile. 404 for both
    // not-found and not-owner (no existence oracle for another worker's profile).
    if (!profile || profile.workerId !== input.worker_id) {
      throw new NotFoundException(`Profile ${input.profile_id} not found`);
    }

    const confirmedAt = new Date();
    await this.profiles.confirm(input.profile_id, confirmedAt);

    await this.events.emit({
      event_name: "profile.confirmed",
      actor: { actor_type: "worker", actor_id: input.worker_id },
      subject: { subject_type: "profile", subject_id: input.profile_id },
      payload: {
        worker_id: input.worker_id,
        profile_id: input.profile_id,
        confirmed_at: confirmedAt.toISOString(),
      },
      idempotencyKey: `profile.confirmed:${input.profile_id}`,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    // Kick off async resume generation (refs only, no PII). A queue failure must
    // NEVER break confirmation — the worker can still trigger generation manually
    // via POST /resume/generate. Log a warning and move on.
    try {
      await this.resumeGenerateQueue.add("generate", {
        workerId: input.worker_id,
        profileId: input.profile_id,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
    } catch (err) {
      this.logger.warn(
        `could not enqueue resume generation for profile ${input.profile_id} (reason: ${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }

    return {
      profile_id: input.profile_id,
      profile_status: "confirmed",
      confirmed_at: confirmedAt.toISOString(),
    };
  }
}
