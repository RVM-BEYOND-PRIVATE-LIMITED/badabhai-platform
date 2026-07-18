import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
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
    // ADR-0034: a push token is only ever WRITTEN, never cleared, by a login. The old
    // `pushToken: input.pushToken ?? null` nulled a perfectly good token on every login
    // whose device_info omitted one — i.e. every login from a client that has not
    // shipped the token bridge — silently killing push for that device. A token is
    // cleared only by an explicit removal path (invalidation / revoke), never by
    // omission. `push_target` is rotated whenever a NEW token is registered.
    const hasToken = typeof input.pushToken === "string" && input.pushToken.length > 0;
    const tokenFields = hasToken
      ? { pushToken: input.pushToken as string, pushTarget: randomUUID() }
      : {};

    const inserted = await this.db
      .insert(workerDevices)
      .values({
        workerId: input.workerId,
        deviceHash: input.deviceHash,
        platform: input.platform,
        model: input.model ?? null,
        appVersion: input.appVersion ?? null,
        ...tokenFields,
      })
      .onConflictDoNothing({ target: [workerDevices.workerId, workerDevices.deviceHash] })
      .returning();

    if (inserted[0]) {
      if (hasToken) await this.claimPushToken(input.pushToken as string, inserted[0].id);
      return { device: inserted[0], created: true };
    }

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
        ...tokenFields,
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
    // ADR-0034 D5b.2 — claim on the TOUCH path too, not just the insert above. The rule is
    // "registering a token (login OR the PATCH route) nulls it on every other row", and a
    // returning worker hits THIS branch, not the insert. Without it the shared-handset leak
    // is only half closed: handset H where workers A and B have both logged in holds two
    // rows (the unique key is worker_id + device_hash), so B logging in again with token T
    // would take T while A's row still held it — and A's device_registered /
    // logged_out_all alerts would fire at a handset A no longer has. That is exactly the
    // misdelivery the SIM-swap targeting rule exists to prevent.
    if (hasToken) await this.claimPushToken(input.pushToken as string, row.id);
    return { device: row, created: false };
  }

  /**
   * ADR-0034 — "steal-on-register": give `token` exclusively to `deviceId` by NULLING it
   * on every OTHER row that holds it.
   *
   * An FCM token addresses an app INSTALL, not a person. On a shared or handed-down
   * handset — routine in this market — worker A logs out and worker B logs in, and FCM
   * hands the SAME token to that install. Without this, the token sits on both rows and
   * worker A's SECURITY alerts are delivered to worker B's phone: a cross-account
   * disclosure, and worst precisely for the copy that matters most. A second holder is
   * by definition stale, so the newest registration wins.
   *
   * Returns how many stale holders were cleared (0 in the common case).
   */
  async claimPushToken(token: string, deviceId: string): Promise<number> {
    const cleared = await this.db
      .update(workerDevices)
      .set({ pushToken: null, pushTarget: null, updatedAt: new Date() })
      .where(and(eq(workerDevices.pushToken, token), ne(workerDevices.id, deviceId)))
      .returning({ id: workerDevices.id });
    return cleared.length;
  }

  /**
   * ADR-0034 — set the push token on ONE device the caller already owns (the
   * PATCH /auth/devices/me/push-token route). Scoped by worker AND device id, and only
   * while the device is active: a revoked device must never be re-armed for push.
   * Rotates `push_target` so a stale in-flight payload can no longer match. Returns the
   * updated row, or undefined when it did not match (unknown / not owned / revoked).
   */
  async setPushToken(
    workerId: string,
    deviceId: string,
    token: string,
  ): Promise<WorkerDevice | undefined> {
    const rows = await this.db
      .update(workerDevices)
      .set({ pushToken: token, pushTarget: randomUUID(), updatedAt: new Date() })
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

  /**
   * ADR-0034 — clear a token that the provider reported as dead (FCM UNREGISTERED).
   * Matched on the TOKEN, not the device: the same dead token may sit on more than one
   * row. Only a definitive provider verdict calls this — never a transport blip, which
   * would throw away a working token.
   */
  async clearPushToken(token: string): Promise<number> {
    const cleared = await this.db
      .update(workerDevices)
      .set({ pushToken: null, pushTarget: null, updatedAt: new Date() })
      .where(eq(workerDevices.pushToken, token))
      .returning({ id: workerDevices.id });
    return cleared.length;
  }

  /**
   * ADR-0034 — revoke EVERY active device of a worker (the logout-all panic button).
   *
   * `SessionService.revokeAll` previously killed only Redis sessions, leaving device
   * rows active with live push tokens — so a worker who hit "log out everywhere"
   * because their handset was STOLEN left that handset receiving every future push,
   * indefinitely. Fan-out targets non-revoked devices only, so revoking here is what
   * makes the panic button actually stop delivery. Re-login re-trusts the device
   * (`registerOrTouch` clears `revoked_at`).
   *
   * Returns the rows revoked BY THIS CALL — the caller pushes the "logged out
   * everywhere" alert to exactly those (the one case allowed to target just-revoked
   * devices, because warning them is the entire point).
   */
  async revokeAllForWorker(workerId: string): Promise<WorkerDevice[]> {
    return this.db
      .update(workerDevices)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(workerDevices.workerId, workerId), isNull(workerDevices.revokedAt)))
      .returning();
  }

  /**
   * ADR-0034 — active devices of a worker that can actually receive a push, optionally
   * EXCLUDING one device row. The exclusion implements the owner's SIM-swap ruling: a
   * new-device-login alert goes to the worker's OTHER phones, never to the device that
   * just logged in — otherwise an attacker's new handset gets the warning and the real
   * owner does not.
   */
  async listPushTargets(workerId: string, excludeDeviceId?: string): Promise<WorkerDevice[]> {
    const rows = await this.db
      .select()
      .from(workerDevices)
      .where(
        and(
          eq(workerDevices.workerId, workerId),
          isNull(workerDevices.revokedAt),
          sql`${workerDevices.pushToken} IS NOT NULL`,
        ),
      );
    return excludeDeviceId ? rows.filter((r) => r.id !== excludeDeviceId) : rows;
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
