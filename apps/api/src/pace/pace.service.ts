import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { rankWorkersForJob, type JobSpec, type WorkerSignals } from "@badabhai/reach-engine";
import {
  type ServerConfig,
  isPaceEnabled,
  isPaceAdjacencyEnabled,
} from "@badabhai/config";
import type { PaceState } from "@badabhai/db";
import { SERVER_CONFIG } from "../config/config.module";
import { EventsService } from "../events/events.service";
import { ReachRepository } from "../reach/reach.repository";
import { workerProfileRowToSignals } from "../reach/reach.mappers";
import { JOB_SOURCE, type JobSource } from "../reach/reach.job-source";
import { PaceRepository } from "./pace.repository";
import {
  decidePaceAction,
  type PaceDecisionConfig,
  type PaceStage,
} from "./pace.decision";
import { PACE_QUEUE, PACE_WAVE_JOB, type PaceWaveJobData } from "./pace.constants";

/** Correlation/request ids threaded through a PACE run (HTTP start → delayed waves). */
interface PaceTrace {
  correlationId: string;
  requestId: string;
}

/**
 * PACE supply-widening (ADR-0021) — the deterministic "release waves" slice of
 * ADR-0011's PACE triad. For a thin-supply job it widens the served good-fit pool in
 * waves (raise the travel AREA band → [gated] adjacent trade) scheduled as DELAYED
 * BullMQ jobs across the 6–24h window, and raises a PII-free OPS ALERT if supply
 * stays thin past the window.
 *
 * INVARIANTS HELD HERE:
 *  - NO LLM. The widen decision is the pure `decidePaceAction` rule; supply is the
 *    deterministic `@badabhai/reach-engine` RANK core (imported, never reimplemented).
 *  - SORT-NEVER-BLOCK + FLOOR. "Supply" is the count of above-floor (on-trade `hot`)
 *    good-fit candidates — the SAME floor the boost-integrity guard locks. Widening
 *    only RAISES the band / adds adjacency at the lower secondary weight, so it can
 *    only ADD candidates; it never hides, drops, or re-ranks anyone.
 *  - FACELESS. State + events carry opaque job_id + counts + stage + elapsed only.
 *  - ADDITIVE + GATED. Inert unless PACE_ENABLED; the adjacent-trade leg is gated on
 *    a ratified adjacency map (PACE_ADJACENCY_ENABLED, default off — none exists yet).
 */
@Injectable()
export class PaceService {
  private readonly logger = new Logger(PaceService.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly repo: PaceRepository,
    private readonly events: EventsService,
    private readonly reachRepo: ReachRepository,
    @Inject(JOB_SOURCE) private readonly jobs: JobSource,
    @InjectQueue(PACE_QUEUE) private readonly queue: Queue<PaceWaveJobData>,
  ) {}

  /** Whether PACE is enabled (master gate; inert/additive when off). */
  isEnabled(): boolean {
    return isPaceEnabled(this.config);
  }

  /**
   * Start a PACE run for a job (idempotent). Creates the run at the base band and
   * schedules wave 1. No-op (returns null) when PACE is disabled. Throws 404 if the
   * job is unknown. Does NOT widen synchronously — the first widen happens on wave 1.
   */
  async startForJob(jobId: string, trace: PaceTrace, now: Date = new Date()): Promise<PaceState | null> {
    if (!this.isEnabled()) {
      this.logger.log(`PACE disabled — start ignored for job ${jobId}`);
      return null;
    }
    const jobSpec = await this.jobs.getJobSpec(jobId);
    if (!jobSpec) throw new NotFoundException(`Job ${jobId} not found`);

    const existing = await this.repo.findByJobId(jobId);
    if (existing) return existing; // already running — idempotent start

    const state = await this.repo.create({
      jobId,
      currentAreaKm: this.baseAreaKm(jobSpec),
      startedAt: now,
    });
    await this.scheduleNextWave(jobId, trace);
    return state;
  }

  /**
   * Run one PACE wave for a job: recompute above-floor supply at the current band,
   * decide the next action (pure), apply it (persist + emit a PII-free event), and
   * (re)schedule the next wave unless the run is terminal/healthy. `now` is injectable
   * for deterministic tests; the processor passes the real clock.
   */
  async runWave(jobId: string, trace: PaceTrace, now: Date = new Date()): Promise<void> {
    if (!this.isEnabled()) return; // disabled mid-run → stop quietly
    const state = await this.repo.findByJobId(jobId);
    if (!state || state.stage === "ops_alert") return; // gone or terminal
    const jobSpec = await this.jobs.getJobSpec(jobId);
    if (!jobSpec) return; // job removed (FK cascade clears state) — nothing to do

    const currentAreaKm = state.currentAreaKm ?? this.baseAreaKm(jobSpec);
    const supplyCount = await this.countAboveFloorSupply(jobSpec, currentAreaKm, now);
    const elapsedHours = this.elapsedHoursSince(state.startedAt, now);

    const action = decidePaceAction({
      supplyCount,
      elapsedHours,
      stage: state.stage as PaceStage,
      currentAreaKm,
      opsAlertRaised: state.opsAlertRaised,
      config: this.decisionConfig(),
    });

    switch (action.kind) {
      case "none": {
        await this.repo.updateSupply(jobId, supplyCount, now);
        // Healthy → stop. Thin-but-waiting (e.g. area maxed, pre-window) → keep checking.
        if (supplyCount < this.config.PACE_THIN_SUPPLY_MIN) await this.scheduleNextWave(jobId, trace);
        return;
      }
      case "widen_area": {
        await this.repo.applyWiden(jobId, {
          stage: "area",
          areaKm: action.toAreaKm,
          supplyCount,
          now,
        });
        await this.emitWaveWidened(jobId, "area", supplyCount, elapsedHours, state.wave + 1, trace);
        await this.scheduleNextWave(jobId, trace);
        return;
      }
      case "widen_adjacent": {
        await this.repo.applyWiden(jobId, {
          stage: "adjacent_trade",
          areaKm: currentAreaKm,
          supplyCount,
          now,
        });
        await this.emitWaveWidened(
          jobId,
          "adjacent_trade",
          supplyCount,
          elapsedHours,
          state.wave + 1,
          trace,
        );
        await this.scheduleNextWave(jobId, trace);
        return;
      }
      case "ops_alert": {
        await this.repo.raiseOpsAlert(jobId, supplyCount, now);
        await this.emitOpsAlert(jobId, supplyCount, elapsedHours, trace);
        return; // terminal — no further waves
      }
    }
  }

