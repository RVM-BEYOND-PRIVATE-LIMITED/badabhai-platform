import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { areRealMessagesEnabled } from "@badabhai/config";
import type { PayerLoginMethodV2Enum } from "@badabhai/event-schema";
import { SERVER_CONFIG } from "../config/config.module";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { WHATSAPP_PROVIDER, type WhatsAppProvider } from "../messaging/whatsapp.provider";
import { SMS_PROVIDER, type SmsProvider } from "../sms/sms.provider";

/**
 * The one-time login code + the (decrypted, transient) destination contact handed to a
 * {@link PayerLoginChannel} for delivery. The contact PII (email/phone) is used ONLY by
 * the channel at send time and MUST NEVER be logged or evented (the SmsProvider /
 * WhatsAppProvider rule, verbatim) — a channel logs only a hash prefix + status.
 */
export interface PayerLoginCodeDelivery {
  /** The plaintext one-time code (delivered to the destination; never logged/evented). */
  code: string;
  /** The payer's normalized login email (destination for `email_otp`). */
  email: string;
  /** The payer's phone, if on file (destination for `whatsapp`); null otherwise. */
  phone: string | null;
  /** The opaque payer id — for hash-prefix logging/correlation only. */
  payerId: string;
}

/**
 * Provider-agnostic payer-login delivery seam (ADR-0019 B-R1) — the payer analogue of
 * {@link import("../sms/sms.provider").SmsProvider}. The active impl is config-selected
 * by `PAYER_LOGIN_METHOD` behind {@link PAYER_LOGIN_CHANNEL}.
 *
 * `deliver` THROWS on a delivery failure so the OTP store can roll back the issued code
 * (a failed send must leave no dangling code), exactly like `SmsProvider.sendOtp`.
 */
export interface PayerLoginChannel {
  /**
   * The method this channel implements, for its log lines. The `payer.*` events take their method
   * from the request path (`PayerAuthService`), not from here. `sms_otp` exists only in the v2 set.
   */
  readonly method: PayerLoginMethodV2Enum;
  /**
   * True for a MOCK/no-spend channel (e.g. the WhatsApp mock provider in alpha); false for
   * a REAL channel (ZeptoMail email, real WhatsApp). Informational only — the one-time code
   * is delivered to the destination and NEVER echoed back, regardless of this flag.
   */
  readonly mock: boolean;
  deliver(input: PayerLoginCodeDelivery): Promise<void>;
}

/** DI token for the active {@link PayerLoginChannel} implementation. */
export const PAYER_LOGIN_CHANNEL = "PAYER_LOGIN_CHANNEL_IMPL";

/**
 * WhatsApp login channel (ADR-0019 B-R1 over the ADR-0020 MOCK provider). Delegates
 * delivery to the shared {@link WhatsAppProvider} seam: the alpha default is the mock
 * provider (no real send / no spend; the phone never leaves to Meta). Requires the payer
 * to have a phone on file — a payer without one cannot use this channel (throws → the
 * caller maps it to the neutral "code could not be delivered" path).
 *
 * The pre-approved template id is sent (not the code body) — the code itself is verified
 * via the OTP store regardless of channel; real WhatsApp code-template variables are a
 * launch-gate detail (ADR-0020 Phase 3, human-gated). `mock` tracks the provider seam.
 */
@Injectable()
export class WhatsAppLoginChannel implements PayerLoginChannel {
  readonly method = "whatsapp" as const;
  readonly mock: boolean;
  private readonly logger = new Logger(WhatsAppLoginChannel.name);

  constructor(
    @Inject(SERVER_CONFIG) config: ServerConfig,
    @Inject(WHATSAPP_PROVIDER) private readonly whatsapp: WhatsAppProvider,
    private readonly pii: PiiCryptoService,
  ) {
    this.mock = !areRealMessagesEnabled(config);
  }

  async deliver(input: PayerLoginCodeDelivery): Promise<void> {
    if (!input.phone) {
      // No destination on file → cannot deliver. Never reveal which is the case to the
      // caller; it surfaces as the same neutral path as any other delivery failure.
      this.logger.warn(`payer whatsapp login: no phone on file payer=${input.payerId.slice(0, 8)}…`);
      throw new Error("no_phone_on_file");
    }
    // The provider logs only a phone-hash prefix; the raw phone + code never leave here.
    await this.whatsapp.send({
      phoneE164: input.phone,
      template: "payer_login_code",
      workerId: input.payerId, // opaque id for the provider's hash-prefix correlation only
    });
    void this.pii; // (reserved for future hash-prefix logging; phone hashing happens in the provider)
  }
}

/**
 * Supabase Auth adapter (ADR-0019 B-R1, locked stack) — CONFIG-GATED + INERT in PR1.
 * Selecting `PAYER_LOGIN_METHOD=supabase` without the Supabase service credentials fails
 * CLOSED at boot (`assertPayerAuthConfig`). Even WITH keys, the real Supabase
 * magic-link/OTP exchange is NOT implemented in this slice — this adapter throws rather
 * than silently succeed, so the seam is declared but no real external IdP is active.
 * Wiring the real exchange is a separate, human-reviewed increment.
 */
@Injectable()
export class SupabaseLoginChannel implements PayerLoginChannel {
  readonly method = "supabase" as const;
  readonly mock = false;

  async deliver(_input: PayerLoginCodeDelivery): Promise<void> {
    throw new Error(
      "supabase payer login adapter is config-gated and inert in this build (ADR-0019 B-R1)",
    );
  }
}

/**
 * #2754 item 1 — a COMPANY's sign-in code by SMS, to the phone on its account, through the same
 * {@link SmsProvider} seam (Fast2SMS DLT) as worker codes but on the company's own approved
 * template (`FAST2SMS_PAYER_DLT_TEMPLATE_ID`). Not selected by `PAYER_LOGIN_METHOD`: it is the
 * channel for a PHONE contact while `PAYER_SMS_OTP_ENABLED` is on, beside whichever channel serves
 * an email (`PayerOtpService` picks per request).
 *
 * Throws on a missing phone or template (the OTP store then rolls the code back, and the caller
 * answers the same neutral body as any delivery failure). The provider logs only a phone-hash
 * prefix; the code and the number never leave this call.
 */
@Injectable()
export class SmsLoginChannel implements PayerLoginChannel {
  readonly method = "sms_otp" as const;
  readonly mock = false;
  private readonly logger = new Logger(SmsLoginChannel.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
  ) {}

  async deliver(input: PayerLoginCodeDelivery): Promise<void> {
    if (!input.phone) {
      this.logger.warn(`payer sms login: no phone on file payer=${input.payerId.slice(0, 8)}…`);
      throw new Error("no_phone_on_file");
    }
    const templateId = this.config.FAST2SMS_PAYER_DLT_TEMPLATE_ID;
    // assertPayerAuthConfig refuses to boot the SMS path without it; guard anyway, fail closed.
    if (!templateId) throw new Error("payer_sms_template_not_configured");
    await this.sms.sendOtp({ phoneE164: input.phone, code: input.code, templateId });
  }
}
