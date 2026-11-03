import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { AdminUser } from "@badabhai/db";
import { SERVER_CONFIG } from "../config/config.module";
import { PiiCryptoService } from "../common/pii-crypto.service";
import {
  CURRENT_PASSWORD_PEPPER_VERSION,
  burnPasswordKdf,
  matchesStoredPassword,
} from "../common/password-policy";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { AdminRepository } from "./admin.repository";
import { AdminOtpService } from "./admin-otp.service";
import { AdminSessionService } from "./admin-session.service";
import { AdminAuthService } from "./admin-auth.service";
import { AdminAttemptLockoutService } from "./admin-attempt-lockout.service";
import { ADMIN_ACTION_CODES, type AdminActionCode } from "./admin-actions.service";
import { emitAdminAccountAction } from "./admin-account-event";
import type { AuthenticatedAdmin } from "./admin-auth.guard";
import type {
  AdminAuthCodeResponse,
  AdminChangePasswordDto,
  AdminMfaRequiredResponse,
  AdminPasswordChangeRequiredResponse,
  AdminPasswordForgotDto,
  AdminPasswordLoginDto,
  AdminPasswordResetDto,
  AdminPasswordResetResponse,
  AdminSessionResponse,
} from "./admin-auth.dto";

/** The ONE answer for every way a password sign-in can fail (no oracle). */
const SIGN_IN_FAILED = "Incorrect email or password";
/** The ONE answer for every way a reset code can fail (no oracle). */
const RESET_CODE_FAILED = "Incorrect or expired code";
const CURRENT_PASSWORD_WRONG = "Current password is incorrect";

/**
 * Admin PASSWORD sign-in, forgot/reset and self-service change (migration 0142, owner rulings
 * 2026-11-03). The password is a FIRST factor only: a successful password hands the account to
 * the SAME MFA gate the emailed-code door uses (`AdminAuthService.gateMfaThenMaybeMint`), so
 * there is one way past the second factor, not two.
 *
 * NO-ENUMERATION on the public doors (the admin is the highest-privilege principal):
 *   - sign-in: unknown email, wrong password, no password set, locked out, pending and suspended
 *     ALL answer the same 401, and every one of those paths burns one full scrypt KDF;
 *   - forgot: the response is identical for unknown, inactive and active emails — a code is
 *     reserved in every case and DELIVERED only to an active admin, in the background, so
 *     neither the provider's latency nor its failure reaches the response;
 *   - reset: wrong/expired code and inactive account answer the same 401.
 *
 * A reset NEVER mints a session and never touches the second factor. Setting a password moves
 * `password_set_at`, which `AdminSessionService` uses as the session cut-off — so a reset (or a
 * change) logs out every existing session, and the change endpoint hands its caller a fresh one.
 *
 * PRIVACY: the raw password, the code and the email never reach a log, an event or a response.
 * Events carry the opaque admin id + an action code only.
 */
@Injectable()
export class AdminPasswordService {
  private readonly logger = new Logger(AdminPasswordService.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly admins: AdminRepository,
    private readonly pii: PiiCryptoService,
    private readonly lockout: AdminAttemptLockoutService,
    private readonly otp: AdminOtpService,
    private readonly sessions: AdminSessionService,
    private readonly auth: AdminAuthService,
    private readonly events: EventsService,
  ) {}

  /** POST /admin/login/password — password first factor, then the shared MFA gate. */
  async loginWithPassword(
    dto: AdminPasswordLoginDto,
    ctx: RequestContext,
  ): Promise<
    AdminPasswordChangeRequiredResponse | AdminMfaRequiredResponse | AdminSessionResponse
  > {
    const account = await this.verifyFirstFactor(dto.email, dto.password);
    if (!account.mustChangePassword) {
      return this.auth.gateMfaThenMaybeMint(account, ctx, dto.device_token);
    }
    // A TEMPORARY password proves the account but must be replaced before anything else.
    if (dto.new_password === undefined) return { status: "password_change_required" };
    if (dto.new_password === dto.password) {
      throw new BadRequestException("Choose a new password — it cannot be the temporary one");
    }
    const updated = await this.storePassword(
      account.id,
      dto.new_password,
      "admin_password_set",
      ctx,
    );
    if (!updated) throw new UnauthorizedException(SIGN_IN_FAILED);
    // The UPDATED row: its new `password_set_at` is what a trusted-device check must compare to.
    return this.auth.gateMfaThenMaybeMint(updated, ctx, dto.device_token);
  }

  /** POST /admin/password/forgot — reserve a reset code; IDENTICAL response for every email. */
  async requestReset(dto: AdminPasswordForgotDto): Promise<AdminAuthCodeResponse> {
    const emailHash = this.admins.emailHash(dto.email);
    const account = await this.admins.findByEmailHash(emailHash);
    if (account?.status === "active") {
      // The RAW address goes to the sender only — never stored, never logged. DISPATCHED, not
      // awaited: only a real account reaches delivery, so waiting on the provider (its latency
      // or its failure) would tell a prober which emails are admins. The response waits for the
      // reserve alone — exactly what the branch below waits for.
      await this.otp.issueAndDispatch(emailHash, dto.email, "password_reset");
    } else {
      // Unknown / pending / suspended: the IDENTICAL reserve (cooldown, hourly cap, 429s, 503s),
      // never delivered — and nothing it reserves can ever reset anything (no active row).
      await this.otp.issueWithoutDelivery(emailHash, "password_reset");
    }
    return { status: "code_sent", resend_in_seconds: this.config.OTP_RESEND_COOLDOWN_SECONDS };
  }

