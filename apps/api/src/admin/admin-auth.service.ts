import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { AdminUser } from "@badabhai/db";
import { SERVER_CONFIG } from "../config/config.module";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { AdminRepository } from "./admin.repository";
import { AdminOtpService } from "./admin-otp.service";
import { AdminSessionService } from "./admin-session.service";
import { AdminMfaSecretStore } from "./admin-mfa.store";
import { generateTotpEnrollment, verifyTotp } from "./admin-mfa";
import type {
  AdminLoginRequestDto,
  AdminLoginVerifyDto,
  AdminMfaVerifyDto,
  AdminAuthCodeResponse,
  AdminMfaRequiredResponse,
  AdminSessionResponse,
  AdminRefreshResponse,
} from "./admin-auth.dto";

/**
 * Admin auth orchestration (ADR-0025 ADMIN-1) — the login flow for the 4th principal:
 *   request code (no-enumeration) → verify code → **MFA gate** → mint session.
 *
 * MUST-FIX #1 (MFA enforced server-side AT SESSION-MINT for ALL roles — owner OQ-1): a
 * verified-OTP admin does NOT get a full session unless the second factor is satisfied.
 *   - A `mfa_enrolled = false` admin (any role) gets ONLY an enrollment step (a TOTP secret
 *     to set up) — NEVER a session.
 *   - An enrolled admin must pass a TOTP step (POST /admin/mfa/verify) before a session is minted.
 *   - When ADMIN_MFA_REQUIRED is false (non-default), the OTP-verified path mints directly —
 *     but the default (and the owner decision) is MFA for ALL roles.
 * STATUS-GATING: only an `'active'` admin authenticates; `'pending'` (invited, not activated)
 * and `'suspended'` admins authenticate to NOTHING — they get the SAME neutral OTP-failure
 * response (no oracle), exactly as an unknown email does.
 *
 * NO-ENUMERATION (XB-H): login/request runs the IDENTICAL OTP reserve for a known and an
 * unknown email (via {@link AdminOtpService.issueWithoutDelivery}); verify mints / advances
 * to MFA ONLY for a real, active account and otherwise returns the SAME "incorrect or expired"
 * 401. No `admin.*` event is emitted on the unknown/inactive branch (no subject).
 *
 * PRIVACY: the admin email is accepted, hashed for lookup, and NEVER logged / put in an event
 * (CLAUDE.md invariant #2). The only admin token in events is the opaque `admin_id`. Emits
 * `admin.session_started` on a successful mint and `admin.session_revoked` on logout (PII-free).
 */
