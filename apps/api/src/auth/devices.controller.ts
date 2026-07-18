import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Ip,
  Param,
  ParseUUIDPipe,
  Patch,
  UseGuards,
} from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { Ctx, type RequestContext } from "../common/request-context";
import { IpRateLimit } from "../common/rate-limit/ip-rate-limit.service";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { DevicesService } from "./devices.service";
import { WorkerAuthGuard, CurrentWorker, type AuthenticatedWorker } from "./worker-auth.guard";
import {
  UpdatePushTokenSchema,
  type DeviceListResponse,
  type UpdatePushTokenDto,
} from "./devices.dto";

/**
 * Trusted-device management for the authenticated worker (ADR-0026 Phase 2). Every route
 * is worker-guarded and scoped to `worker.id` from the token — never a body/path id — so
 * a worker can only ever see or revoke their OWN devices.
 */
@Controller("auth/devices")
@UseGuards(WorkerAuthGuard)
export class DevicesController {
  constructor(
    private readonly devices: DevicesService,
    private readonly ipRateLimit: IpRateLimit,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  /** List the current worker's active devices (the caller's own is flagged is_current). */
  @Get()
  list(@CurrentWorker() worker: AuthenticatedWorker): Promise<DeviceListResponse> {
    return this.devices.listForWorker(worker.id, worker.deviceId);
  }

  /**
   * ADR-0034 — record the FCM token for the caller's OWN device. 204 No Content.
   *
   * Identity is entirely from the session: the worker from the guard, the device from
   * the token's `did` claim. The body carries ONLY the token — a device/worker id there
   * would be a direct IDOR onto another worker's row.
   *
   * A missing `did`, or a device that is unknown / not owned / revoked, is a silent
   * no-op (still 204) — no oracle distinguishing those cases.
   *
   * Rate-limited per IP: the client re-sends on every token rotation and on app start,
   * so an unthrottled route is a cheap write-amplification surface. Fails closed (429)
   * if Redis is down, exactly like the other capped routes.
   */
  @Patch("me/push-token")
  @HttpCode(204)
  async updatePushToken(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(UpdatePushTokenSchema)) dto: UpdatePushTokenDto,
    @Ip() ip: string,
  ): Promise<void> {
    await this.ipRateLimit.assertWithinHourlyIpCap(
      "push_token_update",
      ip,
      this.config.PUSH_TOKEN_UPDATES_PER_IP_PER_HOUR,
    );
    await this.devices.updatePushToken(worker.id, worker.deviceId, dto.push_token);
  }

  /** Revoke one of the current worker's devices (signs that device out). 204 No Content. */
  @Delete(":id")
  @HttpCode(204)
  revoke(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Ctx() ctx: RequestContext,
  ): Promise<void> {
    return this.devices.revokeForWorker(worker.id, id, ctx);
  }
}
