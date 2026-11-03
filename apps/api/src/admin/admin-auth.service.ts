import { ConflictException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { AdminUser } from "@badabhai/db";
import { SERVER_CONFIG } from "../config/config.module";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { AdminRepository } from "./admin.repository";
import { AdminOtpService } from "./admin-otp.service";
import { AdminInviteService } from "./admin-invite.service";
import { AdminSessionService } from "./admin-session.service";
import { AdminMfaSecretStore } from "./admin-mfa.store";
import { AdminTrustedDeviceService } from "./admin-trusted-device.service";
import { AdminAttemptLockoutService } from "./admin-attempt-lockout.service";
import { passwordEpochOf } from "./admin-credential-epoch";
import { ADMIN_ACTION_CODES } from "./admin-actions.service";
import { emitAdminAccountAction } from "./admin-account-event";
import { generateTotpEnrollment, verifyTotp } from "./admin-mfa";
import type {
  AdminLoginRequestDto,
  AdminLoginVerifyDto,
  AdminMfaVerifyDto,
  AdminInviteAcceptDto,
  AdminAuthCodeResponse,
  AdminInviteAcceptedResponse,
  AdminMfaRequiredResponse,
  AdminSessionResponse,
  AdminRefreshResponse,
  AdminAccountFlags,
} from "./admin-auth.dto";

/** 409 copy when an emailed-code sign-in meets an account that must replace its temporary password. */
export const MUST_CHANGE_VIA_PASSWORD =
  "Sign in with your password to replace the temporary one first, or use Forgot password";

/**
 * Admin auth orchestration (ADR-0025 ADMIN-1) — the login flow for the 4th principal:
 *   first factor (emailed code, or — migration 0144 — a password) → **MFA gate** → session.
 *
 * THE MFA GATE (`gateMfaThenMaybeMint`, shared by BOTH first factors). Must-fix #1 originally
 * made TOTP mandatory for every role; owner AMENDMENT 1 (2026-11-03) made it OPTIONAL, PER
 * ADMIN (`admin_users.mfa_enabled`, default off, switched from the Account page):
 *   - ADMIN_MFA_REQUIRED=false (config) → two-step off for everyone: mint after the first factor.
 *   - `mfa_enabled = false` → mint after the first factor. This is now the DEFAULT path.
 *   - `mfa_enabled = true`  → a valid "trusted device" mints; otherwise NO session — an
 *     un-enrolled admin gets an enrolment step, an enrolled one a TOTP step (POST
 *     /admin/mfa/verify). The second factor stays enforced SERVER-SIDE at session-mint for
 *     every admin who has it on.
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
    // Needed for exactly one thing here: hashing a presented accept token so the raw value is
    // never compared, logged, or held beyond the lookup.
    private readonly invites: AdminInviteService,
    // 0144 — "trust this device": consulted at the MFA gate only when a token is presented, and
    // asked to issue one only on a TOTP success with `trust_device`.
    private readonly devices: AdminTrustedDeviceService,
    // Security review B1 — the per-admin TOTP attempt cap on POST /admin/mfa/verify.
    private readonly lockout: AdminAttemptLockoutService,
  ) {}

  /** POST /admin/login/request — issue a code; NO-ENUMERATION across known/unknown emails. */
  async requestLogin(dto: AdminLoginRequestDto): Promise<AdminAuthCodeResponse> {
    const emailHash = this.admins.emailHash(dto.email);
    const account = await this.admins.findByEmailHash(emailHash);

    // Reserve a code identically for BOTH branches so the timing/response + 429s match. A code
    // is reserved even for an inactive/unknown account; it is simply never delivered, and verify
    // mints nothing for it (no oracle). Delivery is a deferred stream in ADMIN-1.
    if (account && account.status === "active") {
      // ADR-0038 — the RAW address is passed for delivery only. It is never logged and never
      // stored: the DTO already normalized it, and `emailHash` remains the lookup key
      // everywhere else. A `pending` or `suspended` admin deliberately falls to the
      // no-delivery branch — same neutral response, no mail to an account that cannot auth.
      await this.otp.issueAndSend(emailHash, dto.email);
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

    // ADR-0060 — an account still on the TEMPORARY password a super_admin chose must replace it
    // through the password door before any other way in. Without this, the emailed code skips
    // the forced change and the creator keeps knowing a live password for this account. Safe to
    // say plainly: the caller has just proven control of the mailbox, so nothing leaks.
    if (account.mustChangePassword) {
      throw new ConflictException(MUST_CHANGE_VIA_PASSWORD);
    }

    return this.gateMfaThenMaybeMint(account, ctx, dto.device_token);
  }

  /**
   * POST /admin/mfa/verify — the second factor. Validates the submitted TOTP against the
   * admin's stored secret; on success marks the admin mfa_enrolled (first-time enroll) and
   * mints the session. A wrong/expired TOTP, an inactive/unknown account, or a missing stored
   * secret all return the SAME neutral 401 (no oracle). The TOTP secret itself is only ever
   * provisioned on the OTP-gated enrollment branch of `verifyLogin`, so possessing a valid
   * TOTP already implies a prior OTP-gated enrollment for this account.
   *
   * RATE LIMITS: the shared per-IP cap at the controller, the single-use OTP-pending marker (one
   * guess per first-factor success), and — the one that actually bounds a leaked first factor —
   * a per-ADMIN failure counter (`mfa_login` scope) that only a correct TOTP clears.
   */
  async verifyMfa(dto: AdminMfaVerifyDto, ctx: RequestContext): Promise<AdminSessionResponse> {
    const emailHash = this.admins.emailHash(dto.email);
    const account = await this.requireActiveAccount(emailHash);

    // PER-ADMIN TOTP ATTEMPT CAP (security review B1), checked BEFORE the marker is consumed.
    // The marker below allows one guess per first-factor success — but a correct password
    // re-mints it every time, so on its own it bounds nothing: a leaked password became an
    // unlimited "password → one TOTP guess" loop. This counter is the one no first factor can
    // reset (only a correct TOTP clears it). Locked → the SAME neutral 401; Redis error → 503.
    if (await this.lockout.isLockedOut("mfa_login", account.id)) {
      throw new UnauthorizedException("Incorrect or expired code");
    }

    // SINGLE-FLOW binding: this admin must have passed OTP in the SAME (recent) flow — the
    // marker is set by verifyLogin's MFA branch and consumed (single-use) here. Absent/expired
    // → fail closed (same 401), so a leaked TOTP secret alone cannot mint a session without a
    // fresh OTP success. Consume BEFORE the TOTP check so a wrong code still burns the marker.
    const otpPassed = await this.mfaStore.consumeOtpPending(account.id);
    if (!otpPassed) throw new UnauthorizedException("Incorrect or expired code");

    // No stored secret → cannot verify a second factor → fail closed (same 401 as a wrong code),
    // and it COUNTS: from the outside it is a guess that did not land.
    const secret = await this.mfaStore.load(account.id);
    if (!secret || !verifyTotp(secret, dto.code)) {
      await this.lockout.recordFailure("mfa_login", account.id);
      throw new UnauthorizedException("Incorrect or expired code");
    }
    await this.lockout.clear("mfa_login", account.id);

    // First successful TOTP also confirms enrollment (idempotent if already enrolled).
    if (!account.mfaEnrolled) await this.admins.setMfaEnrolled(account.id, true);

    const session = await this.mintSession(account, ctx);
    if (!dto.trust_device) return session;
    return { ...session, ...(await this.trustThisDevice(account, ctx)) };
  }

  /**
   * 0144 — the account flags `GET /admin/me` adds, read from the LIVE row (the guard already
   * proved the session; a row that vanished in between is the same neutral 401 the guard gives).
   * Booleans only — the hash, the seed and the timestamps never leave this method.
   */
  async accountFlags(adminId: string): Promise<AdminAccountFlags> {
    const row = await this.admins.findById(adminId);
    if (!row) throw new UnauthorizedException("Invalid or expired admin session");
    return {
      has_password: row.passwordHash !== null,
      must_change_password: row.mustChangePassword,
      mfa_enabled: row.mfaEnabled,
    };
  }

  /**
   * POST /admin/refresh — mint a fresh JWT for the already-validated admin+session.
   * `passwordEpoch` is the one the guard validated this request against (B2) — deliberately NOT
   * re-read here, so a refresh racing a password reset stays on the dead epoch.
   */
  async refresh(
    adminId: string,
    sid: string,
    role: AdminUser["role"],
    passwordEpoch: number,
  ): Promise<AdminRefreshResponse> {
    const fresh = await this.sessions.mint(adminId, sid, role, passwordEpoch);
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

  /**
   * POST /admin/invites/accept — PUBLIC. Redeem a single-use invite link: `pending` → `active`.
   *
   * This is the transition that never existed. `admin_users.status` has defaulted to 'pending'
   * since ADMIN-1 and only an 'active' row may authenticate, but nothing ever flipped it, so
   * every invited admin was permanently unable to sign in. The accept token is what closes
   * that loop, and it is deliberately the ONLY thing that does.
   *
   * WHY UNAUTHENTICATED: the invitee has no account yet — that is the entire point — so there
   * is no session to present. The token IS the credential: 256 bits of CSPRNG entropy, mailed
   * to the address the invite was addressed to, stored only as a keyed HMAC, single-use, and
   * expiring in 48h. Possession proves control of that mailbox, which is exactly what the
   * login OTP proves on every subsequent sign-in.
   *
   * WHAT IT DELIBERATELY DOES NOT DO: it does not mint a session and it does not enrol MFA.
   * Accepting makes the account real; the invitee then signs in through the ordinary, already
   * tested path (request code → verify → TOTP enrolment → session), so the MFA-at-session-mint
   * invariant (must-fix #1) is untouched and there is no second, weaker way into a session.
   *
   * NO-ORACLE: unknown, expired, already-consumed and non-pending all return the SAME 401 as
   * a bad login code. A distinguishable 404 would let someone probe which links had been
   * issued, and the neutral failure matches how `login/verify` already behaves.
   */
  async acceptInvite(dto: AdminInviteAcceptDto, ctx: RequestContext): Promise<AdminInviteAcceptedResponse> {
    // The single guarded UPDATE both matches and consumes the token, so two concurrent
    // redemptions of one link cannot both win.
    const account = await this.admins.acceptInvite(this.invites.hashToken(dto.token), new Date());
    if (!account) throw new UnauthorizedException("This invite link is invalid or has expired");

    await this.events.emit({
      event_name: "admin.action_performed",
      actor: { actor_type: "admin", actor_id: account.id },
      subject: { subject_type: "admin_session", subject_id: account.id },
      payload: {
        admin_id: account.id,
        action_code: "admin_invite_accepted",
        target_type: "admin_session",
        target_id: account.id,
      },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    // Opaque id + role only. The invitee's email never appears here, and neither does the token.
    return { admin_id: account.id, role: account.role, status: "active", next: "sign_in" };
  }

  // ---------------------------------------------------------------------------

  /**
   * The MFA gate — what an admin who has JUST passed a first factor (emailed code via
   * `verifyLogin`, or a password via `AdminPasswordService`) gets. The caller has already
   * proven the factor AND that the account is active; this method never re-checks either.
   *   - ADMIN_MFA_REQUIRED false (config: two-step off for everyone) → mint a session.
   *   - the admin's own two-step is OFF (`mfa_enabled = false`, Amendment 1) → mint a session.
   *   - two-step ON + a valid trusted-device token for THIS admin → mint (TOTP skipped; 0144).
   *   - two-step ON + NOT enrolled → an enrollment step ONLY (a fresh TOTP secret), NO session.
   *   - two-step ON + enrolled → `mfa_required` with no enrollment material; the admin must
   *     POST /admin/mfa/verify to complete and get a session. NO session is minted here.
   * For an admin with two-step ON, no branch mints without the TOTP or a trusted device.
   */
  async gateMfaThenMaybeMint(
    account: AdminUser,
    ctx: RequestContext,
    deviceToken?: string,
  ): Promise<AdminMfaRequiredResponse | AdminSessionResponse> {
    if (!this.config.ADMIN_MFA_REQUIRED || !account.mfaEnabled) {
      return this.mintSession(account, ctx);
    }

    // Consulted ONLY when the browser presented one — no token, no Redis read.
    if (deviceToken !== undefined && (await this.devices.isTrusted(deviceToken, account))) {
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

  /**
   * 0144 — issue a trusted-device token after a TOTP success with `trust_device`, and record it
   * (`admin_device_trusted`, value-free). Nothing is issued — and nothing evented — when the
   * feature is off (ADMIN_TRUSTED_DEVICE_DAYS=0) or Redis refused the write: the session is
   * already minted, and an un-trusted browser is simply asked for TOTP next time.
   */
  private async trustThisDevice(
    account: AdminUser,
    ctx: RequestContext,
  ): Promise<Pick<AdminSessionResponse, "device_token" | "device_expires_in_seconds">> {
    const device = await this.devices.issue(account);
    if (!device) return {};
    await emitAdminAccountAction(this.events, {
      actorAdminId: account.id,
      targetAdminId: account.id,
      actionCode: ADMIN_ACTION_CODES.admin_device_trusted,
      ctx,
    });
    return { device_token: device.token, device_expires_in_seconds: device.expiresInSeconds };
  }

  /**
   * Mint the session + emit `admin.session_started` (PII-free). Touch last_login (best-effort).
   * Public for `AdminPasswordService` (0144), whose password change hands back a FRESH session:
   * every session start, whatever the door, goes through this one method and this one event.
   */
  async mintSession(account: AdminUser, ctx: RequestContext): Promise<AdminSessionResponse> {
    // B2 — the session is bound to THIS row's credential epoch. For the change-password path the
    // caller passes the UPDATED row, so the fresh session carries the NEW epoch.
    const session = await this.sessions.create(
      account.id,
      account.role,
      passwordEpochOf(account.passwordSetAt),
    );
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
