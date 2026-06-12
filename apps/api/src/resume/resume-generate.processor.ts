import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import type { RequestContext } from "../common/request-context";
import { WorkersRepository } from "../workers/workers.repository";
import { ResumeService } from "./resume.service";
import { RESUME_GENERATE_QUEUE, type ResumeGenerateJobData } from "../queue/queue.constants";

/**
 * Auto-generates a resume off the request path after a profile is confirmed
 * (enqueued by ProfilesService). Idempotent: if the worker already has a resume,
 * skip — confirmation can be re-emitted under retries, and the manual
 * `POST /resume/generate` path may have run first. Tracing ids are carried from
 * the originating request so the generated event stays correlated.
 */
@Processor(RESUME_GENERATE_QUEUE)
export class ResumeGenerateProcessor extends WorkerHost {
  private readonly logger = new Logger(ResumeGenerateProcessor.name);

  constructor(
    private readonly resumeService: ResumeService,
    private readonly workers: WorkersRepository,
  ) {
    super();
  }

  async process(job: Job<ResumeGenerateJobData>): Promise<{ skipped: boolean }> {
    const { workerId, profileId, correlationId, requestId } = job.data;

    // Pre-generate idempotency: one resume per worker is enough for the auto path.
    const existing = await this.workers.latestResume(workerId);
    if (existing) {
      this.logger.log(`worker ${workerId} already has a resume; skipping auto-generate`);
      return { skipped: true };
    }

    const ctx: RequestContext = { correlationId, requestId };
    // System-initiated: skip the per-worker abuse cap (one-per-worker + idempotent),
    // but the global spend backstop still applies.
    await this.resumeService.generate(
      { worker_id: workerId, profile_id: profileId },
      ctx,
      { systemInitiated: true },
    );
    return { skipped: false };
  }
}
