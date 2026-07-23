import { Module } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { areRealMessagesEnabled } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { ConsentModule } from "../consent/consent.module";
import { AuthModule } from "../auth/auth.module";
import { WHATSAPP_PROVIDER, type WhatsAppProvider } from "./whatsapp.provider";
import { MockWhatsAppProvider } from "./mock-whatsapp.provider";
import { MetaWhatsAppProvider } from "./meta-whatsapp.provider";
import { MessagingConsentService } from "./messaging-consent.service";
import { ReengagementService } from "./reengagement.service";
import { InviteService } from "./invite.service";
import { InviteRepository } from "./invite.repository";
import { MessagingController } from "./messaging.controller";

/**
 * WhatsApp invite funnel + re-engagement (ADR-0020). The active {@link WhatsAppProvider}
 * is config-selected behind {@link WHATSAPP_PROVIDER} (mirrors SmsModule): the MOCK
 * provider is the default; the real Meta provider is chosen ONLY when
 * `areRealMessagesEnabled` (MESSAGING_ENABLE_REAL + keys) — a human gate, and even then
 * the real impl fails closed (unimplemented) until Phase 3.
 *
 * Imports ConsentModule (ConsentRepository — the whatsapp_messaging gate read) and
 * AuthModule (WorkerAuthGuard for invite create). EventsService, PiiCryptoService, the
 * Drizzle DATABASE, and SERVER_CONFIG are @Global.
 */
@Module({
  imports: [ConsentModule, AuthModule],
  controllers: [MessagingController],
  providers: [
    MockWhatsAppProvider,
    MetaWhatsAppProvider,
    {
      provide: WHATSAPP_PROVIDER,
      inject: [SERVER_CONFIG, MockWhatsAppProvider, MetaWhatsAppProvider],
      useFactory: (
        config: ServerConfig,
        mock: MockWhatsAppProvider,
        meta: MetaWhatsAppProvider,
      ): WhatsAppProvider => (areRealMessagesEnabled(config) ? meta : mock),
    },
    MessagingConsentService,
    ReengagementService,
    InviteService,
    InviteRepository,
  ],
  // Exported so ReferralAttributionModule can call the consent-gated worker→worker
  // attribution seam (recordAccept) from the onboarding hook (ADR-0020).
  exports: [InviteService],
})
export class MessagingModule {}
