import { Processor, WorkerHost } from "@nestjs/bullmq";
import type { Job } from "bullmq";
import { PaceService } from "./pace.service";
import { PACE_QUEUE, type PaceWaveJobData } from "./pace.constants";

/**
 * Runs a scheduled PACE wave off the request path (ADR-0021). PACE is the FIRST
 * delayed/scheduled-job consumer of the live BullMQ wiring — each wave arrives after
 * the configured `delay` (the 6–24h cadence). The service re-evaluates supply, applies
 * the deterministic widen decision, emits PII-free events, and schedules the next wave
 * (or terminates). In-process for Phase 1; splittable to its own worker later.
 *
 * The wave is safe to redeliver: the service re-reads state + recomputes supply, and
 * its `pace.*` emits are idempotency-keyed, so a BullMQ stalled-job retry cannot
 * double-emit or double-widen. A thrown error lets BullMQ retry (defaultJobOptions).
 */
@Processor(PACE_QUEUE)
export class PaceProcessor extends WorkerHost {
  constructor(private readonly pace: PaceService) {
    super();
  }

  async process(job: Job<PaceWaveJobData>): Promise<void> {
    const { jobId, correlationId, requestId } = job.data;
    await this.pace.runWave(jobId, { correlationId, requestId });
  }
}
