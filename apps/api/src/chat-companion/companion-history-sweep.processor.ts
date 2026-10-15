import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { Queue } from "bullmq";
import {
  COMPANION_HISTORY_SWEEP_QUEUE,
  COMPANION_HISTORY_SWEEP_SCHEDULER_ID,
} from "../queue/queue.constants";
import {
  CompanionHistoryService,
  type CompanionHistorySweepResult,
} from "./companion-history.service";

/** Once a day (the owner's retention ruling is "the last 7 days", not an operational knob). */
export const COMPANION_HISTORY_SWEEP_EVERY_MS = 24 * 3_600_000;

/**
 * #2297 (ADR-0056) — THE BADA BHAI CHAT'S RETENTION SWEEP: once a day, delete every stored line
 * older than 7 days and every EXPIRED rolling summary (the newest line it covers has left the
 * window). The
 * decisions are `CompanionHistoryService.sweep`'s; this processor only registers the daily tick and
 * logs counts.
 *
 * ARCHITECTURE mirrors the PERF-3 retention sweep: a repeatable BullMQ job is only a clock tick —
 * the age predicate over the table is authoritative, so a lost or duplicated tick is harmless, and
 * a missed day only means the lines that should have gone go the next day (the reads never show a
 * line older than 7 days anyway). Registration failures log one loud warn and never fail boot.
 *
 * ARMED, WITH NO DRY RUN AND NO FLAG: the retention is the owner's ruling, and the table it deletes
 * from exists only once migration 0135 is applied — before that a tick finds nothing to sweep.
 *
 * EVENTS: none, like every retention sweep; the per-tick summary is logged, counts only.
 */
@Processor(COMPANION_HISTORY_SWEEP_QUEUE)
export class CompanionHistorySweepProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(CompanionHistorySweepProcessor.name);

  constructor(
    private readonly history: CompanionHistoryService,
    @InjectQueue(COMPANION_HISTORY_SWEEP_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  /** Register the daily tick at boot; idempotent by scheduler id. */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.queue.upsertJobScheduler(COMPANION_HISTORY_SWEEP_SCHEDULER_ID, {
        every: COMPANION_HISTORY_SWEEP_EVERY_MS,
      });
    } catch (err) {
      this.logger.warn(
        `companion history sweep scheduler registration failed — the retention sweep is not ` +
          `(re-)registered by this process; a previously-registered scheduler keeps ticking ` +
          `and the next boot re-asserts it (reason: ${
            err instanceof Error ? err.message : String(err)
          })`,
      );
    }
  }

  /** One tick. Counts only — never a worker id, never a line. */
  async process(): Promise<CompanionHistorySweepResult> {
    const result = await this.history.sweep(new Date());
    this.logger.log(
      result.tablesMissing
        ? "companion history sweep: tables missing (migration 0135 not applied), nothing swept"
        : `companion history sweep: lines_deleted=${result.linesDeleted} ` +
            `summaries_deleted=${result.summariesDeleted}`,
    );
    return result;
  }
}
