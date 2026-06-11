import {
  BadRequestException,
  Injectable,
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
  type ProfileExtractionJobData,
} from "../queue/queue.constants";
import type { ExtractProfileDto, ConfirmProfileDto } from "./profiles.dto";

@Injectable()
export class ProfilesService {
  constructor(
    private readonly profiles: ProfilesRepository,
    private readonly aiJobs: AiJobsRepository,
    private readonly workers: WorkersRepository,
    private readonly events: EventsService,
    @InjectQueue(PROFILE_EXTRACTION_QUEUE)
    private readonly extractionQueue: Queue<ProfileExtractionJobData>,
  ) {}

  /**
   * Enqueue an async profile-extraction job (BullMQ/Redis). Returns immediately
   * with the ai_job_id; the client polls `GET /ai-jobs/:id` until completed,
   * then reads `output_ref.profile_id`. The work itself runs in
   * ProfileExtractionProcessor (which emits extraction_completed/failed).
   */
  async extract(dto: ExtractProfileDto, ctx: RequestContext) {
    const worker = await this.workers.findById(dto.worker_id);
    if (!worker) throw new NotFoundException(`Worker ${dto.worker_id} not found`);

    const job = await this.aiJobs.create({
      jobType: "profile_extraction",
      status: "queued",
      inputRef: { worker_id: dto.worker_id, session_id: dto.session_id ?? null },
    });

    await this.events.emit({
      event_name: "profile.extraction_requested",
      actor: { actor_type: "worker", actor_id: dto.worker_id },
      subject: { subject_type: "ai_job", subject_id: job.id },
      payload: {
        worker_id: dto.worker_id,
        session_id: dto.session_id ?? null,
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
        workerId: dto.worker_id,
        sessionId: dto.session_id ?? null,
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
          worker_id: dto.worker_id,
          session_id: dto.session_id ?? null,
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

  async confirm(dto: ConfirmProfileDto, ctx: RequestContext) {
    const profile = await this.profiles.findById(dto.profile_id);
    if (!profile) throw new NotFoundException(`Profile ${dto.profile_id} not found`);
    if (profile.workerId !== dto.worker_id) {
      throw new BadRequestException("worker_id does not match the profile owner");
    }

    const confirmedAt = new Date();
    await this.profiles.confirm(dto.profile_id, confirmedAt);

    await this.events.emit({
      event_name: "profile.confirmed",
      actor: { actor_type: "worker", actor_id: dto.worker_id },
      subject: { subject_type: "profile", subject_id: dto.profile_id },
      payload: {
        worker_id: dto.worker_id,
        profile_id: dto.profile_id,
        confirmed_at: confirmedAt.toISOString(),
      },
      idempotencyKey: `profile.confirmed:${dto.profile_id}`,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    return {
      profile_id: dto.profile_id,
      profile_status: "confirmed",
      confirmed_at: confirmedAt.toISOString(),
    };
  }
}