@Injectable()
export class AdminAuthService {
  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly admins: AdminRepository,
    private readonly otp: AdminOtpService,
    private readonly sessions: AdminSessionService,
    private readonly mfaStore: AdminMfaSecretStore,
    private readonly events: EventsService,
  ) {}

  /** POST /admin/login/request — issue a code; NO-ENUMERATION across known/unknown emails. */
  async requestLogin(dto: AdminLoginRequestDto): Promise<AdminAuthCodeResponse> {
    const emailHash = this.admins.emailHash(dto.email);
    const account = await this.admins.findByEmailHash(emailHash);

    // Reserve a code identically for BOTH branches so the timing/response + 429s match. A code
    // is reserved even for an inactive/unknown account; it is simply never delivered, and verify
    // mints nothing for it (no oracle). Delivery is a deferred stream in ADMIN-1.
    if (account && account.status === "active") {
      await this.otp.issueAndSend(emailHash);
    } else {
      await this.otp.issueWithoutDelivery(emailHash);
    }
    return this.codeResponse();
  }

  /**
   * POST /admin/login/verify — verify the OTP, then apply the MFA gate (must-fix #1).
   * Returns either `mfa_required` (no session) or, when MFA is not required, a session.
   */
  async verifyLogin(dto: AdminLoginVerifyDto, ctx: RequestContext): Promise<AdminMfaRequiredResponse | AdminSessionResponse> {
    const emailHash = this.admins.emailHash(dto.email);

    // Verify FIRST (single message on failure — constant-time, single-use, no enumeration).
    await this.otp.verify(emailHash, dto.code);

    // A reserved code for an UNKNOWN/INACTIVE email can verify, but we advance ONLY for a real,
    // ACTIVE account — otherwise the SAME 401 (no oracle). pending/suspended → authenticates to
    // nothing (neutral).
    const account = await this.requireActiveAccount(emailHash);

    return this.gateMfaThenMaybeMint(account, ctx);
  }

  /**
   * POST /admin/mfa/verify — the second factor. Validates the submitted TOTP against the
   * admin's stored secret; on success marks the admin mfa_enrolled (first-time enroll) and
   * mints the session. A wrong/expired TOTP, an inactive/unknown account, or a missing stored
   * secret all return the SAME neutral 401 (no oracle). The TOTP secret itself is only ever
   * provisioned on the OTP-gated enrollment branch of `verifyLogin`, so possessing a valid
   * TOTP already implies a prior OTP-gated enrollment for this account.
   *
   * NOTE: this step is independently rate-limited at the controller (per-IP cap) like the OTP
   * routes. A future hardening can bind it to a short-lived OTP-pending marker minted by
   * `verifyLogin` (an `admin_mfa_pending:<emailHash>` Redis flag) to require OTP success in the
   * SAME flow; the seam is here. ADMIN-1 ships the secret-possession binding above.
   */
  async verifyMfa(dto: AdminMfaVerifyDto, ctx: RequestContext): Promise<AdminSessionResponse> {
    const emailHash = this.admins.emailHash(dto.email);
    const account = await this.requireActiveAccount(emailHash);

    // SINGLE-FLOW binding: this admin must have passed OTP in the SAME (recent) flow — the
    // marker is set by verifyLogin's MFA branch and consumed (single-use) here. Absent/expired
    // → fail closed (same 401), so a leaked TOTP secret alone cannot mint a session without a
    // fresh OTP success. Consume BEFORE the TOTP check so a wrong code still burns the marker.
    const otpPassed = await this.mfaStore.consumeOtpPending(account.id);
    if (!otpPassed) throw new UnauthorizedException("Incorrect or expired code");

    const secret = await this.mfaStore.load(account.id);
    // No stored secret → cannot verify a second factor → fail closed (same 401 as a wrong code).
    if (!secret) throw new UnauthorizedException("Incorrect or expired code");

    const ok = verifyTotp(secret, dto.code);
    if (!ok) throw new UnauthorizedException("Incorrect or expired code");

    // First successful TOTP also confirms enrollment (idempotent if already enrolled).
    if (!account.mfaEnrolled) await this.admins.setMfaEnrolled(account.id, true);

    return this.mintSession(account, ctx);
  }

  /** POST /admin/refresh — mint a fresh JWT for the already-validated admin+session. */
  async refresh(adminId: string, sid: string, role: AdminUser["role"]): Promise<AdminRefreshResponse> {
    const fresh = await this.sessions.mint(adminId, sid, role);
    return {
      access_token: fresh.token,
      token_type: "Bearer",
      expires_in_seconds: fresh.expiresInSeconds,
    };
  }

  /** POST /admin/logout — revoke the current session + emit the PII-free revoke event. */
  async logout(adminId: string, sid: string, ctx: RequestContext): Promise<void> {
    await this.sessions.revoke(sid);
    await this.events.emit({
      event_name: "admin.session_revoked",
      actor: { actor_type: "admin", actor_id: adminId },
      subject: { subject_type: "admin_session", subject_id: adminId },
      payload: { admin_id: adminId },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }

  // ---------------------------------------------------------------------------

  /**
   * The MFA gate (must-fix #1). Decides what a verified-OTP admin gets:
   *   - MFA NOT required (config off) → mint a session directly.
   *   - MFA required + NOT enrolled → an enrollment step ONLY (a fresh TOTP secret), NO session.
   *   - MFA required + enrolled → `mfa_required` with no enrollment material; the admin must
   *     POST /admin/mfa/verify to complete and get a session. NO session is minted here.
   * In NO branch does a `mfa_enrolled=false` admin (any role) receive a full session.
   */
  private async gateMfaThenMaybeMint(
    account: AdminUser,
    ctx: RequestContext,
  ): Promise<AdminMfaRequiredResponse | AdminSessionResponse> {
    if (!this.config.ADMIN_MFA_REQUIRED) {
      return this.mintSession(account, ctx);
    }

    // Mark OTP-passed for the single-flow OTP→MFA binding (consumed by verifyMfa). Set on BOTH
    // MFA branches so the subsequent TOTP step is reachable only after a fresh OTP success.
    await this.mfaStore.markOtpPassed(account.id);

    if (!account.mfaEnrolled) {
      // Enrollment step ONLY — provision a fresh TOTP secret (account label = the opaque admin
      // id, NEVER the email, to keep PII out of the otpauth URI/QR). NO session is minted.
      const enrollment = generateTotpEnrollment(this.config.ADMIN_TOTP_ISSUER, account.id);
      await this.mfaStore.save(account.id, enrollment.secret);
      return {
        status: "mfa_required",
        needs_enrollment: true,
        enrollment: { secret: enrollment.secret, otpauth_uri: enrollment.otpauthUri },
      };
    }

    // Enrolled → require the TOTP step (POST /admin/mfa/verify). No session yet, no secret leaked.
    return { status: "mfa_required", needs_enrollment: false };
  }

  /** Mint the session + emit `admin.session_started` (PII-free). Touch last_login (best-effort). */
  private async mintSession(account: AdminUser, ctx: RequestContext): Promise<AdminSessionResponse> {
    const session = await this.sessions.create(account.id, account.role);
    await this.events.emit({
      event_name: "admin.session_started",
      actor: { actor_type: "admin", actor_id: account.id },
      subject: { subject_type: "admin_session", subject_id: account.id },
      payload: { admin_id: account.id, role: account.role },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
    await this.admins.touchLastLogin(account.id).catch(() => undefined);

    return {
      access_token: session.token,
      token_type: "Bearer",
      expires_in_seconds: session.expiresInSeconds,
      admin_id: account.id,
      role: account.role,
    };
  }

  /**
   * Resolve a real, ACTIVE admin by email hash or throw the SAME neutral 401 (no oracle) used
   * for a wrong OTP. A `pending`/`suspended` admin authenticates to NOTHING (must-fix #1 /
   * status-gating). An unknown email also lands here → same 401.
   */
  private async requireActiveAccount(emailHash: string): Promise<AdminUser> {
    const account = await this.admins.findByEmailHash(emailHash);
    if (!account || account.status !== "active") {
      throw new UnauthorizedException("Incorrect or expired code");
    }
    return account;
  }

  private codeResponse(): AdminAuthCodeResponse {
    return { status: "code_sent", resend_in_seconds: this.config.OTP_RESEND_COOLDOWN_SECONDS };
  }
}
