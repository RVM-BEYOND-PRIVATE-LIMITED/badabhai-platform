import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { ConsentModule } from "../consent/consent.module";
import { PricingModule } from "../pricing/pricing.module";
import { REFERRAL_BONUS_QUEUE } from "../queue/queue.constants";
import { UnlocksController } from "./unlocks.controller";
import { UnlockService } from "./unlocks.service";
import { UnlocksRepository } from "./unlocks.repository";
import { PaymentGateway } from "./payment-gateway";
import { RazorpayClient } from "./razorpay.client";
import { RazorpayWebhookController } from "./razorpay-webhook.controller";
import { RazorpayWebhookGuard } from "./razorpay-webhook.guard";

/**
 * Contact Unlock + Reveal (ADR-0010, Stream A): the routed-disclosure monetization
 * spine. controller (thin, InternalServiceGuard) → UnlockService (the fail-closed
 * chokepoint + event emission) → UnlocksRepository (sole writer of unlocks/
 * unlock_routing) + PaymentGateway (the mock-credit seam).
 *
 * Imports ConsentModule for ConsentRepository (the employer_sharing disclosure-consent
 * read — step [1]). EventsService (EventsModule), the Drizzle DATABASE (DatabaseModule),
 * WorkersRepository (WorkersModule), PiiCryptoService (CryptoModule), and SERVER_CONFIG
 * (AppConfigModule) are all @Global, so they need no import here — exactly the
 * cross-module DI lesson from PR #38 (a guard/provider's deps must be reachable in the
 * resolving injector, and a module may only re-export a MODULE it imports).
 */
@Module({
  // PricingModule (exports PricingService) — the PaymentGateway resolves credit packs
  // through the ONE pricing engine (D-6), so the price/credits CHARGED are the ones the
  // portal DISPLAYED. Same reuse shape as PostingPlansModule for plan/boost/capacity.
  imports: [
    ConsentModule,
    PricingModule,
    // §X.6 — leg 2 of the ₹20 activation-bonus rule fires on a granted unlock. PRODUCER
    // ONLY: the processor lives in ReferralAttributionModule, so this stays a queue
    // registration and NOT a module import (no dependency from `unlocks` into `referrals`).
    BullModule.registerQueue({ name: REFERRAL_BONUS_QUEUE }),
  ],
  // RazorpayWebhookController is the PUBLIC capture surface (ADR-0010 real-payments
  // stream). It lives here, beside the money chokepoint it drives, so the whole payment
  // path — gateway, settle, webhook — is one auditable module. Its only credential is the
  // HMAC signature enforced by RazorpayWebhookGuard.
  controllers: [UnlocksController, RazorpayWebhookController],
  providers: [
    UnlockService,
    UnlocksRepository,
    PaymentGateway,
    // The provider seam (SDK construction + the one order call). Kept UNEXPORTED: nothing
    // outside this module may reach the gateway credentials.
    RazorpayClient,
    RazorpayWebhookGuard,
  ],
  // Export ONLY the service (the fail-closed chokepoint) so the payer-portal route
  // group (ADR-0019) can reuse the exact same disclosure logic. UnlocksRepository
  // stays unexported — it remains the structural single-writer (F-2/F-5/T5-b).
  exports: [UnlockService],
})
export class UnlocksModule {}
