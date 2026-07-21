import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import {
  AI_JOBS_RETENTION_QUEUE,
  AI_JOBS_RETENTION_SWEEP_SCHEDULER_ID,
} from "../queue/queue.constants";
import { AiJobsRepository, type RetentionPruneSummary } from "./ai-jobs.repository";

/** Per-run cap on ARMED deletes — a pathological backlog drains across ticks, never
 * one unbounded run (the next tick picks up where this one stopped; the deletion
 * sweep's SWEEP_BATCH_LIMIT posture, sized up because these are cheap row deletes,
 * not per-worker storage fan-outs). */
const RETENTION_BATCH_LIMIT = 1000;

const DAY_MS = 86_400_000;

/** What one tick did — returned for BullMQ job inspection; counts only, no ids. */
export interface RetentionSweepResult extends RetentionPruneSummary {
  dryRun: boolean;
  windowDays: number;
  pruned: number;
}

/**
 * PERF-3 — retention sweep for `ai_jobs` (OWNER DECISION 2026-07-21: TERMINAL rows
 * older than 90 days are pruned). `ai_jobs` accumulates every extraction /
 * transcription job forever; the rows are PII-free by construction (§2 invariant
 * 2 — refs, hashes and typed cost scalars only), so this is retention/cost
 * hygiene, and the DPDP rationale is DATA MINIMISATION of operational metadata —
 * NOT erasure (the DSAR path is the account-deletion sweep, untouched here).
 *
 * WHAT IT NEVER PRUNES (both live in `retentionPruneWhere`, shared by the dry-run
 * summary and the armed delete so report and action cannot drift):
 *   - queued/running rows, at ANY age — a zombie row is the #420 in-flight
 *     guard's problem, not retention's;
 *   - terminal rows referenced by `worker_profiles.ai_job_id` (the TD14 tie) —
 *     the #420 dedupe LEFT JOINs through that ref to find the prior COMPLETED
 *     extraction; pruning one would make the dedupe blind and re-open real AI
 *     spend on every profile-preview mount (#427/#430/#438/#467).
 *
 * DRY-RUN FIRST (launch-gate pattern — inert by default): while
 * `AI_JOBS_RETENTION_DELETE_ENABLED` is false every tick only LOGS the candidate
 * count + age distribution + the referenced-rows-kept count, and deletes NOTHING.
 * Flipping the flag is the explicit act that arms deletion.
 *
 * ARCHITECTURE mirrors the ADR-0031 account-deletion sweep: a repeatable BullMQ
 * job is only a clock tick — the prune predicate over the table is authoritative,
 * so a lost/duplicated Redis job is harmless (the next tick re-evaluates it, and a
 * duplicate tick just finds fewer rows). Registration deliberately DIVERGES from
 * that sweep's bounded retry ladder + /health probe: a failed registration there
 * silently stops DPDP erasure, but a failed registration HERE only delays cost
 * hygiene — the scheduler persisted in Redis by any previous boot (or any other
 * replica) keeps ticking regardless, and the next boot re-asserts it. One loud
 * warn, never a boot failure.
 *
 * EVENTS: none, deliberately — mirroring the account-deletion sweep, whose tick
 * emits nothing (its `worker.account_deleted` events belong to the per-worker
 * DSAR erasure, which has no analogue for PII-free operational rows). The
 * per-tick summary is logged instead: counts + window + flag only, never ids,
 * never PII.
 */
@Processor(AI_JOBS_RETENTION_QUEUE)
export class AiJobsRetentionSweepProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(AiJobsRetentionSweepProcessor.name);

  constructor(
    private readonly aiJobs: AiJobsRepository,
    @InjectQueue(AI_JOBS_RETENTION_QUEUE) private readonly queue: Queue,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {
    super();
  }

  /**
   * Register the repeatable sweep at boot. `upsertJobScheduler` is idempotent by
   * scheduler id: every boot re-asserts the SAME scheduler (updating the cadence
   * if config changed) instead of stacking duplicates. A failure is logged and
   * swallowed — see the class doc for why there is no retry ladder here.
   */
  async onApplicationBootstrap(): Promise<void> {
    const every = this.config.AI_JOBS_RETENTION_SWEEP_INTERVAL_HOURS * 3_600_000;
    try {
      await this.queue.upsertJobScheduler(AI_JOBS_RETENTION_SWEEP_SCHEDULER_ID, { every });
    } catch (err) {
      this.logger.warn(
        `retention sweep scheduler registration failed — ai_jobs retention is not ` +
          `(re-)registered by this process; a previously-registered scheduler keeps ticking ` +
          `and the next boot re-asserts it (reason: ${
            err instanceof Error ? err.message : String(err)
          })`,
      );
    }
  }

  /**
   * One sweep tick. Always summarizes (the dry-run report IS the armed report);
   * deletes one bounded batch only when explicitly armed.
   */
  async process(): Promise<RetentionSweepResult> {
    const windowDays = this.config.AI_JOBS_RETENTION_DAYS;
    const armed = this.config.AI_JOBS_RETENTION_DELETE_ENABLED;
    const now = Date.now();
    const cutoff = new Date(now - windowDays * DAY_MS);
    const summary = await this.aiJobs.summarizeRetentionPrune({
      cutoff,
      cutoff2x: new Date(now - 2 * windowDays * DAY_MS),
      cutoff4x: new Date(now - 4 * windowDays * DAY_MS),
    });

    // Counts only — never job ids, never PII (none exists on the table).
    const byType =
      Object.entries(summary.byType)
        .map(([type, n]) => `${type}=${n}`)
        .join(" ") || "none";
    const shape =
      `candidates=${summary.candidates} skipped_referenced=${summary.skippedReferenced} ` +
      `window_days=${windowDays} by_type[${byType}] age[<=2x]=${summary.ageDistribution.upTo2x} ` +
      `age[2-4x]=${summary.ageDistribution.upTo4x} age[>4x]=${summary.ageDistribution.over4x}`;

    if (!armed) {
      this.logger.log(`retention sweep DRY-RUN (deleting nothing): ${shape}`);
      return { dryRun: true, windowDays, pruned: 0, ...summary };
    }

    const pruned = await this.aiJobs.pruneRetentionBatch(cutoff, RETENTION_BATCH_LIMIT);
    this.logger.log(`retention sweep ARMED: pruned=${pruned} ${shape}`);
    return { dryRun: false, windowDays, pruned, ...summary };
  }
}
