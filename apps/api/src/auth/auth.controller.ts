import {
  BadRequestException,
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
  TokenRefreshSchema,
  type OtpRequestDto,
  type OtpVerifyDto,
  type TokenRefreshDto,
  type LoginResponse,
  type MeResponse,
  type OtpRequestResponse,
  type RefreshResponse,
  type TokenRefreshResponse,
  type SessionResponse,
  type SessionInfo,
} from "./auth.dto";
import type { SessionView } from "./session.service";

/** Map an internal SessionView (epoch-ms) to the wire SessionInfo (ISO-8601). */
function toSessionInfo(view: SessionView): SessionInfo {
  return {
    tier: view.tier,
    expires_at: new Date(view.expiresAtMs).toISOString(),
    requires_otp_after:
      view.requiresOtpAfterMs === null ? null : new Date(view.requiresOtpAfterMs).toISOString(),
  };
}

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
    return this.auth.verifyOtp(dto.phone, dto.otp, ctx, dto.device_info);
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
    await this.sessions.revoke(worker.sid, worker.id);
  }

  /**
   * Silent rotation of the opaque refresh token (ADR-0026 Phase 1). NO guard — the
   * refresh token in the body IS the credential (the access JWT may have expired). The
   * `Idempotency-Key` header is REQUIRED so an honest double-refresh (flaky-network
   * retry) returns the same rotated pair instead of tripping reuse-detection. A
   * missing/reused/invalid token ⇒ 401.
   */
  @Post("token/refresh")
  @HttpCode(200)
  async tokenRefresh(
    @Body(new ZodValidationPipe(TokenRefreshSchema)) dto: TokenRefreshDto,
    @Req() req: Request,
  ): Promise<TokenRefreshResponse> {
    const idempotencyKey = req.header("idempotency-key")?.trim();
    if (!idempotencyKey) {
      throw new BadRequestException("Idempotency-Key header is required");
    }

    const outcome = await this.sessions.refreshByToken(dto.refresh_token, idempotencyKey);
    if (!outcome.ok) {
      // invalid / reuse_detected / requires_otp all collapse to a 401 (no oracle on which).
      throw new UnauthorizedException("Invalid or expired refresh token");
    }

    const { minted } = outcome;
    return {
      access_token: minted.access.token,
      token_type: "Bearer",
      expires_in_seconds: minted.access.expiresInSeconds,
      refresh_token: minted.refresh.token,
      refresh_expires_in_seconds: minted.refresh.expiresInSeconds,
      session: toSessionInfo(minted.session),
    };
  }

  /**
   * Revoke EVERY active session for the current worker (logout-all). 204 No Content —
   * the count is recorded in the PII-free `worker.logged_out_all` event, not the body.
   */
  @Post("logout-all")
  @HttpCode(204)
  @UseGuards(WorkerAuthGuard)
  async logoutAll(@CurrentWorker() worker: AuthenticatedWorker): Promise<void> {
    await this.sessions.revokeAll(worker.id);
  }

  /** Tier + expiry introspection for the current session (ADR-0026). */
  @Get("session")
  @UseGuards(WorkerAuthGuard)
  async session(@CurrentWorker() worker: AuthenticatedWorker): Promise<SessionResponse> {
    const view = await this.sessions.describe(worker.id, worker.sid);
    if (!view) throw new UnauthorizedException("Invalid or expired session");
    const info = toSessionInfo(view);
    return {
      tier: info.tier,
      expires_at: info.expires_at,
      requires_otp_after: info.requires_otp_after,
    };
  }
}
