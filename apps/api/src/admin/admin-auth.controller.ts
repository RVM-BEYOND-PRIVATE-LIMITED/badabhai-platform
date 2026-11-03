import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { IpRateLimit } from "../common/rate-limit/ip-rate-limit.service";
import {
  AdminAuthGuard,
  CurrentAdmin,
  type AuthenticatedAdmin,
  type AuthenticatedAdminSession,
} from "./admin-auth.guard";
import { AdminAuthService } from "./admin-auth.service";
import { AdminPasswordService } from "./admin-password.service";
import { AdminMfaSelfService } from "./admin-mfa-self.service";
import { capabilitiesFor } from "./admin-capabilities";
import {
  AdminLoginRequestSchema,
  AdminLoginVerifySchema,
  AdminMfaVerifySchema,
  AdminInviteAcceptSchema,
  AdminPasswordLoginSchema,
  AdminPasswordForgotSchema,
  AdminPasswordResetSchema,
  AdminChangePasswordSchema,
  AdminMfaCodeSchema,
  type AdminLoginRequestDto,
  type AdminLoginVerifyDto,
  type AdminMfaVerifyDto,
  type AdminInviteAcceptDto,
  type AdminPasswordLoginDto,
  type AdminPasswordForgotDto,
  type AdminPasswordResetDto,
  type AdminChangePasswordDto,
  type AdminMfaCodeDto,
  type AdminAuthCodeResponse,
  type AdminInviteAcceptedResponse,
  type AdminMfaRequiredResponse,
  type AdminSessionResponse,
  type AdminRefreshResponse,
  type AdminMeResponse,
  type AdminPasswordChangeRequiredResponse,
  type AdminPasswordResetResponse,
  type AdminMfaEnrollmentResponse,
  type AdminMfaStateResponse,
} from "./admin-auth.dto";

/**
 * Admin Ops Portal auth surface (ADR-0025 ADMIN-1) — a NEW route group under `/admin/*` for
 * the 4th, highly-privileged principal. DISTINCT from the worker `/auth/*`, the payer
 * `/payer/*`, and the ops `InternalServiceGuard` routes (one principal class per route).
 *
 * PUBLIC (untrusted boundary, IP-rate-limited): `login/request`, `login/verify`, `mfa/verify`,
 * `invites/accept`, and (0144) `login/password`, `password/forgot`, `password/reset` — these are
 * the ONLY unguarded admin routes. EVERY other admin route
 * requires a valid admin session via {@link AdminAuthGuard}. `invites/accept` is unguarded on
 * the same grounds as the login routes and no weaker ones: its caller has no session yet, and
 * the single-use invite token is the credential it presents. No code/secret is ever returned to the client; the
 * session token rides the Bearer/`x-session-token` channel (the admin web stores it httpOnly).
 *
 * MFA GATE: for an admin whose two-step is ON, a verified first factor does NOT mint a session
 * — `login/verify` / `login/password` return `mfa_required` until the second factor passes via
 * `mfa/verify` (or a trusted device is presented). With two-step OFF (owner Amendment 1, the
 * default) they return the session directly. Enforced in {@link AdminAuthService}.
 *
 * MIGRATION 0144 adds three more PUBLIC routes on the same footing and the same IP cap —
 * `login/password`, `password/forgot`, `password/reset` (no session exists yet; the password or
 * the emailed reset code is the credential) — and four SELF routes behind the session:
 * `me/password`, `me/mfa/enable`, `me/mfa/confirm`, `me/mfa/disable`. Every one takes its
 * identity from the guard; none accepts an admin id from a body.
 */
