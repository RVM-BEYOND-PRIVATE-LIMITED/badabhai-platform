import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { LEARN_LABELS_QUEUE, LEARN_LABELS_SWEEP_SCHEDULER_ID } from "../queue/queue.constants";
import { LearnLabelsService } from "./learn-labels.service";

/** What one tick did — counts only (BullMQ job-inspection surface, no ids). */
export interface LearnLabelsSweepResult {
  dryRun: boolean;
  pendingEvents: number;
  impressionsIngested: number;
  submittedResolved: number;
  skippedResolved: number;
  skippedEvents: number;
}

/**
 * LEARN label producer sweep — the clock that drains spine events into
 * `learn_labels` (migration 0091). The DECISIONS live in
 * {@link LearnLabelsService.processBatch}; this processor only registers a repeatable
 * tick, arms/disarms on config, bounds the batch, and logs counts.
 *
 * ARCHITECTURE mirrors the PERF-3 retention + widen-expiry sweeps exactly: the cursor +
 * UNIQUE-key idempotency in the store is authoritative, so a lost/duplicated Redis job
 * is harmless. Registration failures log one loud warn and never fail boot.
 *
 * DRY-RUN FIRST (launch-gate pattern): while `LEARN_LABELS_ENABLED` is false every tick
 * only LOGS the pending-event count and writes NOTHING. Flipping the flag is the
 * explicit act that arms label production.
 */
@Processor(LEARN_LABELS_QUEUE)
export class LearnLabelsSweepProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(LearnLabelsSweepProcessor.name);

  constructor(
    private readonly learn: LearnLabelsService,
    @InjectQueue(LEARN_LABELS_QUEUE) private readonly queue: Queue,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {
    super();
  }

  /** Register the repeatable tick at boot; idempotent by scheduler id. */
  async onApplicationBootstrap(): Promise<void> {
    const every = this.config.LEARN_LABELS_SWEEP_INTERVAL_HOURS * 3_600_000;
    try {
      await this.queue.upsertJobScheduler(LEARN_LABELS_SWEEP_SCHEDULER_ID, { every });
    } catch (err) {
      this.logger.warn(
        `learn-labels sweep scheduler registration failed — label production is not ` +
          `(re-)registered by this process; a previously-registered scheduler keeps ticking ` +
          `and the next boot re-asserts it (reason: ${
            err instanceof Error ? err.message : String(err)
          })`,
      );
    }
  }

  async process(): Promise<LearnLabelsSweepResult> {
    const armed = this.config.LEARN_LABELS_ENABLED;
    const batchLimit = this.config.LEARN_LABELS_BATCH_LIMIT;

    if (!armed) {
      const pending = await this.learn.countPending();
      // Counts only — never ids.
      this.logger.log(`learn-labels sweep DRY-RUN (writing nothing): pending_events=${pending}`);
      return {
        dryRun: true,
        pendingEvents: pending,
        impressionsIngested: 0,
        submittedResolved: 0,
        skippedResolved: 0,
        skippedEvents: 0,
      };
    }

    const summary = await this.learn.processBatch(batchLimit);
    this.logger.log(
      `learn-labels sweep ARMED: ingested=${summary.impressionsIngested} ` +
        `applied=${summary.submittedResolved} skipped=${summary.skippedResolved} ` +
        `not_applicable=${summary.skippedEvents}`,
    );
    return { dryRun: false, pendingEvents: -1, ...summary };
  }
}
