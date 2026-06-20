import { Module } from "@nestjs/common";
import { ConsentModule } from "../consent/consent.module";
import { PayersModule } from "../payers/payers.module";
import { UnlocksController } from "./unlocks.controller";
import { UnlockService } from "./unlocks.service";
import { UnlocksRepository } from "./unlocks.repository";
import { PaymentGateway } from "./payment-gateway";

/**
 * Contact Unlock + Reveal (ADR-0010, Stream A): the routed-disclosure monetization
 * spine. controller (thin, PayerAuthGuard — the self-serve payer surface, R16 / LC-1) →
 * UnlockService (the fail-closed chokepoint + event emission) → UnlocksRepository (sole
 * writer of unlocks/unlock_routing) + PaymentGateway (the mock-credit seam).
 *
 * Imports ConsentModule for ConsentRepository (the employer_sharing disclosure-consent
 * read — step [1]), and PayersModule so the controller's `@UseGuards(PayerAuthGuard)` +
 * the per-payer XB-G cap ({@link import("../payers/payer-disclosure-rate-limit.service").PayerDisclosureRateLimit})
 * are resolvable in this injector (PayersModule exports both). EventsService
 * (EventsModule), the Drizzle DATABASE (DatabaseModule), WorkersRepository
 * (WorkersModule), PiiCryptoService (CryptoModule), and SERVER_CONFIG (AppConfigModule)
 * are all @Global, so they need no import here — exactly the cross-module DI lesson from
 * PR #38 (a guard/provider's deps must be reachable in the resolving injector, and a
 * module may only re-export a MODULE it imports).
 */
@Module({
  imports: [ConsentModule, PayersModule],
  controllers: [UnlocksController],
  providers: [UnlockService, UnlocksRepository, PaymentGateway],
  // Export ONLY the service (the fail-closed chokepoint) so the payer-portal route
  // group (ADR-0019) can reuse the exact same disclosure logic. UnlocksRepository
  // stays unexported — it remains the structural single-writer (F-2/F-5/T5-b).
  exports: [UnlockService],
})
export class UnlocksModule {}
