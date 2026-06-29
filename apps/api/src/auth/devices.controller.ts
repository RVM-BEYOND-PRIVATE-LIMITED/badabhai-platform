import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { DevicesService } from "./devices.service";
import { WorkerAuthGuard, CurrentWorker, type AuthenticatedWorker } from "./worker-auth.guard";
import type { DeviceListResponse } from "./devices.dto";

/**
 * Trusted-device management for the authenticated worker (ADR-0026 Phase 2). Every route
 * is worker-guarded and scoped to `worker.id` from the token — never a body/path id — so
 * a worker can only ever see or revoke their OWN devices.
 */
@Controller("auth/devices")
@UseGuards(WorkerAuthGuard)
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  /** List the current worker's active devices (the caller's own is flagged is_current). */
  @Get()
  list(@CurrentWorker() worker: AuthenticatedWorker): Promise<DeviceListResponse> {
    return this.devices.listForWorker(worker.id, worker.deviceId);
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
