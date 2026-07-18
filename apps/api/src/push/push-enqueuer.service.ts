import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { PUSH_QUEUE, type PushJobData } from "../queue/queue.constants";

/**
 * The PRODUCER side of worker push (ADR-0034) — deliberately the whole surface a
 * producer needs, and nothing more.
 *
 * WHY IT IS ITS OWN TINY SERVICE: the producers live in the auth domain
 * (`DevicesService.registerOnLogin`, `SessionService.revokeAll`) while the consumer
 * (`PushProcessor`) needs device data that lives in the auth module. Having auth depend
 * on the full push module — and push depend back on auth — would be a cycle. So auth
 * depends only on THIS (which knows nothing but the queue), and the processor module
 * depends on auth. The seam is a BullMQ queue, exactly like the resume-render producer.
 *
 * BEST-EFFORT BY CONTRACT: `enqueue` never throws. A push is a courtesy on top of the
 * operation that triggered it — a queue outage must never fail a worker's login or, far
 * worse, their "log out everywhere". Callers are not expected to try/catch.
 *
 * §2: only refs cross this seam (worker id, event id, opaque device row ids). No push
 * token, no copy, no name — see {@link PushJobData}.
 */
@Injectable()
export class PushEnqueuer {
  private readonly logger = new Logger(PushEnqueuer.name);

  constructor(@InjectQueue(PUSH_QUEUE) private readonly queue: Queue<PushJobData>) {}

  async enqueue(data: PushJobData): Promise<void> {
    // Nothing to deliver to — skip the round-trip rather than queue a no-op job.
    if (data.deviceIds.length === 0) return;
    try {
      await this.queue.add("push", data, {
        // One job per (event, worker): a double-emit of the same source event must not
        // fan out twice. push_deliveries is still the per-device backstop.
        jobId: `push:${data.sourceEventId}:${data.workerId}`,
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: true,
      });
    } catch (err) {
      // PII-free: names only the worker + the reason class, never a token or copy.
      this.logger.warn(
        `could not enqueue push for worker ${data.workerId} (reason: ${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }
  }
}
