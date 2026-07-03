import { Inject, Injectable } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { type Database, workerCredentials, type WorkerCredential } from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/**
 * Drizzle data access for `worker_credentials` (ADR-0026 Phase 3, the device-bound PIN).
 * No business logic, no events — the service owns those. The raw PIN never reaches this
 * layer; only its scrypt `pin_hash` token (produced by the PinHasher boundary) is stored.
 *
 * RLS: `worker_credentials` is RLS-FORCED — the backend service role bypasses RLS today
 * (infra/supabase/rls-plan.md), and every method here is scoped by worker_id, so a worker
 * can only ever touch their OWN credential row.
 */
@Injectable()
export class PinRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** The credential row for a worker, or undefined if no PIN was ever set. */
  async findByWorkerId(workerId: string): Promise<WorkerCredential | undefined> {
    const rows = await this.db
      .select()
      .from(workerCredentials)
      .where(eq(workerCredentials.workerId, workerId))
      .limit(1);
    return rows[0];
  }

  /**
   * Set (or replace) a worker's PIN. Race-safe via `onConflictDoUpdate` on the UNIQUE
   * worker_id (two concurrent set-PIN calls converge on one row, no 23505). Setting a PIN
   * is a FRESH start: it CLEARS the whole throttle — failed_attempts=0, locked_until=null,
   * lockout_cycles=0, AND otp_cycle_count=0 (so an OTP-gated reset un-invalidates a
   * force-OTP'd PIN). Stamps pin_updated_at + updated_at.
   */
  async upsertPin(workerId: string, pinHash: string, pepperVersion: number): Promise<void> {
    await this.db
      .insert(workerCredentials)
      .values({ workerId, pinHash, pepperVersion })
      .onConflictDoUpdate({
        target: workerCredentials.workerId,
        set: {
          pinHash,
          pepperVersion,
          failedAttempts: 0,
          lockedUntil: null,
          lockoutCycles: 0,
          otpCycleCount: 0,
          pinUpdatedAt: sql`now()`,
          updatedAt: sql`now()`,
        },
      });
  }

  /**
   * Durably mirror a transient-lockout escalation into the DB (a Redis flush cannot wipe
   * the force-OTP state). Writes the absolute lockout_cycles + otp_cycle_count the service
   * computed (NOT increments) so a re-run is idempotent. Also zeroes failed_attempts — a
   * lockout STEP resets the transient failed counter, so the durable mirror tracks that.
   * Scoped by worker_id.
   */
  async recordFailureEscalation(
    workerId: string,
    args: { lockoutCycles: number; otpCycleCount: number },
  ): Promise<void> {
    await this.db
      .update(workerCredentials)
      .set({
        failedAttempts: 0,
        lockoutCycles: args.lockoutCycles,
        otpCycleCount: args.otpCycleCount,
        updatedAt: sql`now()`,
      })
      .where(eq(workerCredentials.workerId, workerId));
  }

  /**
   * Durably mirror the transient failed-attempt count on a NON-lockout wrong PIN (security
   * Finding 1). Without this, a Redis flush/eviction DURING cycle 0 — before any lockout is
   * armed, so lockout_cycles is still 0 and the cycle-mirror rehydration does not fire —
   * would hand the attacker a fresh zero-attempt budget. Persisting the running count means a
   * flush at cycle 0 costs the attacker their accumulated failures, never a reset. Cleared to
   * 0 by upsertPin / clearThrottle / recordFailureEscalation. Scoped by worker_id.
   */
  async recordFailedAttempts(workerId: string, failedAttempts: number): Promise<void> {
    await this.db
      .update(workerCredentials)
      .set({ failedAttempts, updatedAt: sql`now()` })
      .where(eq(workerCredentials.workerId, workerId));
  }

  /**
   * Clear the DB throttle on a SUCCESSFUL verify: failed_attempts=0, locked_until=null,
   * lockout_cycles=0. Deliberately LEAVES otp_cycle_count untouched (a force-OTP'd PIN is
   * only un-invalidated by an OTP-gated reset, never by a lucky correct PIN). Scoped by
   * worker_id.
   */
  async clearThrottle(workerId: string): Promise<void> {
    await this.db
      .update(workerCredentials)
      .set({
        failedAttempts: 0,
        lockedUntil: null,
        lockoutCycles: 0,
        updatedAt: sql`now()`,
      })
      .where(eq(workerCredentials.workerId, workerId));
  }

  /**
   * Durably bump the per-worker force-OTP counter by one (atomic SQL increment, so two
   * racing final-cycle escalations both count correctly). Returns the new value so the
   * caller can decide the force_otp flag. Scoped by worker_id.
   */
  async incrementOtpCycle(workerId: string): Promise<number> {
    const rows = await this.db
      .update(workerCredentials)
      .set({
        otpCycleCount: sql`${workerCredentials.otpCycleCount} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(workerCredentials.workerId, workerId))
      .returning({ otpCycleCount: workerCredentials.otpCycleCount });
    return rows[0]?.otpCycleCount ?? 0;
  }
}
