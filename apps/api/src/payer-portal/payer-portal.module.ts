import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import type { ServerConfig } from "@badabhai/config";
import { areRealMessagesEnabled } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";
import { PayersModule } from "../payers/payers.module";
import { UnlocksModule } from "../unlocks/unlocks.module";
import { PostingPlansModule } from "../posting-plans/posting-plans.module";
import { ReachModule } from "../reach/reach.module";
import { WHATSAPP_PROVIDER, type WhatsAppProvider } from "../messaging/whatsapp.provider";
import { MockWhatsAppProvider } from "../messaging/mock-whatsapp.provider";
import { MetaWhatsAppProvider } from "../messaging/meta-whatsapp.provider";
import { PayerOtpService } from "../payers/payer-otp.service";
import { PayerDisclosureRateLimit } from "../payers/payer-disclosure-rate-limit.service";
import {
  PAYER_LOGIN_CHANNEL,
  type PayerLoginChannel,
  MockEmailLoginChannel,
  WhatsAppLoginChannel,
  SupabaseLoginChannel,
} from "../payers/payer-login-channel";
import { PayerUnlocksController } from "./payer-unlocks.controller";
import { PayerCapacityController } from "./payer-capacity.controller";
import { PayerAuthController } from "./payer-auth.controller";
import { PayerReachController } from "./payer-reach.controller";
import { PayerAuthService } from "./payer-auth.service";

/**
 * Payer portal route group (ADR-0019 Phase 1 — closes R16 / LC-1 / TD33).
 *
 * The EXTERNAL self-serve payer surface: routes under `/payer/*`, DISTINCT from the ops
 * `InternalServiceGuard` routes (one principal per route). Two controllers:
 *   - {@link PayerAuthController} — PUBLIC signup/login + guarded refresh/logout (the
 *     payer login seam: a config-selected {@link PayerLoginChannel} — mock email default /
 *     WhatsApp-mock / inert Supabase — issuing codes via {@link PayerOtpService}, minting
 *     PayerSessionService sessions), and
 *   - {@link PayerUnlocksController} — the payer-self disclosure surface behind
 *     PayerAuthGuard, reusing the {@link UnlockService} chokepoint unchanged, with the
 *     per-payer XB-G cap ({@link PayerDisclosureRateLimit}).
 *
 * Imports {@link PayersModule} (guard + session + repository foundation) and
 * {@link UnlocksModule} (the disclosure chokepoint). `EventsService`, `PiiCryptoService`,
 * `SERVER_CONFIG`, and `IpRateLimit` (RateLimitModule) are @Global. The WhatsApp provider
 * classes (deps all @Global) are re-registered here for the WhatsApp login channel (the
 * MessagingModule does not export the {@link WHATSAPP_PROVIDER} token).
 *
 * Mock + staging-only (ADR-0019 Phase 1); a `bb-security-review` PASS on the built surface
 * (XB-A…XB-H) is the pre-merge gate.
 */
@Module({
  imports: [
    PayersModule,
    UnlocksModule,
    // The payer-self capacity view/buy (ADR-0016) reuses PostingPlansService unchanged,
    // exactly as PayerUnlocksController reuses UnlockService.
    PostingPlansModule,
    // The payer-self reach view (R22) reuses ReachService (the ranking orchestration +
    // faceless boundary), exactly as PayerUnlocksController reuses UnlockService.
    ReachModule,
    // Reuse BullMQ's Redis connection (client only) for the payer OTP store + XB-G cap.
    BullModule.registerQueue({ name: RESUME_RENDER_QUEUE }),
  ],
  controllers: [
    PayerAuthController,
    PayerUnlocksController,
    PayerCapacityController,
    PayerReachController,
  ],
  providers: [
    PayerAuthService,
    PayerOtpService,
    PayerDisclosureRateLimit,
    // The login channel implementations + the WhatsApp provider seam they ride.
    MockEmailLoginChannel,
    WhatsAppLoginChannel,
    SupabaseLoginChannel,
    MockWhatsAppProvider,
    MetaWhatsAppProvider,
    {
      // Mirror SmsModule/MessagingModule: the mock provider is the alpha default; the real
      // Meta provider is chosen ONLY when areRealMessagesEnabled (a human gate) — and even
      // then it fails closed (unimplemented) until ADR-0020 Phase 3.
      provide: WHATSAPP_PROVIDER,
      inject: [SERVER_CONFIG, MockWhatsAppProvider, MetaWhatsAppProvider],
      useFactory: (
        config: ServerConfig,
        mock: MockWhatsAppProvider,
        meta: MetaWhatsAppProvider,
      ): WhatsAppProvider => (areRealMessagesEnabled(config) ? meta : mock),
    },
    {
      // The ACTIVE payer login channel, selected by PAYER_LOGIN_METHOD (ADR-0019 B-R1).
      // `supabase` is the config-gated adapter — assertPayerAuthConfig fails boot closed if
      // it is selected without keys, and the adapter is inert (throws) in this build.
      provide: PAYER_LOGIN_CHANNEL,
      inject: [SERVER_CONFIG, MockEmailLoginChannel, WhatsAppLoginChannel, SupabaseLoginChannel],
      useFactory: (
        config: ServerConfig,
        email: MockEmailLoginChannel,
        whatsapp: WhatsAppLoginChannel,
        supabase: SupabaseLoginChannel,
      ): PayerLoginChannel => {
        switch (config.PAYER_LOGIN_METHOD) {
          case "whatsapp":
            return whatsapp;
          case "supabase":
            return supabase;
          default:
            return email; // "email_otp"
        }
      },
    },
  ],
})
export class PayerPortalModule {}