  /** PII-free ops view: jobs whose PACE run raised an ops alert. */
  async listOpsAlerts(): Promise<PaceState[]> {
    return this.repo.listOpsAlerted();
  }

  // --- internals -----------------------------------------------------------

  private decisionConfig(): PaceDecisionConfig {
    return {
      thinSupplyMin: this.config.PACE_THIN_SUPPLY_MIN,
      areaStepKm: this.config.PACE_AREA_STEP_KM,
      maxAreaKm: this.config.PACE_MAX_AREA_KM,
      opsAlertAfterHours: this.config.PACE_OPS_ALERT_AFTER_HOURS,
      // GATED: no ratified adjacency map exists today, so this is off in alpha. With
      // it off the adjacent-trade leg is skipped (the engine's secondaryRoleIds are []).
      adjacencyEnabled: isPaceAdjacencyEnabled(this.config),
    };
  }

  /** The base travel band for a job — its own `maxTravelKm`, else the configured step. */
  private baseAreaKm(jobSpec: JobSpec): number {
    return jobSpec.maxTravelKm ?? this.config.PACE_AREA_STEP_KM;
  }

  /**
   * Count above-floor (on-trade `hot`) good-fit candidates at a travel band, reusing
   * the reach-engine RANK core over the FULL pool (never a relevance WHERE, never a
   * reimplementation). Raising `maxTravelKm` can only RAISE distant workers' scores,
   * so it only ADDS to the count — sort-never-block + floor preserved.
   */
  protected async countAboveFloorSupply(jobSpec: JobSpec, areaKm: number, now: Date): Promise<number> {
    const spec: JobSpec = { ...jobSpec, maxTravelKm: areaKm };
    const rows = await this.reachRepo.listSignalRows();
    const signals: WorkerSignals[] = rows.map((r) => workerProfileRowToSignals(r, now));
    return rankWorkersForJob(spec, signals).filter((r) => r.hot).length;
  }

  private elapsedHoursSince(startedAt: Date, now: Date): number {
    const ms = now.getTime() - startedAt.getTime();
    return ms > 0 ? ms / 3_600_000 : 0;
  }

  /** Schedule the next wave as a DELAYED BullMQ job (the 6–24h cadence). */
  private async scheduleNextWave(jobId: string, trace: PaceTrace): Promise<void> {
    const delay = this.config.PACE_WAVE_INTERVAL_HOURS * 3_600_000;
    await this.queue.add(
      PACE_WAVE_JOB,
      { jobId, correlationId: trace.correlationId, requestId: trace.requestId },
      { delay },
    );
  }

  private async emitWaveWidened(
    jobId: string,
    stage: "area" | "adjacent_trade",
    supplyCount: number,
    elapsedHours: number,
    wave: number,
    trace: PaceTrace,
  ): Promise<void> {
    await this.events.emit({
      event_name: "pace.wave_widened",
      actor: { actor_type: "system" },
      subject: { subject_type: "job", subject_id: jobId },
      payload: {
        job_id: jobId,
        stage,
        supply_count: supplyCount,
        elapsed_hours: round2(elapsedHours),
      },
      // One event per (job, wave) — dedups under BullMQ stalled-job redelivery.
      idempotencyKey: `pace.wave_widened:${jobId}:${wave}`,
      correlationId: trace.correlationId,
      requestId: trace.requestId,
    });
  }

  private async emitOpsAlert(
    jobId: string,
    supplyCount: number,
    elapsedHours: number,
    trace: PaceTrace,
  ): Promise<void> {
    await this.events.emit({
      event_name: "pace.ops_alert_raised",
      actor: { actor_type: "system" },
      subject: { subject_type: "job", subject_id: jobId },
      payload: {
        job_id: jobId,
        supply_count: supplyCount,
        elapsed_hours: round2(elapsedHours),
      },
      // Exactly one ops alert per job.
      idempotencyKey: `pace.ops_alert_raised:${jobId}`,
      correlationId: trace.correlationId,
      requestId: trace.requestId,
    });
  }
}

/** Round to 2 decimals (keeps elapsed_hours tidy; the schema accepts any nonneg number). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
