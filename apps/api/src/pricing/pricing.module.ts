import { Module } from "@nestjs/common";
import { PricingController } from "./pricing.controller";
import { PricingService } from "./pricing.service";
import { PricingRepository } from "./pricing.repository";

/**
 * Config-driven Pricing Engine (ADR-0013 Decision A). EventsService (global, via
 * EventsModule) is the only external dep; the repository talks to the global
 * DATABASE provider. `PricingService` is exported so the (follow-up) job-posting
 * plan/boost + resume-disclosure modules can resolve prices through the one engine.
 */
@Module({
  controllers: [PricingController],
  providers: [PricingService, PricingRepository],
  exports: [PricingService],
})
export class PricingModule {}
