import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { RequestContext } from "../common/request-context";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { EventsService } from "../events/events.service";
import { SessionService } from "./session.service";
import { PushEnqueuer } from "../push/push-enqueuer.service";
import { DevicesRepository } from "./devices.repository";
import type { DeviceInfoDto, DeviceListItem, DeviceListResponse } from "./devices.dto";

/**
 * Trusted-device binding (ADR-0026 Phase 2). Registers a device on a fresh OTP login,
 * lists a worker's active devices, and revokes a device (cutting its live sessions).
 *
 * PRIVACY (CLAUDE.md §2): the raw client device id is keyed-HMAC'd into `device_hash`
 * and never stored/logged; `push_token` is stored raw but never logged/evented. Device
 * events carry ONLY two opaque uuids (worker_id + the device ROW id).
 *
 * IDENTITY: the worker id always comes from the authenticated token (the caller), never
 * from a body/path — `revokeForWorker` scopes every lookup/update by that worker id, so
 * one worker can never see or revoke another's device (no IDOR).
 */
@Injectable()
export class DevicesService {
  private readonly logger = new Logger(DevicesService.name);

  constructor(
    private readonly repo: DevicesRepository,
    private readonly events: EventsService,
    private readonly pii: PiiCryptoService,
    private readonly sessions: SessionService,
    // ADR-0034 — the new-device security alert. Queue-only seam (PushQueueModule), so
    // no cycle with the push module.
    private readonly push: PushEnqueuer,
  ) {}

  /**
   * Register (or touch) the device a worker just logged in from. Returns the device ROW
   * uuid to thread into the session as the `did` claim, or undefined when no device_info
   * was sent. BEST-EFFORT: a device-write/emit failure is logged and swallowed (returns
   * undefined) so it can NEVER break the OTP-verify login critical path. Emits
   * `worker.device_registered` ONCE, only when a brand-new device row was created.
   */
  async registerOnLogin(
    workerId: string,
    deviceInfo: DeviceInfoDto | undefined,
    ctx: RequestContext,
  ): Promise<string | undefined> {
    if (!deviceInfo) return undefined;
    try {
      const deviceHash = this.pii.hmac(deviceInfo.device_id);
      const { device, created } = await this.repo.registerOrTouch({
        workerId,
        deviceHash,
        platform: deviceInfo.platform,
        model: deviceInfo.model ?? null,
        appVersion: deviceInfo.app_version ?? null,
        pushToken: deviceInfo.push_token ?? null,
      });

      if (created) {
        const emitted = await this.events.emit({
          event_name: "worker.device_registered",
          actor: { actor_type: "worker", actor_id: workerId },
          subject: { subject_type: "worker", subject_id: workerId },
          payload: { worker_id: workerId, device_id: device.id },
          correlationId: ctx.correlationId,
          requestId: ctx.requestId,
        });

        // ADR-0034 — the SIM-swap alarm. Push to the worker's OTHER devices, EXCLUDING
        // the one that just logged in (owner ruling 2026-07-17): if this login is an
        // attacker on a new handset, the warning must reach the real owner's phones, not
        // the attacker's. Pushing the new device would tell the wrong person.
        //
        // ITS OWN try/catch ON PURPOSE: the outer handler degrades the whole registration
        // to "unbound" (returns undefined, so the session gets no `did` claim). A failure
        // to look up push TARGETS must never cost the worker their device binding — the
        // alert is strictly additive to the login.
        try {
          const targets = await this.repo.listPushTargets(workerId, device.id);
          await this.push.enqueue({
            workerId,
            sourceEventId: emitted.event_id,
            eventName: "worker.device_registered",
            deviceIds: targets.map((t) => t.id),
          });
        } catch (pushErr) {
          this.logger.warn(
            `new-device push skipped (errorType: ${
              pushErr instanceof Error ? pushErr.name : "unknown"
            })`,
          );
        }
      }
      return device.id;
    } catch (err) {
      // Device binding is additive — never fail the login over it. Log a STATIC reason +
      // the error TYPE only, NOT err.message: a device-write error could in a future driver
      // echo a row value (push_token / device_hash) into its message — keep that out of the
      // logs (CLAUDE.md §2 belt-and-suspenders; the boundary already holds, this is defense).
      this.logger.error(
        `device registration failed; login continues unbound (errorType: ${
          err instanceof Error ? err.name : "unknown"
        })`,
      );
      return undefined;
    }
  }

