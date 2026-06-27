import { Body, Controller, Get, HttpCode, Inject, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { IpRateLimit } from "../common/rate-limit/ip-rate-limit.service";
import { AdminAuthGuard, CurrentAdmin, type AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminAuthService } from "./admin-auth.service";
import {
  AdminLoginRequestSchema,
  AdminLoginVerifySchema,
  AdminMfaVerifySchema,
  type AdminLoginRequestDto,
  type AdminLoginVerifyDto,
  type AdminMfaVerifyDto,
  type AdminAuthCodeResponse,
  type AdminMfaRequiredResponse,
  type AdminSessionResponse,
  type AdminRefreshResponse,
  type AdminMeResponse,
} from "./admin-auth.dto";

/**
 * Admin Ops Portal auth surface (ADR-0025 ADMIN-1) — a NEW route group under `/admin/*` for
 * the 4th, highly-privileged principal. DISTINCT from the worker `/auth/*`, the payer
 * `/payer/*`, and the ops `InternalServiceGuard` routes (one principal class per route).
 *
 * PUBLIC (untrusted boundary, IP-rate-limited): `login/request`, `login/verify`, `mfa/verify`
 * — these are the ONLY unguarded admin routes. EVERY other admin route requires a valid admin
 * session via {@link AdminAuthGuard}. No code/secret is ever returned to the client; the
 * session token rides the Bearer/`x-session-token` channel (the admin web stores it httpOnly).
 *
 * MUST-FIX #1: a verified OTP does NOT mint a session — `login/verify` returns `mfa_required`
 * until the second factor passes via `mfa/verify` (enforced in {@link AdminAuthService}).
 */
@Controller("admin")
export class AdminAuthController {
  constructor(
    private readonly auth: AdminAuthService,
    private readonly ipRateLimit: IpRateLimit,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  /** PUBLIC — request a login code (NO-ENUMERATION: identical for unknown/inactive emails). */
  @Post("login/request")
  @HttpCode(200)
  async requestLogin(
    @Body(new ZodValidationPipe(AdminLoginRequestSchema)) dto: AdminLoginRequestDto,
    @Req() req: Request,
  ): Promise<AdminAuthCodeResponse> {
    await this.assertWithinIpCap(req);
    return this.auth.requestLogin(dto);
  }

  /** PUBLIC — verify a login code. Returns `mfa_required` (no session yet) per must-fix #1. */
  @Post("login/verify")
  @HttpCode(200)
  async verifyLogin(
    @Body(new ZodValidationPipe(AdminLoginVerifySchema)) dto: AdminLoginVerifyDto,
    @Req() req: Request,
    @Ctx() ctx: RequestContext,
  ): Promise<AdminMfaRequiredResponse | AdminSessionResponse> {
    await this.assertWithinIpCap(req);
    return this.auth.verifyLogin(dto, ctx);
  }

  /** PUBLIC — the second factor (TOTP). On success the session is minted (must-fix #1). */
  @Post("mfa/verify")
  @HttpCode(200)
  async verifyMfa(
    @Body(new ZodValidationPipe(AdminMfaVerifySchema)) dto: AdminMfaVerifyDto,
    @Req() req: Request,
    @Ctx() ctx: RequestContext,
  ): Promise<AdminSessionResponse> {
    await this.assertWithinIpCap(req);
    return this.auth.verifyMfa(dto, ctx);
  }

  /** Mint a fresh rolling token for the current admin session. */
  @Post("refresh")
  @HttpCode(200)
  @UseGuards(AdminAuthGuard)
  refresh(@CurrentAdmin() admin: AuthenticatedAdmin): Promise<AdminRefreshResponse> {
    return this.auth.refresh(admin.id, admin.sid, admin.role);
  }

  /** Revoke the current admin session (logout) + emit the PII-free revoke event. */
  @Post("logout")
  @HttpCode(204)
  @UseGuards(AdminAuthGuard)
  async logout(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Ctx() ctx: RequestContext,
  ): Promise<void> {
    await this.auth.logout(admin.id, admin.sid, ctx);
  }

  /** The authenticated admin's own identity (PII-FREE: id + role only). */
  @Get("me")
  @UseGuards(AdminAuthGuard)
  me(@CurrentAdmin() admin: AuthenticatedAdmin): AdminMeResponse {
    return { admin_id: admin.id, role: admin.role };
  }

  /** Per-IP hourly cap on the public admin-auth endpoints (XB-H; fails closed on Redis down). */
  private assertWithinIpCap(req: Request): Promise<void> {
    return this.ipRateLimit.assertWithinHourlyIpCap(
      "admin_auth",
      req.ip ?? "unknown",
      this.config.ADMIN_AUTH_MAX_PER_IP_PER_HOUR,
    );
  }
}
