import { Injectable } from "@nestjs/common";
import { EmailNotificationService } from "../notifications/email-notification.service";

/** The kind of credential change a security notice describes. */
export type PayerSecurityNoticeKind = "setup" | "reset" | "revoked" | "changed";

/** One security notice. `email` is PII and belongs ONLY inside the outbound message. */
export interface PayerSecurityNotice {
  email: string;
  kind: PayerSecurityNoticeKind;
  at: Date;
}

/**
 * #2563 (owner ruling 2026-11-04) — the payer credential-change email seam.
 *
 * The notice is deliberately SHORT and carries no secret: not the temporary password, not the
 * admin's identity, not the reason. It exists so the real account holder can react to an
 * admin-issued or self-service credential change they did not expect.
 */
export interface PayerSecurityNoticeMailer {
  send(notice: PayerSecurityNotice): Promise<void>;
}

export const PAYER_SECURITY_NOTICE_MAILER = Symbol("PAYER_SECURITY_NOTICE_MAILER");

/**
 * The real notice mailer, composed on the ONE outbound-email pipeline (ADR-0038). It does not
 * log the address or the body; {@link EmailNotificationService} logs a hashed prefix and closed
 * enums only.
 */
@Injectable()
export class EmailPayerSecurityNoticeMailer implements PayerSecurityNoticeMailer {
  constructor(private readonly email: EmailNotificationService) {}

  async send(notice: PayerSecurityNotice): Promise<void> {
    const when = EmailPayerSecurityNoticeMailer.formatIst(notice.at);
    const verb = notice.kind === "setup" ? "set up" : notice.kind;
    await this.email.send({
      to: notice.email,
      subject: "Your BadaBhai password was changed",
      text: `Your BadaBhai password was ${verb} on ${when} IST. If this wasn't you, contact BadaBhai support.`,
      html: [
        `<p>Your BadaBhai password was <strong>${verb}</strong> on ${when} IST.</p>`,
        "<p>If this wasn't you, contact BadaBhai support.</p>",
      ].join(""),
      principal: "payer",
      purpose: "security_notice",
    });
  }

  /**
   * The owner asked for a date in IST. `Intl` with an explicit time zone is used rather than a
   * fixed `+05:30` offset so the rendered time stays correct if the platform ever changes the
   * display zone, without changing the notice's meaning.
   */
  private static formatIst(at: Date): string {
    return new Intl.DateTimeFormat("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(at);
  }
}
