import { Body, Controller, HttpCode, Inject, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import type { ServerConfig } from "@badabhai/config";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { SERVER_CONFIG } from "../config/config.module";
import { IpRateLimit } from "../common/rate-limit/ip-rate-limit.service";
import { senderOf } from "../common/rate-limit/request-sender";
import { PinService } from "./pin.service";
import { OtpRequestIdempotency } from "./otp-request-idempotency.service";
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
  type PinResetConfirmResponse,
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
 *   `confirm` returns the SAME login-shape session /auth/otp/verify does (#994), so a reset
 *   recovers a worker whose stored refresh token is dead instead of leaving them on it.
 *
 * Identity for /verify is always derived from the refresh token server-side (the SIM-swap
 * defense); a new/unknown device has no trusted refresh token ⇒ the worker must OTP.
 */
@Controller("auth/pin")
export class PinController {
  constructor(
    private readonly pin: PinService,
    private readonly ipRateLimit: IpRateLimit,
    private readonly otpIdempotency: OtpRequestIdempotency,
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
    // The per-caller caps BEFORE the send — the SAME pair auth.controller requestOtp uses,
    // sharing the "otp_request" / "otp_request_net" scopes so PIN-reset + login draw from ONE
    // SMS budget per sender and per network. Fails closed (429) if Redis is down.
    // (Finding 2: this path bypassed the per-IP cap.)
    //
    // #1035 — keyed on the HANDSET (`X-Device-Id`), not the NAT egress address, for the same
    // reason as the login route: a forgot-PIN worker on a shared factory wifi was locked out
    // by strangers' sign-ins, and this is the route they reach for when they already cannot
    // get in. The reasoning in full is in `request-sender.ts`.
    //
    // MUST stay the same knobs as auth.controller's requestOtp. A cap is an ARGUMENT, not a
    // property of the bucket, so two call sites on one scope passing different numbers means
    // the effective limit depends on which route you happen to hit — a limiter whose ceiling
    // moves under you. They share the buckets, so they share the knobs.
    // #1019 — the SAME transport-retry amplification as /auth/otp/request, on the SAME shared
    // counters (this route sends through the same OtpService and shares the per-IP bucket), so
    // it gets the same guard. Without it, a PIN reset on a flaky link spends the worker's
    // per-phone budget three times over and pushes the global breaker along with it.
    return this.otpIdempotency.runOnce({
      scope: "pin_reset_request",
      phoneE164: dto.phone,
      idempotencyKey: req.header("idempotency-key"),
      // This route already answers identically whether or not the number exists (no
      // enumeration oracle), so the duplicate answer is the same constant the work returns.
      inFlight: () => ({ success: true as const }),
      work: async () => {
        // The sender cap only — the network ceiling was dropped platform-wide on the OTP send
        // path (#1306); the rationale is at the /auth/otp/request call site this mirrors.
        //
        // THIS ROUTE HAD TO MOVE WITH IT, not merely for symmetry. It shares the send route's
        // SCOPES and its KNOBS by deliberate design (the comment above this block: "They share
        // the buckets, so they share the knobs"), so leaving the `otp_request_net` call here
        // would have kept writing — and tripping — a bucket the send route no longer honours.
        // One counter fenced by two call sites that disagree is a limiter whose ceiling moves
        // depending on which route you hit, which is the precise failure that comment forbids.
        await this.ipRateLimit.assertWithinHourlySenderCap(
          "otp_request",
          senderOf(req),
          this.config.OTP_MAX_SENDS_PER_DEVICE_PER_HOUR,
        );
        await this.pin.resetRequest(dto.phone, ctx);
        return { success: true as const };
      },
    });
  }

  /**
   * Confirm a PIN reset — verify the OTP, set the new PIN, and return a FRESH login-shape
   * session (#994). 200, was 204 No Content.
   *
   * The session is the point, not a convenience: a worker only reaches forgot-PIN because
   * unlock is failing, and the dominant cause of that is a DEAD refresh token (a wiped
   * session store), which /auth/pin/verify can only report as its neutral "wrong PIN" 401.
   * Returning 204 left the client on that same dead token, so the reset could not recover
   * them — they re-entered the PIN they had just set and were told it was wrong, forever.
   * See PinService.resetConfirm for the ordering guarantees.
   */
  @Post("reset/confirm")
  @HttpCode(200)
  resetConfirm(
    @Body(new ZodValidationPipe(PinResetConfirmSchema)) dto: PinResetConfirmDto,
    @Ctx() ctx: RequestContext,
  ): Promise<PinResetConfirmResponse> {
    return this.pin.resetConfirm(dto.phone, dto.otp, dto.pin, ctx, dto.device_info);
  }
}
