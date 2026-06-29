import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  type Database,
  workerDevices,
  type WorkerDevice,
  type DevicePlatform,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/** Fields the service hands the repository to register/touch a device. */
export interface DeviceUpsert {
  workerId: string;
  /** Keyed HMAC of the raw client device id — the raw value is NEVER passed here. */
  deviceHash: string;
  platform: DevicePlatform;
  model?: string | null;
  appVersion?: string | null;
  /** Opaque push token (raw — needed to push); never logged/evented. */
  pushToken?: string | null;
}

/**
 * Drizzle data access for `worker_devices` (ADR-0026 Phase 2). No business logic, no
 * events — the service owns those. The raw client device id never reaches this layer;
 * only its keyed HMAC (`device_hash`) is stored.
 */
@Injectable()
export class DevicesRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Register a device, or return + touch the existing row for the same
   * (worker_id, device_hash). Race-safe (mirrors workers.createOrGetByPhoneHash /
   * TD23): `on conflict do nothing` makes the losing concurrent insert a no-op, then
   * we re-read + update the winner. A previously-revoked row is RE-TRUSTED (revoked_at
   * cleared) on re-login. `created` is true only for the row that actually inserted —
   * the caller gates the one-time `worker.device_registered` event on it.
   */
  async registerOrTouch(input: DeviceUpsert): Promise<{ device: WorkerDevice; created: boolean }> {
    const inserted = await this.db
      .insert(workerDevices)
      .values({
        workerId: input.workerId,
        deviceHash: input.deviceHash,
        platform: input.platform,
        model: input.model ?? null,
        appVersion: input.appVersion ?? null,
        pushToken: input.pushToken ?? null,
      })
      .onConflictDoNothing({ target: [workerDevices.workerId, workerDevices.deviceHash] })
      .returning();

    if (inserted[0]) return { device: inserted[0], created: true };

    // Lost the insert race OR the device already existed → touch last_seen, refresh the
    // mutable descriptors, and re-trust (clear revoked_at) on a fresh OTP login.
    const updated = await this.db
      .update(workerDevices)
      .set({
        lastSeenAt: new Date(),
        revokedAt: null,
        platform: input.platform,
        model: input.model ?? null,
        appVersion: input.appVersion ?? null,
        pushToken: input.pushToken ?? null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workerDevices.workerId, input.workerId),
          eq(workerDevices.deviceHash, input.deviceHash),
        ),
      )
      .returning();

    const row = updated[0];
    if (!row) throw new Error("device upsert hit a conflict but no row was found");
    return { device: row, created: false };
  }

  /**
   * One ACTIVE (non-revoked) device by row id, SCOPED to its owning worker (ADR-0026 Phase 3
   * device-bound PIN trusted-device gate). Returns undefined when the id does not exist, is
   * not owned by `workerId`, or has been revoked — so a PIN-verify can confirm the resolved
   * device is still a trusted device for that worker (no IDOR; a revoked device is untrusted).
   */
  async findActiveById(workerId: string, deviceId: string): Promise<WorkerDevice | undefined> {
    const rows = await this.db
      .select()
      .from(workerDevices)
      .where(
        and(
          eq(workerDevices.id, deviceId),
          eq(workerDevices.workerId, workerId),
          isNull(workerDevices.revokedAt),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /** Active (non-revoked) devices for a worker, most-recently-seen first. */
  async listActiveByWorker(workerId: string): Promise<WorkerDevice[]> {
    return this.db
      .select()
      .from(workerDevices)
      .where(and(eq(workerDevices.workerId, workerId), isNull(workerDevices.revokedAt)))
      .orderBy(desc(workerDevices.lastSeenAt));
  }

  /**
   * Mark a device revoked, SCOPED to its owning worker and only if still active. Returns
   * the row when this call performed the revoke, undefined if it did not match (not
   * owned / already revoked) — so the caller emits the event exactly once.
   */
  async revoke(workerId: string, deviceId: string): Promise<WorkerDevice | undefined> {
    const rows = await this.db
      .update(workerDevices)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(workerDevices.id, deviceId),
          eq(workerDevices.workerId, workerId),
          isNull(workerDevices.revokedAt),
        ),
      )
      .returning();
    return rows[0];
  }
}
