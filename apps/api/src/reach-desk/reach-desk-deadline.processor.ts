import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger, type OnApplicationBootstrap } from "@nestjs/common";
import type { Queue } from "bullmq";
import {
  REACH_DESK_DEADLINE_QUEUE,
  REACH_DESK_DEADLINE_SCHEDULER_ID,
} from "../queue/queue.constants";
import { ReachDeskService, type ReachDeadlineSweepResult } from "./reach-desk.service";

/** How often the deadline sweep ticks. The desk window is 48 hours, so 15 minutes is ample. */
export const REACH_DEADLINE_SWEEP_EVERY_MS = 15 * 60 * 1000;
/** Cases closed per tick at most; the rest wait for the next tick. */
export const REACH_DEADLINE_SWEEP_BATCH = 200;

/**
 * #2750 item 7 — the couldn't-reach deadline sweep's clock. Each tick asks
 * {@link ReachDeskService.sweepDeadlines} to close the open cases past their deadline as not
 * reached (credits back), one per transaction. The service does nothing while the `credit_rules`
 * switch is off everywhere. No env var: the interval and the batch are fixed here.
 */
@Processor(REACH_DESK_DEADLINE_QUEUE)
export class ReachDeskDeadlineProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReachDeskDeadlineProcessor.name);

  constructor(
    private readonly desk: ReachDeskService,
    @InjectQueue(REACH_DESK_DEADLINE_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  /** Register the repeatable tick at boot; idempotent by scheduler id (no duplicates on reboot). */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.queue.upsertJobScheduler(REACH_DESK_DEADLINE_SCHEDULER_ID, {
        every: REACH_DEADLINE_SWEEP_EVERY_MS,
      });
    } catch (err) {
      this.logger.warn(
        `reach-desk deadline sweep scheduler registration failed; a previously-registered ` +
          `scheduler keeps ticking and the next boot re-asserts it ` +
          `(reason: ${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  async process(): Promise<ReachDeadlineSweepResult> {
    const result = await this.desk.sweepDeadlines(REACH_DEADLINE_SWEEP_BATCH);
    if (!result.skipped && result.due > 0) {
      this.logger.log(
        `reach-desk deadline sweep: due=${result.due} closed=${result.closed} failed=${result.failed}`,
      );
    }
    return result;
  }
}
