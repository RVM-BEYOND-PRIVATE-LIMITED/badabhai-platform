import { Body, Controller, HttpCode, Inject, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import type { ServerConfig } from "@badabhai/config";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { SERVER_CONFIG } from "../config/config.module";
import { IpRateLimit } from "../common/rate-limit/ip-rate-limit.service";
import { PinService } from "./pin.service";
import { WorkerAuthGuard, CurrentWorker, type AuthenticatedWorker } from "./worker-auth.guard";
import {
  PinSetSchema,
  PinVerifySchema,
  PinResetRequestSchema,
  PinResetConfirmSchema,
  type PinSetDto,
  type PinVerifyDto,
  type PinResetRequestDto,
  type PinResetConfirmDto,
  type PinVerifyResponse,
} from "./pin.dto";

/**
 * Device-bound unlock PIN (ADR-0026 Phase 3).
 *
 * - POST /auth/pin/set — worker-guarded; the worker id comes from the token (CurrentWorker),
 *   NEVER a body field. 204 on success.
 * - POST /auth/pin/verify — NO guard: the device-bound refresh token in the body IS the
 *   credential (the access JWT may have expired). Returns the login-shape session on success,
 *   a NEUTRAL 401 on every failure (the service throws it — no oracle).
 * - POST /auth/pin/reset/request|confirm — OTP-gated reset reusing the existing OTP path.
 *
 * Identity for /verify is always derived from the refresh token server-side (the SIM-swap
 * defense); a new/unknown device has no trusted refresh token ⇒ the worker must OTP.
 */
@Controller("auth/pin")
export class PinController {
  constructor(
    private readonly pin: PinService,
    private readonly ipRateLimit: IpRateLimit,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  /** Set/replace the authenticated worker's PIN. 204 No Content. */
  @Post("set")
  @HttpCode(204)
  @UseGuards(WorkerAuthGuard)
  async set(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(PinSetSchema)) dto: PinSetDto,
    @Ctx() ctx: RequestContext,
  ): Promise<void> {
    await this.pin.setPin(worker.id, dto.pin, ctx);
  }

  /**
   * Verify a device-bound PIN. NO guard — the refresh token IS the credential. Returns the
   * login-shape session on success; the service throws a neutral 401 on any failure.
   */
  @Post("verify")
  @HttpCode(200)
  verify(
    @Body(new ZodValidationPipe(PinVerifySchema)) dto: PinVerifyDto,
    @Ctx() ctx: RequestContext,
  ): Promise<PinVerifyResponse> {
    return this.pin.verifyPin(
      { refreshToken: dto.refresh_token, pin: dto.pin, deviceId: dto.device_id },
      ctx,
    );
  }

  /**
   * Start a PIN reset — send an OTP to the phone (reuses the existing OTP send path). Guarded
   * by the per-IP hourly cap FIRST (security Finding 2): this reset send previously reached the
   * OTP path WITHOUT the network-level backstop the login route applies.
   */
  @Post("reset/request")
  @HttpCode(200)
  async resetRequest(
    @Body(new ZodValidationPipe(PinResetRequestSchema)) dto: PinResetRequestDto,
    @Req() req: Request,
    @Ctx() ctx: RequestContext,
  ): Promise<{ success: true }> {
    // Per-IP hourly cap BEFORE the send — the SAME backstop auth.controller requestOtp uses,
    // sharing the "otp_request" scope so PIN-reset + login draw from ONE per-IP SMS budget.
    // Fails closed (429) if Redis is down. (Finding 2: this path bypassed the per-IP cap.)
    await this.ipRateLimit.assertWithinHourlyIpCap(
      "otp_request",
      req.ip ?? "unknown",
      this.config.OTP_MAX_SENDS_PER_HOUR,
    );
    await this.pin.resetRequest(dto.phone, ctx);
    return { success: true };
  }

  /** Confirm a PIN reset — verify the OTP and set the new PIN. 204 No Content. */
  @Post("reset/confirm")
  @HttpCode(204)
  async resetConfirm(
    @Body(new ZodValidationPipe(PinResetConfirmSchema)) dto: PinResetConfirmDto,
    @Ctx() ctx: RequestContext,
  ): Promise<void> {
    await this.pin.resetConfirm(dto.phone, dto.otp, dto.pin, ctx);
  }
}
