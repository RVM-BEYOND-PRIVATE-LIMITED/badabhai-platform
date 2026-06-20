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
import { ProfilesRepository } from "./profiles.repository";
import { AiJobsRepository } from "./ai-jobs.repository";
import {
  PROFILE_EXTRACTION_QUEUE,
  RESUME_GENERATE_QUEUE,
  type ProfileExtractionJobData,
  type ResumeGenerateJobData,
} from "../queue/queue.constants";
import type { ExtractProfileInput, ConfirmProfileInput } from "./profiles.dto";

@Injectable()
export class ProfilesService {
  private readonly logger = new Logger(ProfilesService.name);

  constructor(
    private readonly profiles: ProfilesRepository,
    private readonly aiJobs: AiJobsRepository,
    private readonly workers: WorkersRepository,
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
   */
  async extract(input: ExtractProfileInput, ctx: RequestContext) {
    const worker = await this.workers.findById(input.worker_id);
    if (!worker) throw new NotFoundException(`Worker ${input.worker_id} not found`);

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
