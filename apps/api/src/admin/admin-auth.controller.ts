import { Body, Controller, Get, HttpCode, Inject, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { IpRateLimit } from "../common/rate-limit/ip-rate-limit.service";
import { AdminAuthGuard, CurrentAdmin, type AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminAuthService } from "./admin-auth.service";
import { capabilitiesFor } from "./admin-capabilities";
import {
  AdminLoginRequestSchema,
  AdminLoginVerifySchema,
  AdminMfaVerifySchema,
  AdminInviteAcceptSchema,
  type AdminLoginRequestDto,
  type AdminLoginVerifyDto,
  type AdminMfaVerifyDto,
  type AdminInviteAcceptDto,
  type AdminAuthCodeResponse,
  type AdminInviteAcceptedResponse,
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
 * PUBLIC (untrusted boundary, IP-rate-limited): `login/request`, `login/verify`, `mfa/verify`,
 * `invites/accept` — these are the ONLY unguarded admin routes. EVERY other admin route
 * requires a valid admin session via {@link AdminAuthGuard}. `invites/accept` is unguarded on
 * the same grounds as the login routes and no weaker ones: its caller has no session yet, and
 * the single-use invite token is the credential it presents. No code/secret is ever returned to the client; the
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

  /**
   * PUBLIC — redeem an invite accept link (`pending` → `active`).
   *
   * Unguarded for the same reason the login routes are: the invitee has no session yet. The
   * single-use token is the credential, so this carries the SAME IP cap as the login routes —
   * it is a guessable-secret surface and deserves the identical brute-force ceiling.
   *
   * Returns 200, not 201: nothing is created here. The admin row has existed since the invite;
   * this activates it.
   */
  @Post("invites/accept")
  @HttpCode(200)
  async acceptInvite(
    @Body(new ZodValidationPipe(AdminInviteAcceptSchema)) dto: AdminInviteAcceptDto,
    @Req() req: Request,
    @Ctx() ctx: RequestContext,
  ): Promise<AdminInviteAcceptedResponse> {
    await this.assertWithinIpCap(req);
    return this.auth.acceptInvite(dto, ctx);
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

  /**
   * The authenticated admin's own identity (PII-FREE: id, role, capabilities).
   *
   * `capabilities` is resolved SERVER-SIDE from the capability matrix so the Admin Portal can
   * render role-aware UI without shipping its own copy of the authorization table. It is a
   * rendering hint only — every route re-checks `@RequireAdminRole` on its own, so a client
   * that ignores or forges this list gains nothing but 403s.
   */
  @Get("me")
  @UseGuards(AdminAuthGuard)
  me(@CurrentAdmin() admin: AuthenticatedAdmin): AdminMeResponse {
    return {
      admin_id: admin.id,
      role: admin.role,
      capabilities: capabilitiesFor(admin.role),
    };
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
