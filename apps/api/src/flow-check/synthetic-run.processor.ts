import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger, type OnApplicationBootstrap } from "@nestjs/common";
import type { Queue } from "bullmq";

import {
  FLOW_SYNTHETIC_RUN_QUEUE,
  FLOW_SYNTHETIC_RUN_SCHEDULER_ID,
} from "../queue/queue.constants";
import { SyntheticRunService } from "./synthetic-run.service";

/**
 * 23:00 UTC = 04:30 IST: before the flow check (05:00 IST), off-peak, after Campus's nightly check.
 * In UTC so the tick does not depend on the box's time-zone data.
 */
export const FLOW_SYNTHETIC_RUN_CRON_UTC = "0 23 * * *";

/**
 * #2967 — the daily synthetic run's CLOCK (the flow check's architecture). What a tick does is
 * {@link SyntheticRunService.runAndRecord}; this class only registers the tick and runs it.
 * Registered whatever the switch says (off: a tick returns at once); a registration failure logs one
 * warning and never fails boot. Each tick is one rolled-back walk, so a duplicated Redis job is
 * harmless: the day's alert is keyed on the IST day.
 */
@Processor(FLOW_SYNTHETIC_RUN_QUEUE)
export class SyntheticRunProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(SyntheticRunProcessor.name);

  constructor(
    private readonly synthetic: SyntheticRunService,
    @InjectQueue(FLOW_SYNTHETIC_RUN_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.queue.upsertJobScheduler(FLOW_SYNTHETIC_RUN_SCHEDULER_ID, {
        pattern: FLOW_SYNTHETIC_RUN_CRON_UTC,
        tz: "UTC",
      });
    } catch (err) {
      this.logger.warn(
        `synthetic run scheduler registration failed; a previously-registered scheduler keeps ` +
          `ticking and the next boot re-asserts it (reason: ${
            err instanceof Error ? err.name : "unknown"
          })`,
      );
    }
  }

  async process() {
    return this.synthetic.runAndRecord(new Date(), "schedule");
  }
}
