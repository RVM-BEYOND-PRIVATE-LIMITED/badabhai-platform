import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import {
  REACH_WIDEN_EXPIRY_QUEUE,
  REACH_WIDEN_EXPIRY_SWEEP_SCHEDULER_ID,
} from "../queue/queue.constants";
import { PublishReachService } from "./publish-reach.service";

/** What one tick did — counts only, no ids (BullMQ job-inspection surface). */
export interface WidenExpirySweepResult {
  dryRun: boolean;
  dueGrants: number;
  grantsRetracted: number;
  postingsShrunk: number;
  postingsSkippedNotLive: number;
}

/**
 * Policy 27 third leg — the reach-widen EXPIRY sweep ("Expiring", TD127 closure).
 *
 * An ops widen ages out at `match_config.widen_expiry_hours`; this sweep is the clock
 * that retracts it. The RETRACT decision lives entirely in
 * {@link PublishReachService.retractExpiredWidens} — protection rules, pure-subtraction
 * semantics, re-materialization, the `job_posting.reach_widen_expired` event and the
 * E12/E13 alert re-check are all documented there. This processor only registers a
 * repeatable tick, arms/disarms on config, bounds the batch, and logs counts.
 *
 * ARCHITECTURE mirrors the PERF-3 retention sweep exactly: a repeatable BullMQ job is
 * only a clock tick — the predicate over `job_reach_widen` (un-retracted + past
 * expiry) is authoritative, so a lost/duplicated Redis job is harmless. Registration
 * failures log one loud warn, never fail boot (a previously-registered scheduler keeps
 * ticking; the next boot re-asserts).
 *
 * DRY-RUN FIRST (launch-gate pattern): while `REACH_WIDEN_EXPIRY_ENABLED` is false
 * every tick only LOGS the due-grant count and retracts NOTHING. Flipping the flag is
 * the explicit act that arms retractions.
 */
@Processor(REACH_WIDEN_EXPIRY_QUEUE)
export class ReachWidenExpirySweepProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReachWidenExpirySweepProcessor.name);

  constructor(
    private readonly publishReach: PublishReachService,
    @InjectQueue(REACH_WIDEN_EXPIRY_QUEUE) private readonly queue: Queue,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {
    super();
  }

  /**
   * Register the repeatable sweep at boot. `upsertJobScheduler` is idempotent by
   * scheduler id: every boot re-asserts the SAME scheduler instead of stacking
   * duplicates. A failure is logged and swallowed — see the class doc.
   */
  async onApplicationBootstrap(): Promise<void> {
    const every = this.config.REACH_WIDEN_EXPIRY_SWEEP_INTERVAL_HOURS * 3_600_000;
    try {
      await this.queue.upsertJobScheduler(REACH_WIDEN_EXPIRY_SWEEP_SCHEDULER_ID, { every });
    } catch (err) {
      this.logger.warn(
        `widen-expiry sweep scheduler registration failed — reach-widen expiry is not ` +
          `(re-)registered by this process; a previously-registered scheduler keeps ticking ` +
          `and the next boot re-asserts it (reason: ${
            err instanceof Error ? err.message : String(err)
          })`,
      );
    }
  }

  /**
   * One sweep tick: count what is due (the dry-run report IS the armed report), then
   * retract one bounded batch when armed.
   */
  async process(): Promise<WidenExpirySweepResult> {
    const armed = this.config.REACH_WIDEN_EXPIRY_ENABLED;
    const batchLimit = this.config.REACH_WIDEN_EXPIRY_BATCH_LIMIT;
    const dueGrants = await this.publishReach.countDueWidenGrants();

    if (!armed) {
      // Counts only — never posting ids, never skill lists (none are PII, but ids in
      // logs invite dashboard drift; the spine event carries the audit detail).
      this.logger.log(`widen-expiry sweep DRY-RUN (retracting nothing): due_grants=${dueGrants}`);
      return { dryRun: true, dueGrants, grantsRetracted: 0, postingsShrunk: 0, postingsSkippedNotLive: 0 };
    }

    const summary = await this.publishReach.retractExpiredWidens(batchLimit);
    this.logger.log(
      `widen-expiry sweep ARMED: due=${dueGrants} retracted=${summary.grantsRetracted} ` +
        `postings_shrunk=${summary.postingsShrunk} skipped_not_live=${summary.postingsSkippedNotLive}`,
    );
    return { dryRun: false, dueGrants, ...summary };
  }
}
