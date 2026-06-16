import { Module } from "@nestjs/common";
import { ConsentModule } from "../consent/consent.module";
import { UnlocksController } from "./unlocks.controller";
import { UnlockService } from "./unlocks.service";
import { UnlocksRepository } from "./unlocks.repository";
import { PaymentGateway } from "./payment-gateway";

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
  imports: [ConsentModule],
  controllers: [UnlocksController],
  providers: [UnlockService, UnlocksRepository, PaymentGateway],
})
export class UnlocksModule {}