@Controller("admin")
export class AdminAuthController {
  constructor(
    private readonly auth: AdminAuthService,
    private readonly ipRateLimit: IpRateLimit,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly passwords: AdminPasswordService,
    private readonly mfaSelf: AdminMfaSelfService,
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

  /**
   * PUBLIC — password sign-in (0144). Answers `password_change_required` (temporary password,
   * no `new_password`), `mfa_required`, or a session. Every failure is the same neutral 401.
   */
  @Post("login/password")
  @HttpCode(200)
  async loginWithPassword(
    @Body(new ZodValidationPipe(AdminPasswordLoginSchema)) dto: AdminPasswordLoginDto,
    @Req() req: Request,
    @Ctx() ctx: RequestContext,
  ): Promise<AdminPasswordChangeRequiredResponse | AdminMfaRequiredResponse | AdminSessionResponse> {
    await this.assertWithinIpCap(req);
    return this.passwords.loginWithPassword(dto, ctx);
  }

  /** PUBLIC — email a password-reset code (NO-ENUMERATION: identical for every email). */
  @Post("password/forgot")
  @HttpCode(200)
  async forgotPassword(
    @Body(new ZodValidationPipe(AdminPasswordForgotSchema)) dto: AdminPasswordForgotDto,
    @Req() req: Request,
  ): Promise<AdminAuthCodeResponse> {
    await this.assertWithinIpCap(req);
    return this.passwords.requestReset(dto);
  }

  /** PUBLIC — redeem a reset code + set a new password. NEVER mints a session. */
  @Post("password/reset")
  @HttpCode(200)
  async resetPassword(
    @Body(new ZodValidationPipe(AdminPasswordResetSchema)) dto: AdminPasswordResetDto,
    @Req() req: Request,
    @Ctx() ctx: RequestContext,
  ): Promise<AdminPasswordResetResponse> {
    await this.assertWithinIpCap(req);
    return this.passwords.resetPassword(dto, ctx);
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
  refresh(@CurrentAdmin() admin: AuthenticatedAdminSession): Promise<AdminRefreshResponse> {
    // B2 — re-mint on the credential epoch the guard validated THIS request against.
    return this.auth.refresh(admin.id, admin.sid, admin.role, admin.passwordEpoch);
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
  async me(@CurrentAdmin() admin: AuthenticatedAdmin): Promise<AdminMeResponse> {
    return {
      admin_id: admin.id,
      role: admin.role,
      capabilities: capabilitiesFor(admin.role),
      // 0144 — has_password / must_change_password / mfa_enabled, read from the live row.
      ...(await this.auth.accountFlags(admin.id)),
    };
  }

  /**
   * Set (first time) or change the session admin's OWN password (0144). Returns a FRESH session —
   * the change moved the session cut-off past the caller's current token.
   */
  @Post("me/password")
  @HttpCode(200)
  @UseGuards(AdminAuthGuard)
  changeOwnPassword(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body(new ZodValidationPipe(AdminChangePasswordSchema)) dto: AdminChangePasswordDto,
    @Ctx() ctx: RequestContext,
  ): Promise<AdminSessionResponse> {
    return this.passwords.changeOwnPassword(admin, dto, ctx);
  }

  /**
   * Start switching the session admin's OWN two-step ON (Amendment 1): a fresh authenticator
   * secret, shown once — hence no-store. Takes no body.
   */
  @Post("me/mfa/enable")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @UseGuards(AdminAuthGuard)
  enableMfa(@CurrentAdmin() admin: AuthenticatedAdmin): Promise<AdminMfaEnrollmentResponse> {
    return this.mfaSelf.enable(admin.id);
  }

  /** Confirm the staged authenticator with one code → two-step ON. */
  @Post("me/mfa/confirm")
  @HttpCode(200)
  @UseGuards(AdminAuthGuard)
  confirmMfa(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body(new ZodValidationPipe(AdminMfaCodeSchema)) dto: AdminMfaCodeDto,
    @Ctx() ctx: RequestContext,
  ): Promise<AdminMfaStateResponse> {
    return this.mfaSelf.confirm(admin.id, dto.code, ctx);
  }

  /** Switch two-step OFF — a valid CURRENT authenticator code is required. */
  @Post("me/mfa/disable")
  @HttpCode(200)
  @UseGuards(AdminAuthGuard)
  disableMfa(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body(new ZodValidationPipe(AdminMfaCodeSchema)) dto: AdminMfaCodeDto,
    @Ctx() ctx: RequestContext,
  ): Promise<AdminMfaStateResponse> {
    return this.mfaSelf.disable(admin.id, dto.code, ctx);
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
