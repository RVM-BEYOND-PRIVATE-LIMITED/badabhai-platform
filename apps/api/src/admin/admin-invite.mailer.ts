import { Injectable, Logger } from "@nestjs/common";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { EmailNotificationService } from "../notifications/email-notification.service";

/** DI token for the active admin-invite mailer (mock by default; real only behind the gate). */
export const ADMIN_INVITE_MAILER = Symbol("ADMIN_INVITE_MAILER");

/**
 * A single admin-invite delivery. `email` is the invitee's raw address; `acceptUrl` is the
 * accept link carrying the single-use RAW token as a query param. BOTH are PII / bearer
 * secrets — a mailer may put them ONLY into the outbound email (their legitimate purpose)
 * and MUST NEVER log/event either.
 */
export interface AdminInviteDelivery {
  email: string;
  acceptUrl: string;
  /** Hours until the link expires — rendered into the copy so the invitee knows the window. */
  expiresInHours: number;
}

/** The admin-invite mailer seam — the real vs mock transport swap point (mirrors ADR-0027 B5.4). */
export interface AdminInviteMailer {
  send(input: AdminInviteDelivery): Promise<void>;
}

/**
 * DEFAULT admin-invite mailer — a NO-OP send, chosen whenever ADMIN_INVITES_ENABLE_REAL is off.
 *
 * This is the direct analogue of {@link MockMemberInviteMailer}, and it is byte-safe with
 * respect to the PII boundary: the raw token / accept link never leave the process (there is
 * no external call), and it logs ONLY an 8-char email-HASH prefix plus a status token.
 *
 * The accept flow is still FULLY LIVE under the mock: the invited admin's token hash is
 * persisted, and the raw accept link is returned once to the inviting super_admin in the
 * invite response, so onboarding works with no email provider configured at all. That is the
 * deliberate alpha posture — an admin portal whose operators are a handful of known people
 * does not need an email channel before it can add its second admin.
 */
@Injectable()
export class MockAdminInviteMailer implements AdminInviteMailer {
  private readonly logger = new Logger(MockAdminInviteMailer.name);

  constructor(private readonly pii: PiiCryptoService) {}

  async send(input: AdminInviteDelivery): Promise<void> {
    const emailHashPrefix = this.pii.hmac(input.email).slice(0, 8);
    // PII-free: hash prefix + status only — NEVER the email, the token, or the accept link.
    this.logger.log(
      `mock admin-invite email NOT sent (ADMIN_INVITES_ENABLE_REAL off) email_hash=${emailHashPrefix} status=mock`,
    );
  }
}

/**
 * REAL admin-invite mailer. Selected ONLY behind ADMIN_INVITES_ENABLE_REAL (the module factory
 * returns the mock otherwise), and it composes rather than transports: the message goes to
 * {@link EmailNotificationService}, the single outbound pipeline every principal shares
 * (ADR-0038), so it inherits that pipeline's provider resolution and opaque-error contract.
 *
 * PRIVACY (CLAUDE.md §2, HARD): the invitee email and the accept link (carrying the raw token)
 * appear ONLY in the outbound message — the legitimate purpose — and are NEVER logged/evented.
 * `send` propagates the pipeline's OPAQUE error so the caller surfaces a generic failure.
 */
@Injectable()
export class RealAdminInviteMailer implements AdminInviteMailer {
  constructor(private readonly email: EmailNotificationService) {}

  async send(input: AdminInviteDelivery): Promise<void> {
    await this.email.send({
      to: input.email,
      subject: RealAdminInviteMailer.subject(),
      html: RealAdminInviteMailer.htmlBody(input.acceptUrl, input.expiresInHours),
      text: RealAdminInviteMailer.textBody(input.acceptUrl, input.expiresInHours),
      principal: "admin",
      purpose: "admin_invite",
    });
  }

  // --- Rendered email (the ONLY place the accept link may appear) -------------

  private static subject(): string {
    return "You've been invited to the BadaBhai admin portal";
  }

  private static textBody(acceptUrl: string, hours: number): string {
    return (
      `You have been invited to the BadaBhai admin portal. Open this link to set up your access: ${acceptUrl}. ` +
      `The link expires in ${hours} hours and can be used once. ` +
      `If you did not expect this, ignore this email and tell the BadaBhai team.`
    );
  }

  private static htmlBody(acceptUrl: string, hours: number): string {
    return [
      "<p>You have been invited to the BadaBhai admin portal.</p>",
      `<p><a href="${acceptUrl}">Set up your admin access</a></p>`,
      `<p>The link expires in ${hours} hours and can be used once.</p>`,
      "<p>If you did not expect this, ignore this email and tell the BadaBhai team.</p>",
    ].join("");
  }
}
