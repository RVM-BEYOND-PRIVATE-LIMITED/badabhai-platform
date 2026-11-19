import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger, type OnApplicationBootstrap } from "@nestjs/common";
import type { Queue } from "bullmq";

import { FLOW_CHECK_QUEUE, FLOW_CHECK_SCHEDULER_ID } from "../queue/queue.constants";
import { FlowCheckService, type FlowCheckResult } from "./flow-check.service";

/**
 * 23:30 UTC every day = 05:00 IST, after Campus's nightly applications check (03:30 IST) has had
 * time to report. In UTC so the tick does not depend on the box's time-zone data.
 */
export const FLOW_CHECK_CRON_UTC = "30 23 * * *";

/**
 * #2890 — the daily flow check's CLOCK. A repeatable BullMQ job with no payload (the credit balance
 * audit's architecture): what a tick does is {@link FlowCheckService.run}; this class only
 * registers the tick and runs it.
 *
 * REGISTERED WHATEVER THE SWITCH SAYS. With `FLOW_CHECK_ENABLED` off a tick returns at once without
 * a query, so turning the switch on needs no redeploy-time registration. A registration failure
 * logs one warning and never fails boot.
 */
@Processor(FLOW_CHECK_QUEUE)
export class FlowCheckProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(FlowCheckProcessor.name);

  constructor(
    private readonly flowCheck: FlowCheckService,
    @InjectQueue(FLOW_CHECK_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  /** Register the daily tick. Idempotent by scheduler id; a failure never fails boot. */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.queue.upsertJobScheduler(FLOW_CHECK_SCHEDULER_ID, {
        pattern: FLOW_CHECK_CRON_UTC,
        tz: "UTC",
      });
    } catch (err) {
      this.logger.warn(
        `flow check scheduler registration failed; a previously-registered scheduler keeps ` +
          `ticking and the next boot re-asserts it (reason: ${
            err instanceof Error ? err.name : "unknown"
          })`,
      );
    }
  }

  /** One tick. */
  async process(): Promise<FlowCheckResult> {
    return this.flowCheck.run(new Date());
  }
}
