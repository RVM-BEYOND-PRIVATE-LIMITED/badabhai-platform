import { Injectable } from "@nestjs/common";
import { EmailNotificationService } from "../notifications/email-notification.service";

/**
 * The kind of credential change a security notice describes. `setup` / `reset` / `revoked` /
 * `changed` are the PASSWORD (#2563); `phone_changed` (#2754 item 3) is the sign-in PHONE: once
 * proven it signs the company in by SMS code, so a change to it is a credential change too.
 */
export type PayerSecurityNoticeKind = "setup" | "reset" | "revoked" | "changed" | "phone_changed";

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
    if (notice.kind === "phone_changed") {
      // #2754 item 3 — the same short notice for the sign-in phone. It names no number (old or new):
      // the real account holder needs to know THAT it changed, not to what.
      await this.email.send({
        to: notice.email,
        subject: "The phone number on your BadaBhai account was changed",
        text:
          `The phone number on your BadaBhai company account was changed on ${when} IST. ` +
          "The new number must be confirmed with a code before it can be used to sign in. " +
          "If this wasn't you, contact BadaBhai support.",
        html: [
          `<p>The phone number on your BadaBhai company account was <strong>changed</strong> on ${when} IST.</p>`,
          "<p>The new number must be confirmed with a code before it can be used to sign in.</p>",
          "<p>If this wasn't you, contact BadaBhai support.</p>",
        ].join(""),
        principal: "payer",
        purpose: "security_notice",
      });
      return;
    }
    const verb = notice.kind === "setup" ? "set up" : notice.kind;
    await this.email.send({
      to: notice.email,
      subject: `Your BadaBhai password was ${verb}`,
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
