import { Inject, Injectable } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { type Database, paceStates, type PaceState } from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import type { PaceStage } from "./pace.decision";

/**
 * Drizzle access to `pace_states` (ADR-0021) — the per-job PACE run state. FACELESS:
 * the only reference is the opaque `job_id`; no worker/employer/location ever lands
 * here. One row per job (unique `job_id`). All writes stamp `updated_at`.
 */
@Injectable()
export class PaceRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** The PACE run for a job, or `undefined` if none is active. */
  async findByJobId(jobId: string): Promise<PaceState | undefined> {
    const rows = await this.db
      .select()
      .from(paceStates)
      .where(eq(paceStates.jobId, jobId))
      .limit(1);
    return rows[0];
  }

  /** All jobs whose PACE run raised an ops alert (the ops-intervention surface). */
  async listOpsAlerted(): Promise<PaceState[]> {
    return this.db.select().from(paceStates).where(eq(paceStates.opsAlertRaised, true));
  }

  /** Start a run at the base band (stage=base, wave=0). Caller guards idempotency. */
  async create(params: {
    jobId: string;
    currentAreaKm: number;
    startedAt: Date;
  }): Promise<PaceState> {
    const rows = await this.db
      .insert(paceStates)
      .values({
        jobId: params.jobId,
        stage: "base",
        wave: 0,
        currentAreaKm: params.currentAreaKm,
        lastSupplyCount: 0,
        opsAlertRaised: false,
        startedAt: params.startedAt,
      })
      .returning();
    return rows[0]!;
  }

  /** Record the latest observed supply without changing the stage (the "none" path). */
  async updateSupply(jobId: string, supplyCount: number, now: Date): Promise<void> {
    await this.db
      .update(paceStates)
      .set({ lastSupplyCount: supplyCount, updatedAt: now })
      .where(eq(paceStates.jobId, jobId));
  }

  /** Apply a widen wave: advance the stage, bump the wave counter, set the band. */
  async applyWiden(
    jobId: string,
    params: { stage: PaceStage; areaKm: number; supplyCount: number; now: Date },
  ): Promise<void> {
    await this.db
      .update(paceStates)
      .set({
        stage: params.stage,
        wave: sql`${paceStates.wave} + 1`,
        currentAreaKm: params.areaKm,
        lastSupplyCount: params.supplyCount,
        updatedAt: params.now,
      })
      .where(eq(paceStates.jobId, jobId));
  }

  /** Terminal: mark the ops alert raised (idempotent — `ops_alert_raised` guards re-raise). */
  async raiseOpsAlert(jobId: string, supplyCount: number, now: Date): Promise<void> {
    await this.db
      .update(paceStates)
      .set({
        stage: "ops_alert",
        opsAlertRaised: true,
        lastSupplyCount: supplyCount,
        updatedAt: now,
      })
      .where(eq(paceStates.jobId, jobId));
  }
}
