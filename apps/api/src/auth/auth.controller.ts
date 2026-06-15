import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { IpRateLimit } from "../common/rate-limit/ip-rate-limit.service";
import { WorkersRepository } from "../workers/workers.repository";
import { AuthService } from "./auth.service";
import { SessionService } from "./session.service";
import {
  WorkerAuthGuard,
  CurrentWorker,
  type AuthenticatedWorker,
} from "./worker-auth.guard";
import {
  OtpRequestSchema,
  OtpVerifySchema,
  type OtpRequestDto,
  type OtpVerifyDto,
  type LoginResponse,
  type MeResponse,
  type OtpRequestResponse,
  type RefreshResponse,
} from "./auth.dto";

/** Bearer token from the Authorization header (the guard already validated it). */
function bearer(req: Request): string {
  const header = req.header("authorization") ?? "";
  const [, value] = header.split(" ");
  if (!value) throw new UnauthorizedException("Missing bearer token");
  return value.trim();
}

@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly workers: WorkersRepository,
    private readonly ipRateLimit: IpRateLimit,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  @Post("otp/request")
  @HttpCode(200)
  async requestOtp(
    @Body(new ZodValidationPipe(OtpRequestSchema)) dto: OtpRequestDto,
    @Req() req: Request,
    @Ctx() ctx: RequestContext,
  ): Promise<OtpRequestResponse> {
    // Per-IP hourly cap BEFORE issuing — a network-level abuse backstop on top of
    // the per-phone cooldown/cap. Fails closed (429) if Redis is down.
    await this.ipRateLimit.assertWithinHourlyIpCap(
      "otp_request",
      req.ip ?? "unknown",
      this.config.OTP_MAX_SENDS_PER_HOUR,
    );
    return this.auth.requestOtp(dto.phone, ctx);
  }

  @Post("otp/verify")
  @HttpCode(200)
  verifyOtp(
    @Body(new ZodValidationPipe(OtpVerifySchema)) dto: OtpVerifyDto,
    @Ctx() ctx: RequestContext,
  ): Promise<LoginResponse> {
    return this.auth.verifyOtp(dto.phone, dto.otp, ctx);
  }

  /** Current worker identity + status (worker-authenticated). */
  @Get("me")
  @UseGuards(WorkerAuthGuard)
  async me(@CurrentWorker() worker: AuthenticatedWorker): Promise<MeResponse> {
    const row = await this.workers.findById(worker.id);
    return { worker_id: worker.id, status: row?.status ?? "active" };
  }

  /** Mint a fresh rolling token for the current session. */
  @Post("refresh")
  @HttpCode(200)
  @UseGuards(WorkerAuthGuard)
  async refresh(@Req() req: Request): Promise<RefreshResponse> {
    const fresh = await this.sessions.refresh(bearer(req));
    if (!fresh) throw new UnauthorizedException("Invalid or expired session");
    return {
      access_token: fresh.token,
      token_type: "Bearer",
      expires_in_seconds: fresh.expiresInSeconds,
    };
  }

  /** Revoke the current session (logout). */
  @Post("logout")
  @HttpCode(204)
  @UseGuards(WorkerAuthGuard)
  async logout(@CurrentWorker() worker: AuthenticatedWorker): Promise<void> {
    await this.sessions.revoke(worker.sid);
  }
}
