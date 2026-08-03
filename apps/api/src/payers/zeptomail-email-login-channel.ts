import { Injectable } from "@nestjs/common";
import { EmailNotificationService } from "../notifications/email-notification.service";
import type { PayerLoginChannel, PayerLoginCodeDelivery } from "./payer-login-channel";

/**
 * REAL payer email-OTP delivery channel (OTP-2; ADR-0019 B-R1).
 *
 * ADR-0038 — this class no longer implements a transport. It COMPOSES the payer's login
 * email and hands it to {@link EmailNotificationService}, the single outbound pipeline every
 * principal shares. It previously carried its own copy of the ZeptoMail HTTPS client, the
 * `Zoho-enczapikey` prefix workaround, the sandbox flag, the SMTP fallback and the opaque-
 * error contract — a second, drifting copy of all of which lived in the org-member invite
 * mailer. Both now delegate.
 *
 * PRIVACY (CLAUDE.md §2, HARD): the one-time `code` appears ONLY in the message body (its
 * legitimate purpose) and is NEVER logged or evented. `deliver` re-throws the pipeline's
 * OPAQUE error so {@link import("./payer-otp.service").PayerOtpService} rolls back the
 * reserved code — a failed send must leave no dangling code.
 */
@Injectable()
export class ZeptoMailEmailLoginChannel implements PayerLoginChannel {
  readonly method = "email_otp" as const;
  readonly mock = false;
  constructor(private readonly email: EmailNotificationService) {}

  async deliver(input: PayerLoginCodeDelivery): Promise<void> {
    await this.email.send({
      to: input.email,
      subject: ZeptoMailEmailLoginChannel.subject(),
      html: ZeptoMailEmailLoginChannel.htmlBody(input.code),
      text: ZeptoMailEmailLoginChannel.textBody(input.code),
      principal: "payer",
      purpose: "login_code",
    });
  }

  // --- Rendered email (the ONLY place the code may appear) --------------------

  private static subject(): string {
    return "Your BadaBhai login code";
  }

  private static textBody(code: string): string {
    return `Your BadaBhai login code is ${code}. It expires shortly. If you did not request it, ignore this email.`;
  }

  private static htmlBody(code: string): string {
    return [
      "<p>Your BadaBhai login code is:</p>",
      `<p style="font-size:24px;font-weight:bold;letter-spacing:3px;">${code}</p>`,
      "<p>It expires shortly. If you did not request it, you can ignore this email.</p>",
    ].join("");
  }
}
