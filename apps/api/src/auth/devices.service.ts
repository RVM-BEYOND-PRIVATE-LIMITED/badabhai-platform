import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { RequestContext } from "../common/request-context";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { EventsService } from "../events/events.service";
import { SessionService } from "./session.service";
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
        await this.events.emit({
          event_name: "worker.device_registered",
          actor: { actor_type: "worker", actor_id: workerId },
          subject: { subject_type: "worker", subject_id: workerId },
          payload: { worker_id: workerId, device_id: device.id },
          correlationId: ctx.correlationId,
          requestId: ctx.requestId,
        });
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
