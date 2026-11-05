import { Inject, Injectable, Logger } from "@nestjs/common";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { PayersRepository } from "./payers.repository";
import {
  PAYER_SECURITY_NOTICE_MAILER,
  type PayerSecurityNoticeKind,
  type PayerSecurityNoticeMailer,
} from "./payer-security-notice.mailer";

/**
 * #2563 (owner ruling 2026-11-04) — send the payer credential-change security notice.
 *
 * The recipient is the account's OWN email on file (decrypted here, at the one boundary that
 * already owns payer contact PII). A phone-only account has no address and gets no notice; the
 * skip is logged with the opaque payer-id prefix only — never a phone, an email or a password.
 *
 * BEST-EFFORT BY CONTRACT. The credential change has already committed when this runs. A mail
 * failure is logged and swallowed: rolling back a successful password change because a provider
 * hiccuped would leave the payer with a credential nobody knows. The caller never awaits a
 * failure into its response.
 */
@Injectable()
export class PayerSecurityNoticeService {
  private readonly logger = new Logger(PayerSecurityNoticeService.name);

  constructor(
    private readonly payers: PayersRepository,
    private readonly pii: PiiCryptoService,
    @Inject(PAYER_SECURITY_NOTICE_MAILER) private readonly mailer: PayerSecurityNoticeMailer,
  ) {}

  async notify(payerId: string, kind: PayerSecurityNoticeKind): Promise<void> {
    try {
      const row = await this.payers.findById(payerId);
      if (!row) {
        this.logger.warn(
          `payer security notice skipped payer=${payerId.slice(0, 8)}… reason=no_row`,
        );
        return;
      }
      if (row.emailEnc === null) {
        this.logger.log(
          `payer security notice skipped payer=${payerId.slice(0, 8)}… reason=no_email`,
        );
        return;
      }
      const email = this.pii.decrypt(row.emailEnc);
      await this.mailer.send({ email, kind, at: new Date() });
    } catch (err) {
      // Opaque class only: a provider error can echo the recipient, and a decrypt error can
      // echo the token. Neither belongs in a log line.
      this.logger.error(
        `payer security notice failed payer=${payerId.slice(0, 8)}… kind=${kind} reason=${
          err instanceof Error ? err.name : "unknown"
        }`,
      );
    }
  }
}
