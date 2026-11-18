import { Injectable, Logger } from "@nestjs/common";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { ReferralHelperNameRepository } from "./referral-helper-name.repository";
import { isWellFormedReferralCode } from "./referral-resolve";

/**
 * Looked up in place of a malformed code, so a malformed code costs the same query as an unknown
 * one. Not 12 lowercase hex, so no code space ever mints it.
 */
const NEVER_A_CODE = "-";

/**
 * #2753 item 12 — the helper's DISPLAY name for the pre-code screen, behind
 * `REFERRAL_HELPER_NAME_ENABLED` (the controller's gate; nothing here runs while it is off).
 *
 * WHAT CAN COME BACK. Only an agency's COMPANY name, for a live agency code
 * ({@link ReferralHelperNameRepository}). A worker referrer's code gives null: no name a
 * referrer agreed to show exists today, and a worker's stored full name is never shown. A future
 * consented display-name field would fill that case. Unknown, expired, spent and malformed codes
 * give null too, and so does any failure (fail closed), so null says nothing about why.
 *
 * NO NAME IN A LOG. A failure logs the error class only: never the code (a bearer token), never
 * the ciphertext, never the name.
 */
@Injectable()
export class ReferralHelperNameService {
  private readonly logger = new Logger(ReferralHelperNameService.name);

  constructor(
    private readonly repo: ReferralHelperNameRepository,
    private readonly pii: PiiCryptoService,
  ) {}

  async displayName(code: unknown): Promise<string | null> {
    // The validator `GET /r/:code` uses: 12 lowercase hex, nothing trimmed or folded.
    const wellFormed = typeof code === "string" && isWellFormedReferralCode(code);
    try {
      const nameEnc = await this.repo.findAgencyNameEnc(wellFormed ? code : NEVER_A_CODE);
      if (!wellFormed || nameEnc === null) return null;
      const name = this.pii.decrypt(nameEnc).trim();
      return name.length > 0 ? name : null;
    } catch (err) {
      this.logger.warn(`referral helper name not read (neutralized) (${(err as Error).name})`);
      return null;
    }
  }
}
