import { Body, Controller, HttpCode, Inject, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { IpRateLimit } from "../common/rate-limit/ip-rate-limit.service";
import { PayerAuthGuard, CurrentPayer, type AuthenticatedPayer } from "../payers/payer-auth.guard";
import { PayerAuthService } from "./payer-auth.service";
import {
  PayerSignupSchema,
  PayerLoginRequestSchema,
  PayerLoginVerifySchema,
  type PayerSignupDto,
  type PayerLoginRequestDto,
  type PayerLoginVerifyDto,
  type PayerAuthCodeResponse,
  type PayerSessionResponse,
  type PayerRefreshResponse,
} from "./payer-auth.dto";

/**
 * Self-serve PAYER auth surface (ADR-0019 Decision B — closes R16/LC-1/TD33). A NEW route
 * group under `/payer/*` for the THIRD principal — DISTINCT from the worker `/auth/*`
 * (WorkerAuthGuard) and the ops `InternalServiceGuard` routes. Signup + login are PUBLIC
 * (an external untrusted boundary); refresh + logout require a valid payer session.
 *
 * XB-H (auth hardening): the public endpoints are PER-IP rate-limited (an account-farming /
 * credential-stuffing backstop, fail-closed via {@link IpRateLimit}); the no-enumeration
 * and per-account OTP throttling live in {@link PayerAuthService} / {@link PayerOtpService};
 * sessions are signed + revocable + rolling ({@link PayerSessionService}). Mock + staging-
 * only (ADR-0019 Phase 1); a `bb-security-review` PASS (XB-A…XB-H) is the pre-merge gate.
 */
@Controller("payer")
export class PayerAuthController {
  constructor(
    private readonly auth: PayerAuthService,
    private readonly ipRateLimit: IpRateLimit,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  /** Create a payer account (company=employer / agency=agent) + issue a login code. */
  @Post("signup")
  @HttpCode(200)
  async signup(
    @Body(new ZodValidationPipe(PayerSignupSchema)) dto: PayerSignupDto,
    @Req() req: Request,
    @Ctx() ctx: RequestContext,
  ): Promise<PayerAuthCodeResponse> {
    await this.assertWithinIpCap(req);
    return this.auth.signup(dto, ctx);
  }

  /** Request a login code for an existing account (NO-ENUMERATION: identical for unknowns). */
  @Post("login/request")
  @HttpCode(200)
  async requestLogin(
    @Body(new ZodValidationPipe(PayerLoginRequestSchema)) dto: PayerLoginRequestDto,
    @Req() req: Request,
    @Ctx() ctx: RequestContext,
  ): Promise<PayerAuthCodeResponse> {
    await this.assertWithinIpCap(req);
    return this.auth.requestLogin(dto, ctx);
  }

  /** Verify a login code and mint a payer session. */
  @Post("login/verify")
  @HttpCode(200)
  async verifyLogin(
    @Body(new ZodValidationPipe(PayerLoginVerifySchema)) dto: PayerLoginVerifyDto,
    @Req() req: Request,
    @Ctx() ctx: RequestContext,
  ): Promise<PayerSessionResponse> {
    await this.assertWithinIpCap(req);
    return this.auth.verifyLogin(dto, ctx);
  }

  /** Mint a fresh rolling token for the current payer session. */
  @Post("refresh")
  @HttpCode(200)
  @UseGuards(PayerAuthGuard)
  refresh(@CurrentPayer() payer: AuthenticatedPayer): Promise<PayerRefreshResponse> {
    return this.auth.refresh(payer.id, payer.sid);
  }

  /** Revoke the current payer session (logout). */
  @Post("logout")
  @HttpCode(204)
  @UseGuards(PayerAuthGuard)
  async logout(@CurrentPayer() payer: AuthenticatedPayer): Promise<void> {
    await this.auth.logout(payer.sid);
  }

  /** Per-IP hourly cap on the public payer-auth endpoints (XB-H; fails closed on Redis down). */
  private assertWithinIpCap(req: Request): Promise<void> {
    return this.ipRateLimit.assertWithinHourlyIpCap(
      "payer_auth",
      req.ip ?? "unknown",
      this.config.PAYER_AUTH_MAX_PER_IP_PER_HOUR,
    );
  }
}
