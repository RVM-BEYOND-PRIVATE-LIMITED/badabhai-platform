import { Inject, Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { InjectQueue } from "@nestjs/bullmq";
import { Job, Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../../config/config.module";
import {
  CANDIDATE_INDEX_OVERLAP_MS,
  CANDIDATE_INDEX_POLL_SCHEDULER_ID,
  CANDIDATE_INDEX_QUEUE,
  CANDIDATE_INDEX_REBUILD_JOB,
  CANDIDATE_INDEX_REBUILD_SCHEDULER_ID,
} from "../../queue/queue.constants";
import { CandidateIndexProjector } from "./candidate-index.projector";
import { CandidateIndexRepository } from "./candidate-index.repository";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve the affected worker from a spine event, or null when it names none. */
export function workerIdOfEvent(event: {
  subjectType: string;
  subjectId: string | null;
  payload: unknown;
}): string | null {
  if (event.subjectType === "worker" && event.subjectId !== null && UUID.test(event.subjectId)) {
    return event.subjectId;
  }
  const payload = event.payload;
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    const id = (payload as Record<string, unknown>)["worker_id"];
    if (typeof id === "string" && UUID.test(id)) return id;
  }
  return null;
}

/**
 * The B4 projector ticks (design: ADR-0062 §3.5). Two repeatable jobs on
 * {@link CANDIDATE_INDEX_QUEUE}, both carrying NO payload:
 * - `poll`: drain spine events after the cursor watermark (minus the overlap
 *   window) and project each named worker. Idempotent upserts make overlap safe.
 * - `rebuild`: re-project every worker, so a missed event or a resolver change
 *   converges without a manual repair.
 *
 * Per-row failures never fail the tick (log + continue); a Redis outage at
 * registration only warns (next boot re-asserts the schedulers).
 */
@Injectable()
@Processor(CANDIDATE_INDEX_QUEUE)
export class CandidateIndexProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(CandidateIndexProcessor.name);

  constructor(
    private readonly projector: CandidateIndexProjector,
    private readonly index: CandidateIndexRepository,
    @InjectQueue(CANDIDATE_INDEX_QUEUE) private readonly queue: Queue,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    const pollEvery = this.config.CANDIDATE_INDEX_POLL_INTERVAL_MINUTES * 60_000;
    const rebuildEvery = this.config.CANDIDATE_INDEX_REBUILD_INTERVAL_HOURS * 3_600_000;
    try {
      await this.queue.upsertJobScheduler(CANDIDATE_INDEX_POLL_SCHEDULER_ID, { every: pollEvery });
      await this.queue.upsertJobScheduler(CANDIDATE_INDEX_REBUILD_SCHEDULER_ID, {
        every: rebuildEvery,
      });
    } catch (err) {
      this.logger.warn(
        `candidate-index schedulers not registered — next boot re-asserts them (reason: ${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }
  }

  async process(job: Job): Promise<{ projected: number; skipped: number }> {
    if (job.name === CANDIDATE_INDEX_REBUILD_JOB) return this.rebuild();
    // Poll is the default (including CANDIDATE_INDEX_POLL_JOB): an unknown job
    // name still drains the events window rather than sitting unprocessed.
    return this.poll();
  }

  /** Drain one events window after the watermark. */
  async poll(): Promise<{ projected: number; skipped: number }> {
    const limit = this.config.CANDIDATE_INDEX_BATCH_LIMIT;
    const watermark = await this.index.getWatermark();
    const batch = await this.index.readEventBatch(watermark, CANDIDATE_INDEX_OVERLAP_MS, limit);
    let projected = 0;
    let skipped = 0;
    let maxMs = watermark;
    for (const event of batch) {
      maxMs = Math.max(maxMs, event.createdAt.getTime());
      const workerId = workerIdOfEvent(event);
      if (workerId === null) {
        skipped++;
        continue;
      }
      try {
        if (await this.projector.projectWorker(workerId)) projected++;
        else skipped++;
      } catch (err) {
        // One worker's projection must never fail the tick — the next poll and
        // the nightly rebuild both retry it.
        this.logger.warn(
          `candidate-index projection failed worker=${workerId.slice(0, 8)} (reason: ${
            err instanceof Error ? err.message : String(err)
          })`,
        );
        skipped++;
      }
    }
    if (batch.length > 0) await this.index.setWatermark(maxMs);
    return { projected, skipped };
  }

  /** Re-project every worker, keyset-paged. Counts only — no ids leave this job. */
  async rebuild(): Promise<{ projected: number; skipped: number }> {
    const limit = this.config.CANDIDATE_INDEX_BATCH_LIMIT;
    let projected = 0;
    let skipped = 0;
    let after: string | null = null;
    for (;;) {
      const ids = await this.index.listWorkerIds(limit, after);
      if (ids.length === 0) break;
      for (const workerId of ids) {
        try {
          if (await this.projector.projectWorker(workerId)) projected++;
          else skipped++;
        } catch (err) {
          this.logger.warn(
            `candidate-index rebuild failed worker=${workerId.slice(0, 8)} (reason: ${
              err instanceof Error ? err.message : String(err)
            })`,
          );
          skipped++;
        }
      }
      after = ids[ids.length - 1] ?? null;
      if (ids.length < limit) break;
    }
    this.logger.log(`candidate-index rebuild projected=${projected} skipped=${skipped}`);
    return { projected, skipped };
  }
}
