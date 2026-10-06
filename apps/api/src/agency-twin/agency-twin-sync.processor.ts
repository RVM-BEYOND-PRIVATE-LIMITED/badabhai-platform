import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger, type OnApplicationBootstrap } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import {
  AGENCY_TWIN_POLL_EVERY_MS,
  AGENCY_TWIN_POLL_JOB,
  AGENCY_TWIN_POLL_SCHEDULER_ID,
  AGENCY_TWIN_SWEEP_EVERY_MS,
  AGENCY_TWIN_SWEEP_JOB,
  AGENCY_TWIN_SWEEP_SCHEDULER_ID,
  AGENCY_TWIN_SYNC_QUEUE,
} from "../queue/queue.constants";
import { AgencyTwinService, type AgencyTwinTickSummary } from "./agency-twin.service";

/**
 * ADR-0050 §5 — the clocks of the agency-twin sync. A repeatable BullMQ job is only a tick: the
 * work list is the `events` window (poll) or the agency `jobs` table (sweep), and every decision
 * lives in {@link AgencyTwinService}. Same architecture as the reach-widen expiry sweep:
 * schedulers are re-asserted idempotently at every boot, and a registration failure logs one
 * warn and never fails boot (a previously-registered scheduler keeps ticking).
 *
 * BOTH TICKS ARE REGISTERED WHETHER OR NOT THE SYNC IS ARMED: disarmed, the sweep tick is how the
 * kill switch pauses twins, and the poll tick is a no-op.
 */
@Processor(AGENCY_TWIN_SYNC_QUEUE)
export class AgencyTwinSyncProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(AgencyTwinSyncProcessor.name);

  constructor(
    private readonly twins: AgencyTwinService,
    @InjectQueue(AGENCY_TWIN_SYNC_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    const schedulers: Array<[string, number, string]> = [
      [AGENCY_TWIN_POLL_SCHEDULER_ID, AGENCY_TWIN_POLL_EVERY_MS, AGENCY_TWIN_POLL_JOB],
      [AGENCY_TWIN_SWEEP_SCHEDULER_ID, AGENCY_TWIN_SWEEP_EVERY_MS, AGENCY_TWIN_SWEEP_JOB],
    ];
    for (const [id, every, name] of schedulers) {
      try {
        await this.queue.upsertJobScheduler(id, { every }, { name });
      } catch (err) {
        this.logger.warn(
          `agency-twin scheduler ${id} registration failed — not (re-)registered by this ` +
            `process; a previously-registered scheduler keeps ticking and the next boot ` +
            `re-asserts it (reason: ${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
  }

  /** One tick, dispatched by job name. Counts only in the log. */
  async process(job: Job): Promise<AgencyTwinTickSummary> {
    const summary =
      job.name === AGENCY_TWIN_SWEEP_JOB
        ? await this.twins.sweep()
        : await this.twins.pollRecentEvents();
    if (summary.written + summary.disarmed + summary.failed + summary.blocked > 0) {
      this.logger.log(
        `agency-twin ${job.name}: armed=${summary.armed} jobs=${summary.jobs} ` +
          `written=${summary.written} unchanged=${summary.unchanged} blocked=${summary.blocked} ` +
          `failed=${summary.failed} disarmed=${summary.disarmed}`,
      );
    }
    return summary;
  }
}
