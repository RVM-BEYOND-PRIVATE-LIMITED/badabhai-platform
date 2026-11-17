import { CreditRulesModule } from "../credit-rules/credit-rules.module";
import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { CampusLinkModule } from "../campus-link/campus-link.module";
import { FeatureRolloutModule } from "../feature-rollout/feature-rollout.module";
import { ConsentModule } from "../consent/consent.module";
import { PayersModule } from "../payers/payers.module";
import { PricingModule } from "../pricing/pricing.module";
import { CREDIT_LOT_EXPIRY_QUEUE, REFERRAL_BONUS_QUEUE } from "../queue/queue.constants";
import { UnlocksController } from "./unlocks.controller";
import { UnlockService } from "./unlocks.service";
import { UnlocksRepository } from "./unlocks.repository";
import { PaymentGateway } from "./payment-gateway";
import { RazorpayClient } from "./razorpay.client";
import { RazorpayWebhookController } from "./razorpay-webhook.controller";
import { RazorpayWebhookGuard } from "./razorpay-webhook.guard";
import { CreditLotExpirySweepProcessor } from "./credit-lot-expiry-sweep.processor";

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
    // ADR-0037 Decision 6 — the settle path reads the payer's lifecycle status to decide
    // whether a captured payment needs a Finance/Admin alert. A one-way edge: PayersModule
    // has no dependency on unlocks, so this cannot become a cycle.
    PayersModule,
    // §X.6 — leg 2 of the ₹20 activation-bonus rule fires on a granted unlock. PRODUCER
    // ONLY: the processor lives in ReferralAttributionModule, so this stays a queue
    // registration and NOT a module import (no dependency from `unlocks` into `referrals`).
    BullModule.registerQueue({ name: REFERRAL_BONUS_QUEUE }),
    // #2749 item 4 — the credit-lot expiry sweep's clock. Registered here because the processor
    // lives here, beside the wallet it expires (it reaches the lots only through
    // UnlocksRepository, the module's single writer); the tick carries no payload.
    BullModule.registerQueue({ name: CREDIT_LOT_EXPIRY_QUEUE }),
    // #2752 — InstituteOpenGate: a linked institute student opens only for a company he applied
    // to. A one-way edge: the Campus link has no dependency on unlocks.
    CampusLinkModule,
    // #2747 — the `contact_rules` switch (open for good, the contact read). No dependency back.
    FeatureRolloutModule,
    // #2750 — the credit rules (what a contact costs). CreditRulesModule has no dependency back.
    CreditRulesModule,
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
    CreditLotExpirySweepProcessor,
  ],
  // Export ONLY the service (the fail-closed chokepoint) so the payer-portal route
  // group (ADR-0019) can reuse the exact same disclosure logic. UnlocksRepository
  // stays unexported — it remains the structural single-writer (F-2/F-5/T5-b).
  exports: [UnlockService],
})
export class UnlocksModule {}
