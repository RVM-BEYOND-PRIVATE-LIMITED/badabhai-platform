import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger, type OnApplicationBootstrap } from "@nestjs/common";
import type { Queue } from "bullmq";

import {
  STILL_LOOKING_SWEEP_QUEUE,
  STILL_LOOKING_SWEEP_SCHEDULER_ID,
} from "../queue/queue.constants";
import { StillLookingService, type StillLookingSweepResult } from "./still-looking.service";

/** Once a day. The check is monthly; a daily tick means nobody waits more than a day past due. */
export const STILL_LOOKING_SWEEP_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * #2753 item 5 — the monthly "still looking?" sweep's CLOCK. A repeatable BullMQ job with no
 * payload (the reach-widen expiry sweep's architecture): the predicate over `workers` and
 * `still_looking_checks` is the work list, so a lost or duplicated Redis job is harmless, and the
 * open-check unique index makes two ticks racing open one check per worker. What a tick does is
 * {@link StillLookingService.sweep}; this class only registers the tick and runs it.
 *
 * REGISTERED WHATEVER THE SWITCH SAYS. With `STILL_LOOKING_CHECK_ENABLED` off a tick returns at
 * once and names no table, so turning the switch on needs no redeploy-time registration. A
 * registration failure logs one warning and never fails boot (a previously-registered scheduler
 * keeps ticking; the next boot re-asserts it).
 */
@Processor(STILL_LOOKING_SWEEP_QUEUE)
export class StillLookingSweepProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(StillLookingSweepProcessor.name);

  constructor(
    private readonly stillLooking: StillLookingService,
    @InjectQueue(STILL_LOOKING_SWEEP_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  /** Register the daily tick. Idempotent by scheduler id; a failure never fails boot. */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.queue.upsertJobScheduler(STILL_LOOKING_SWEEP_SCHEDULER_ID, {
        every: STILL_LOOKING_SWEEP_EVERY_MS,
      });
    } catch (err) {
      this.logger.warn(
        `still-looking sweep scheduler registration failed; a previously-registered scheduler ` +
          `keeps ticking and the next boot re-asserts it (reason: ${
            err instanceof Error ? err.name : "unknown"
          })`,
      );
    }
  }

  /** One tick. */
  async process(): Promise<StillLookingSweepResult> {
    return this.stillLooking.sweep(new Date());
  }
}
