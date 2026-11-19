import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger, type OnApplicationBootstrap } from "@nestjs/common";
import type { Queue } from "bullmq";
import {
  MANAGED_HIRING_SWEEP_QUEUE,
  MANAGED_HIRING_SWEEP_SCHEDULER_ID,
} from "../queue/queue.constants";
import { ManagedHiringService, type ManagedHiringSweepResult } from "./managed-hiring.service";

/** How often the clock ticks. Deadlines fall at IST midnight, so a 15-minute tick is plenty. */
export const MANAGED_HIRING_SWEEP_EVERY_MS = 15 * 60 * 1000;
export const MANAGED_HIRING_SWEEP_BATCH = 200;

/**
 * #2751 item 9 — the Managed Hiring clock: a BullMQ repeatable tick that moves every open order whose
 * deadline (or free extension) has passed. The rule lives in {@link ManagedHiringService.sweepDue};
 * this only supplies the clock. Inert while `MANAGED_HIRING_ROLLOUT` is off everywhere.
 */
@Processor(MANAGED_HIRING_SWEEP_QUEUE)
export class ManagedHiringSweepProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(ManagedHiringSweepProcessor.name);

  constructor(
    private readonly managedHiring: ManagedHiringService,
    @InjectQueue(MANAGED_HIRING_SWEEP_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.queue.upsertJobScheduler(MANAGED_HIRING_SWEEP_SCHEDULER_ID, {
        every: MANAGED_HIRING_SWEEP_EVERY_MS,
      });
    } catch (err) {
      this.logger.warn(
        `managed hiring sweep scheduler registration failed; a previously-registered scheduler ` +
          `keeps ticking and the next boot re-asserts it ` +
          `(reason: ${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  async process(): Promise<ManagedHiringSweepResult> {
    const result = await this.managedHiring.sweepDue(MANAGED_HIRING_SWEEP_BATCH);
    if (!result.skipped && result.due > 0) {
      this.logger.log(
        `managed hiring sweep: due=${result.due} moved=${result.moved} failed=${result.failed}`,
      );
    }
    return result;
  }
}
