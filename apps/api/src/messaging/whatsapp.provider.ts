/**
 * WhatsApp delivery boundary (ADR-0020 Decision 1) — the provider seam, mirroring
 * {@link import("../sms/sms.provider").SmsProvider}.
 *
 * The implementation is the ONLY place a raw phone is used: it is read at send time,
 * handed to the provider, and **MUST NOT be logged or put in an event** (only a
 * phone-HASH prefix + status, per the no-raw-PII invariant). `send` THROWS on a
 * delivery failure so the caller can emit `messaging.failed` and never record a sent.
 */
export interface WhatsAppMessage {
  /** Raw E.164 phone — used ONLY by the provider, never logged/evented. */
  phoneE164: string;
  /** A pre-approved WhatsApp template id (NOT the rendered body). */
  template: string;
  /** Opaque worker id — for hash-prefix logging/correlation only. */
  workerId: string;
}

export interface WhatsAppSendResult {
  /** Opaque provider message id (mock returns a synthetic id). */
  providerMessageId: string;
  /** True only on the real Meta path; false for the mock provider. */
  realCall: boolean;
}

export interface WhatsAppProvider {
  send(message: WhatsAppMessage): Promise<WhatsAppSendResult>;
}

/** DI token for the active {@link WhatsAppProvider} implementation. */
export const WHATSAPP_PROVIDER = "WHATSAPP_PROVIDER_IMPL";
