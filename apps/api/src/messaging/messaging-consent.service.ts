import { Injectable } from "@nestjs/common";
import { ConsentRepository } from "../consent/consent.repository";

/** The exact consent purpose that gates a WhatsApp send (ADR-0020 Decision 2). */
export const WHATSAPP_MESSAGING_PURPOSE = "whatsapp_messaging";

/**
 * Consent-to-message chokepoint (ADR-0020 Decision 2) — FAIL-CLOSED. A worker may be
 * messaged over WhatsApp ONLY if their LATEST `worker_consents` row carries
 * `whatsapp_messaging` AND is not revoked. Mirrors the `employer_sharing` /
 * corpus-consent purpose-specific gates. Anything ambiguous → NO send:
 * missing/revoked/purpose-absent/any error all return false.
 */
@Injectable()
export class MessagingConsentService {
  constructor(private readonly consents: ConsentRepository) {}

  async hasWhatsAppConsent(workerId: string): Promise<boolean> {
    try {
      const latest = await this.consents.findLatestByWorker(workerId);
      if (!latest || latest.revokedAt !== null) return false;
      return (latest.purposes ?? []).includes(WHATSAPP_MESSAGING_PURPOSE);
    } catch {
      return false; // fail-closed: never "send on doubt"
    }
  }
}
