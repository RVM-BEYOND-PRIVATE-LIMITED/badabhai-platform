import { Injectable, Logger } from "@nestjs/common";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { EmailNotificationService } from "../notifications/email-notification.service";

/** DI token for the active org-invite mailer (mock by default; real only behind the gate). */
export const MEMBER_INVITE_MAILER = Symbol("MEMBER_INVITE_MAILER");

/**
 * A single org-invite delivery. `email` is the invitee's raw address; `acceptUrl` is the
 * accept link carrying the single-use RAW token as a query param. BOTH are PII / bearer
 * secrets — a mailer may put them ONLY into the outbound email (their legitimate purpose)
 * and MUST NEVER log/event either.
 */
export interface MemberInviteDelivery {
  email: string;
  acceptUrl: string;
}

/** The org-invite mailer seam — the real vs mock transport swap point (ADR-0027 / B5.4). */
export interface MemberInviteMailer {
  send(input: MemberInviteDelivery): Promise<void>;
}

/**
 * DEFAULT (alpha) org-invite mailer — a NO-OP send. The raw token / accept link NEVER leaves
 * the process (there is no external call), so this is byte-safe with respect to the PII
 * boundary: it logs ONLY an 8-char email-HASH prefix + a status token (never the email, the
 * token, or the link). The accept flow is still fully live — the invited member's token hash
 * is persisted, so an operator with the raw token (surfaced only in the invite return path in
 * a real send) can accept. Real delivery is {@link RealMemberInviteMailer}, chosen only when
 * MEMBER_INVITES_ENABLE_REAL is set + the email provider is configured.
 */
@Injectable()
export class MockMemberInviteMailer implements MemberInviteMailer {
  private readonly logger = new Logger(MockMemberInviteMailer.name);

  constructor(private readonly pii: PiiCryptoService) {}

  async send(input: MemberInviteDelivery): Promise<void> {
    const emailHashPrefix = this.pii.hmac(input.email).slice(0, 8);
    // PII-free: hash prefix + status only — NEVER the email, the token, or the accept link.
    this.logger.log(
      `mock org-invite email NOT sent (MEMBER_INVITES_ENABLE_REAL off) email_hash=${emailHashPrefix} status=mock`,
    );
  }
}

/**
 * REAL org-invite mailer (ADR-0027 / B5.4). Selected ONLY behind MEMBER_INVITES_ENABLE_REAL
 * (the module factory returns the mock otherwise).
 *
 * ADR-0038 — this class no longer implements a transport. It COMPOSES the invite email and
 * hands it to {@link EmailNotificationService}, the single outbound pipeline every principal
 * shares. It previously carried its own copy of the ZeptoMail HTTPS client, the transport
 * resolution, the sandbox flag, the SMTP fallback and the opaque-error contract — a second
 * copy of what the payer login channel already had, free to drift from it.
 *
 * PRIVACY (CLAUDE.md §2, HARD): the invitee email and the accept link (carrying the raw
 * token) appear ONLY in the outbound message — the legitimate purpose — and are NEVER
 * logged/evented. `send` propagates the pipeline's OPAQUE error so the caller surfaces a
 * generic delivery failure.
 */
@Injectable()
export class RealMemberInviteMailer implements MemberInviteMailer {
  constructor(private readonly email: EmailNotificationService) {}

  async send(input: MemberInviteDelivery): Promise<void> {
    await this.email.send({
      to: input.email,
      subject: RealMemberInviteMailer.subject(),
      html: RealMemberInviteMailer.htmlBody(input.acceptUrl),
      text: RealMemberInviteMailer.textBody(input.acceptUrl),
      principal: "payer",
      purpose: "team_invite",
    });
  }

  // --- Rendered email (the ONLY place the accept link may appear) -------------

  private static subject(): string {
    return "You've been invited to a BadaBhai team";
  }

  private static textBody(acceptUrl: string): string {
    return `You have been invited to join a team on BadaBhai. Open this link to accept: ${acceptUrl}. The link expires in a few days. If you did not expect this, you can ignore this email.`;
  }

  private static htmlBody(acceptUrl: string): string {
    return [
      "<p>You have been invited to join a team on BadaBhai.</p>",
      `<p><a href="${acceptUrl}">Accept the invite</a></p>`,
      "<p>The link expires in a few days. If you did not expect this, you can ignore this email.</p>",
    ].join("");
  }
}
