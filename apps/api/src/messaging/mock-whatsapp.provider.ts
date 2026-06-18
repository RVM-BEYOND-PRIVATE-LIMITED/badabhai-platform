import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PiiCryptoService } from "../common/pii-crypto.service";
import type { WhatsAppMessage, WhatsAppProvider, WhatsAppSendResult } from "./whatsapp.provider";

/**
 * Default WhatsApp provider for alpha — sends NOTHING. No network call, no spend,
 * and the worker's phone NEVER leaves the process. Logs only a phone-HASH prefix +
 * the template id + status (never the raw phone or body), consistent with the SMS
 * console provider. Returns a synthetic provider id with `realCall:false`.
 */
@Injectable()
export class MockWhatsAppProvider implements WhatsAppProvider {
  private readonly logger = new Logger(MockWhatsAppProvider.name);

  constructor(private readonly pii: PiiCryptoService) {}

  async send(message: WhatsAppMessage): Promise<WhatsAppSendResult> {
    const hashPrefix = this.pii.hashPhone(message.phoneE164).slice(0, 8);
    this.logger.log(
      `MOCK whatsapp send template=${message.template} phone_hash=${hashPrefix}… (no real send)`,
    );
    return { providerMessageId: `mock-wa-${randomUUID()}`, realCall: false };
  }
}
