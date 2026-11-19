import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger, type OnApplicationBootstrap } from "@nestjs/common";
import type { Queue } from "bullmq";

import {
  RAZORPAY_RECONCILE_QUEUE,
  RAZORPAY_RECONCILE_SCHEDULER_ID,
} from "../queue/queue.constants";
import {
  RazorpayReconcileService,
  type RazorpayReconcileResult,
} from "./razorpay-reconcile.service";

/** Once a day (each run reads 48 hours, so the windows overlap). */
export const RAZORPAY_RECONCILE_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * #2773 — the nightly Razorpay reconciliation's CLOCK. A repeatable BullMQ job with no payload
 * (the credit balance audit's architecture, #2774): each run is a read-only comparison over an
 * overlapping window, so a lost or duplicated Redis job is harmless and the alert's per-day key
 * raises it once. What a tick does is {@link RazorpayReconcileService.run}; this class only
 * registers the tick and runs it.
 *
 * REGISTERED WHATEVER THE SWITCH SAYS. With `RAZORPAY_RECONCILE_ENABLED` off a tick returns at
 * once without a call or a query, so turning the switch on needs no redeploy-time registration.
 * A registration failure logs one warning and never fails boot.
 */
@Processor(RAZORPAY_RECONCILE_QUEUE)
export class RazorpayReconcileProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(RazorpayReconcileProcessor.name);

  constructor(
    private readonly reconcile: RazorpayReconcileService,
    @InjectQueue(RAZORPAY_RECONCILE_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  /** Register the daily tick. Idempotent by scheduler id; a failure never fails boot. */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.queue.upsertJobScheduler(RAZORPAY_RECONCILE_SCHEDULER_ID, {
        every: RAZORPAY_RECONCILE_EVERY_MS,
      });
    } catch (err) {
      this.logger.warn(
        `razorpay reconciliation scheduler registration failed; a previously-registered ` +
          `scheduler keeps ticking and the next boot re-asserts it (reason: ${
            err instanceof Error ? err.name : "unknown"
          })`,
      );
    }
  }

  /** One tick. */
  async process(): Promise<RazorpayReconcileResult> {
    return this.reconcile.run(new Date());
  }
}