  /**
   * POST /admin/password/reset — redeem a RESET code (never a login code: separate namespace) and
   * set the password. No session is minted; the second factor is untouched.
   */
  async resetPassword(
    dto: AdminPasswordResetDto,
    ctx: RequestContext,
  ): Promise<AdminPasswordResetResponse> {
    const emailHash = this.admins.emailHash(dto.email);
    // Verify FIRST — constant-time, single-use, one message for wrong/none/expired.
    await this.otp.verify(emailHash, dto.code, "password_reset");

    const account = await this.admins.findByEmailHash(emailHash);
    if (!account || account.status !== "active") throw new UnauthorizedException(RESET_CODE_FAILED);

    const updated = await this.storePassword(
      account.id,
      dto.new_password,
      "admin_password_reset",
      ctx,
    );
    if (!updated) throw new UnauthorizedException(RESET_CODE_FAILED);
    // Proven mailbox control is a fresh start for the password door.
    await this.lockout.clear("password", account.id);
    return { status: "password_reset", next: "sign_in" };
  }

  /**
   * POST /admin/me/password — set (first time) or change the signed-in admin's own password.
   * When one already exists the CURRENT password must verify (and failures count toward the same
   * lockout as sign-in). Returns a FRESH session: the cut-off just moved past the caller's token,
   * and the caller's old session id is revoked outright.
   */
  async changeOwnPassword(
    admin: Pick<AuthenticatedAdmin, "id" | "sid">,
    dto: AdminChangePasswordDto,
    ctx: RequestContext,
  ): Promise<AdminSessionResponse> {
    const row = await this.admins.findById(admin.id);
    if (!row || row.status !== "active") {
      throw new UnauthorizedException("Invalid or expired admin session");
    }
    if (row.passwordHash !== null) {
      await this.verifyCurrentPassword(row, dto.current_password);
      if (dto.new_password === dto.current_password) {
        throw new BadRequestException("Choose a new password — it cannot be the current one");
      }
    }

    const updated = await this.storePassword(admin.id, dto.new_password, "admin_password_set", ctx);
    if (!updated) throw new UnauthorizedException("Invalid or expired admin session");
    await this.sessions.revoke(admin.sid);
    return this.auth.mintSession(updated, ctx);
  }

  // ---------------------------------------------------------------------------

  /**
   * The password first factor. Returns the ACTIVE account it proves, or throws the ONE neutral
   * 401. Every miss path burns exactly one full KDF; only a real account's real mismatch counts
   * toward that account's lockout.
   */
  private async verifyFirstFactor(email: string, password: string): Promise<AdminUser> {
    const account = await this.admins.findByEmailHash(this.admins.emailHash(email));
    if (!account) {
      burnPasswordKdf(this.pii, password);
      throw new UnauthorizedException(SIGN_IN_FAILED);
    }
    if (await this.lockout.isLockedOut("password", account.id)) {
      // Locked: same 401 (a 429 would announce the throttle — and the account — to a prober).
      burnPasswordKdf(this.pii, password);
      throw new UnauthorizedException(SIGN_IN_FAILED);
    }
    if (!matchesStoredPassword(this.pii, password, account)) {
      await this.lockout.recordFailure("password", account.id);
      throw new UnauthorizedException(SIGN_IN_FAILED);
    }
    if (account.status !== "active") {
      // A pending/suspended admin authenticates to NOTHING, correct password or not.
      this.logger.warn(
        `admin password sign-in refused for non-active account admin=${account.id.slice(0, 8)}…`,
      );
      throw new UnauthorizedException(SIGN_IN_FAILED);
    }
    await this.lockout.clear("password", account.id);
    return account;
  }

  /** The signed-in change's current-password proof. Lockout → 429 (the caller is authenticated). */
  private async verifyCurrentPassword(
    row: AdminUser,
    presented: string | undefined,
  ): Promise<void> {
    if (await this.lockout.isLockedOut("password", row.id)) {
      throw new HttpException(
        "Too many attempts; please try again later",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (presented === undefined) throw new UnauthorizedException(CURRENT_PASSWORD_WRONG);
    if (!matchesStoredPassword(this.pii, presented, row)) {
      await this.lockout.recordFailure("password", row.id);
      throw new UnauthorizedException(CURRENT_PASSWORD_WRONG);
    }
    await this.lockout.clear("password", row.id);
  }

  /**
   * Hash (outside any transaction — the KDF is slow), then write the password AND its value-free
   * event on ONE transaction (H3). The write is guarded on `status = 'active'`; undefined means the
   * account stopped being active underneath us, and nothing was written or evented.
   */
  private async storePassword(
    adminId: string,
    password: string,
    actionCode: Extract<AdminActionCode, "admin_password_set" | "admin_password_reset">,
    ctx: RequestContext,
  ): Promise<AdminUser | undefined> {
    const write = {
      hash: this.pii.hashPassword(password),
      pepperVersion: CURRENT_PASSWORD_PEPPER_VERSION,
      setAt: new Date(),
    };
    return this.admins.withTransaction(async (tx) => {
      const row = await this.admins.setPassword(adminId, write, tx);
      if (!row) return undefined;
      await emitAdminAccountAction(this.events, {
        actorAdminId: adminId,
        targetAdminId: adminId,
        actionCode: ADMIN_ACTION_CODES[actionCode],
        ctx,
        tx,
      });
      return row;
    });
  }
}
