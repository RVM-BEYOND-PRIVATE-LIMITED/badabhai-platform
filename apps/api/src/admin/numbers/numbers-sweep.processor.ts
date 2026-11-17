import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger, type OnApplicationBootstrap } from "@nestjs/common";
import type { Queue } from "bullmq";

import {
  NUMBERS_WEEKLY_SWEEP_QUEUE,
  NUMBERS_WEEKLY_SWEEP_SCHEDULER_ID,
} from "../../queue/queue.constants";
import { NumbersSnapshotService, type NumbersSweepResult } from "./numbers-snapshot.service";

/** Once a day: the current week moves daily, and a week freezes whole days after it ends. */
export const NUMBERS_WEEKLY_SWEEP_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * #2755 item 4 — the nightly numbers sweep's CLOCK. A repeatable BullMQ job with no payload (the
 * still-looking sweep's architecture): the weeks not yet frozen are the work list, so a lost or
 * duplicated Redis job is harmless, and each week's advisory lock makes two ticks racing leave one
 * set of rows. What a tick does is {@link NumbersSnapshotService.sweep}; this class only registers
 * the tick and runs it.
 *
 * REGISTERED WHATEVER THE SWITCH SAYS. With `ADMIN_NUMBERS_ENABLED` off a tick returns at once and
 * names no table, so turning the switch on needs no redeploy-time registration. A registration
 * failure logs one warning and never fails boot (a previously-registered scheduler keeps ticking;
 * the next boot re-asserts it).
 */
@Processor(NUMBERS_WEEKLY_SWEEP_QUEUE)
export class NumbersSweepProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(NumbersSweepProcessor.name);

  constructor(
    private readonly snapshot: NumbersSnapshotService,
    @InjectQueue(NUMBERS_WEEKLY_SWEEP_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  /** Register the daily tick. Idempotent by scheduler id; a failure never fails boot. */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.queue.upsertJobScheduler(NUMBERS_WEEKLY_SWEEP_SCHEDULER_ID, {
        every: NUMBERS_WEEKLY_SWEEP_EVERY_MS,
      });
    } catch (err) {
      this.logger.warn(
        `numbers sweep scheduler registration failed; a previously-registered scheduler keeps ` +
          `ticking and the next boot re-asserts it (reason: ${
            err instanceof Error ? err.name : "unknown"
          })`,
      );
    }
  }

  /** One tick. */
  async process(): Promise<NumbersSweepResult> {
    return this.snapshot.sweep(new Date());
  }
}