  /**
   * ADR-0034 — record the FCM token for the CALLER'S OWN device
   * (PATCH /auth/devices/me/push-token).
   *
   * WHY THE ROUTE EXISTS: a token can only otherwise arrive inside `device_info` on OTP
   * verify, but FCM rotates tokens via `onNewToken`, which fires OUTSIDE any login. With
   * no post-login path a rotated token would dead-end and the worker would silently stop
   * receiving security alerts.
   *
   * IDENTITY IS THE SESSION: `workerId` from the guard, `deviceId` from the token's `did`
   * claim. Nothing is taken from the body.
   *   - no `did` (a login that sent no device_info) → NO-OP. Deliberate: a device row is
   *     created only at login with device_info, and minting one from a bare token would
   *     create an unbound, un-revocable push target.
   *   - unknown / not-owned / REVOKED device → NO-OP. A revoked device must never be
   *     re-armed for push; that would undo the logout-all panic button.
   * Both collapse to 204 — no oracle distinguishing them.
   *
   * On success the token is claimed EXCLUSIVELY (stealing it from any stale row on the
   * same handset) and `push_target` is rotated so a stale in-flight payload can no
   * longer match.
   */
  async updatePushToken(
    workerId: string,
    deviceId: string | undefined,
    token: string,
  ): Promise<void> {
    if (!deviceId) return;
    const updated = await this.repo.setPushToken(workerId, deviceId, token);
    if (!updated) return;
    // A token addresses ONE install: any other row holding it is stale (a shared or
    // handed-down handset). Without this, the previous worker's SECURITY alerts would
    // be delivered to whoever holds the phone now.
    const stolen = await this.repo.claimPushToken(token, deviceId);
    if (stolen > 0) {
      // Count only — never the token or either worker's identity beyond the caller.
      this.logger.log(`push token claimed from ${stolen} stale device row(s)`);
    }
  }

  /** The worker's active (non-revoked) devices — hash + push_token are never surfaced. */
  async listForWorker(
    workerId: string,
    currentDeviceId: string | undefined,
  ): Promise<DeviceListResponse> {
    const rows = await this.repo.listActiveByWorker(workerId);
    const devices: DeviceListItem[] = rows.map((d) => ({
      id: d.id,
      platform: d.platform,
      model: d.model,
      app_version: d.appVersion,
      trusted_at: d.trustedAt.toISOString(),
      last_seen_at: d.lastSeenAt.toISOString(),
      is_current: currentDeviceId !== undefined && d.id === currentDeviceId,
    }));
    return { devices };
  }

  /**
   * Revoke one of the CURRENT worker's devices: mark it revoked, kill its live sessions
   * (so the device is signed out immediately), and emit `worker.device_revoked`. A
   * device id that does not exist OR belongs to another worker OR is already revoked maps
   * to 404 — no oracle distinguishing them (anti-IDOR-enumeration).
   */
  async revokeForWorker(workerId: string, deviceId: string, ctx: RequestContext): Promise<void> {
    const revoked = await this.repo.revoke(workerId, deviceId);
    if (!revoked) throw new NotFoundException("Device not found");

    // Cut every live session bound to this device (best-effort inside).
    await this.sessions.revokeByDevice(workerId, deviceId);

    await this.events.emit({
      event_name: "worker.device_revoked",
      actor: { actor_type: "worker", actor_id: workerId },
      subject: { subject_type: "worker", subject_id: workerId },
      payload: { worker_id: workerId, device_id: deviceId },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }
}
