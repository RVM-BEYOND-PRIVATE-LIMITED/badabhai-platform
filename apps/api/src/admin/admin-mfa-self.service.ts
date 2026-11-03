import {
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { AdminUser } from "@badabhai/db";
import { SERVER_CONFIG } from "../config/config.module";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { AdminRepository } from "./admin.repository";
import { AdminMfaSecretStore } from "./admin-mfa.store";
import { AdminAttemptLockoutService } from "./admin-attempt-lockout.service";
import { ADMIN_ACTION_CODES } from "./admin-actions.service";
import { emitAdminAccountAction } from "./admin-account-event";
import { generateTotpEnrollment, verifyTotp } from "./admin-mfa";
import type { AdminMfaEnrollmentResponse, AdminMfaStateResponse } from "./admin-auth.dto";

const ALREADY_ON = "Two-step verification is already on";
const ALREADY_OFF = "Two-step verification is already off";
const WRONG_CODE = "Incorrect code";

/**
 * The signed-in admin's OWN two-step switch (owner Amendment 1, 2026-11-03: two-step is
 * optional, per admin, default off — migration 0144's `mfa_enabled`).
 *
 *   enable  → a FRESH TOTP seed is staged (encrypted, `mfa_enrolled=false`) and shown once; the
 *             switch stays OFF until confirmed, so a QR nobody scanned can never lock anyone out.
 *   confirm → a code from that seed proves the authenticator works → enrolled + enabled together.
 *   disable → a code from the CURRENT seed proves possession → enabled, enrolled AND the seed are
 *             cleared together (re-enabling shows a new QR; trusted devices die with the seed).
 *
 * Self-service only: the session admin's id comes from the guard, never a body. Recovering a
 * LOST device stays the super_admin reset (another human) or the break-glass CLI — the disable
 * route needs a working authenticator precisely so a stolen session cannot strip it.
 *
 * Code attempts on confirm/disable are capped per admin (`mfa_toggle` scope of the shared
 * lockout, fail-closed) — without it a stolen session could walk the 10^6 code space.
 */
@Injectable()
export class AdminMfaSelfService {
  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly admins: AdminRepository,
    private readonly mfaStore: AdminMfaSecretStore,
    private readonly lockout: AdminAttemptLockoutService,
    private readonly events: EventsService,
  ) {}

  /** POST /admin/me/mfa/enable — stage a fresh seed; 409 when two-step is already on. */
  async enable(adminId: string): Promise<AdminMfaEnrollmentResponse> {
    const row = await this.requireActive(adminId);
    if (row.mfaEnabled) throw new ConflictException(ALREADY_ON);
    // Account label = the opaque admin id, NEVER the email (PII out of the otpauth URI / QR).
    const enrollment = generateTotpEnrollment(this.config.ADMIN_TOTP_ISSUER, adminId);
    // The guard in the write (mfa_enabled = false) closes the race with a concurrent confirm.
    if (!(await this.mfaStore.stageEnrolment(adminId, enrollment.secret))) {
      throw new ConflictException(ALREADY_ON);
    }
    return { enrollment: { secret: enrollment.secret, otpauth_uri: enrollment.otpauthUri } };
  }

  /** POST /admin/me/mfa/confirm — prove the staged seed, then switch two-step ON. */
  async confirm(
    adminId: string,
    code: string,
    ctx: RequestContext,
  ): Promise<AdminMfaStateResponse> {
    const row = await this.requireActive(adminId);
    if (row.mfaEnabled) throw new ConflictException(ALREADY_ON);
    await this.assertCode(adminId, code);
    const switched = await this.admins.withTransaction(async (tx) => {
      if (!(await this.admins.enableMfa(adminId, tx))) return false;
      await emitAdminAccountAction(this.events, {
        actorAdminId: adminId,
        targetAdminId: adminId,
        actionCode: ADMIN_ACTION_CODES.admin_mfa_enabled,
        ctx,
        tx,
      });
      return true;
    });
    if (!switched) throw new ConflictException(ALREADY_ON);
    return { mfa_enabled: true };
  }

  /** POST /admin/me/mfa/disable — prove the CURRENT seed, then switch two-step OFF. */
  async disable(
    adminId: string,
    code: string,
    ctx: RequestContext,
  ): Promise<AdminMfaStateResponse> {
    const row = await this.requireActive(adminId);
    if (!row.mfaEnabled) throw new ConflictException(ALREADY_OFF);
    await this.assertCode(adminId, code);
    const switched = await this.admins.withTransaction(async (tx) => {
      if (!(await this.admins.disableMfa(adminId, tx))) return false;
      await emitAdminAccountAction(this.events, {
        actorAdminId: adminId,
        targetAdminId: adminId,
        actionCode: ADMIN_ACTION_CODES.admin_mfa_disabled,
        ctx,
        tx,
      });
      return true;
    });
    if (!switched) throw new ConflictException(ALREADY_OFF);
    return { mfa_enabled: false };
  }

  // ---------------------------------------------------------------------------

  private async requireActive(adminId: string): Promise<AdminUser> {
    const row = await this.admins.findById(adminId);
    if (!row || row.status !== "active") {
      throw new UnauthorizedException("Invalid or expired admin session");
    }
    return row;
  }

  /**
   * A valid code from the admin's STORED seed (staged or live), under the per-admin attempt cap.
   * No seed, a bad seed and a wrong code are the same 401 and the same counted failure.
   */
  private async assertCode(adminId: string, code: string): Promise<void> {
    if (await this.lockout.isLockedOut("mfa_toggle", adminId)) {
      throw new HttpException(
        "Too many attempts; please try again later",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const secret = await this.mfaStore.load(adminId);
    if (!secret || !verifyTotp(secret, code)) {
      await this.lockout.recordFailure("mfa_toggle", adminId);
      throw new UnauthorizedException(WRONG_CODE);
    }
    await this.lockout.clear("mfa_toggle", adminId);
  }
}
