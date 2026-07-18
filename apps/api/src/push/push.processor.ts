import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { PUSH_QUEUE, type PushJobData } from "../queue/queue.constants";
import { PushService } from "./push.service";

/**
 * Delivers worker pushes off the request path (ADR-0034).
 *
 * Thin by design: all policy (allowlist, kill-switch, targeting, dedupe, token
 * invalidation, events) lives in {@link PushService} so it is unit-testable without
 * BullMQ. This class only adapts the queue to that call.
 *
 * A thrown error lets BullMQ retry with backoff. That is safe because
 * `PushRepository.claim` is insert-first: a retry after a partial run re-claims nothing
 * already delivered, so no worker is buzzed twice.
 */
@Processor(PUSH_QUEUE)
export class PushProcessor extends WorkerHost {
  private readonly logger = new Logger(PushProcessor.name);

  constructor(private readonly push: PushService) {
    super();
  }

  async process(job: Job<PushJobData>): Promise<{ sent: number }> {
    try {
      return await this.push.deliver(job.data);
    } catch (err) {
      // PII-free: the worker id + a reason class, never a token or the copy.
      this.logger.warn(
        `push delivery failed for worker ${job.data.workerId} (reason: ${
          err instanceof Error ? err.message : "unknown"
        })`,
      );
      throw err;
    }
  }
}
