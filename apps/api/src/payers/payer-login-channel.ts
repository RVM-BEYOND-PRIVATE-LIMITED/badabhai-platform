import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { areRealMessagesEnabled } from "@badabhai/config";
import type { PayerLoginMethodEnum } from "@badabhai/event-schema";
import { SERVER_CONFIG } from "../config/config.module";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { WHATSAPP_PROVIDER, type WhatsAppProvider } from "../messaging/whatsapp.provider";

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
  /** The method this channel implements (carried into the PII-free `payer.*` events). */
  readonly method: PayerLoginMethodEnum;
  /**
   * True for the alpha MOCK channels (no real send / no spend). Gates the DEV/TEST-only
   * echo of the issued code (mirrors `SMS_PROVIDER==="console"` in the worker OtpService)
   * — a real channel never echoes.
   */
  readonly mock: boolean;
  deliver(input: PayerLoginCodeDelivery): Promise<void>;
}

/** DI token for the active {@link PayerLoginChannel} implementation. */
export const PAYER_LOGIN_CHANNEL = "PAYER_LOGIN_CHANNEL_IMPL";

/**
 * Alpha MOCK email channel (the default). Sends NOTHING over the network — the payer's
 * email and the code never leave the process. Logs only an email-HASH prefix + status
 * (never the raw email or the code). The DEV/TEST echo of the code (see OtpService) is
 * what lets a tester complete login without a real mailbox; outside dev/test there is no
 * echo, so a real email provider is a launch-gate item (a production-GA prerequisite).
 */
@Injectable()
export class MockEmailLoginChannel implements PayerLoginChannel {
  readonly method = "email_otp" as const;
  readonly mock = true;
  private readonly logger = new Logger(MockEmailLoginChannel.name);

  constructor(private readonly pii: PiiCryptoService) {}

  async deliver(input: PayerLoginCodeDelivery): Promise<void> {
    const emailHashPrefix = this.pii.hmac(input.email).slice(0, 8);
    // NEVER log the raw email or the code — only the keyed-hash prefix + status.
    this.logger.log(`MOCK payer email login code email_hash=${emailHashPrefix}… (no real send)`);
  }
}

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
