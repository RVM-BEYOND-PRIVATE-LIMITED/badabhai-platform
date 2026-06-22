import { Module } from "@nestjs/common";
import { PricingModule } from "../pricing/pricing.module";
import { PostingPlansController } from "./posting-plans.controller";
import { CapacityController } from "./capacity.controller";
import { PostingPlansService } from "./posting-plans.service";
import { PostingPlansRepository } from "./posting-plans.repository";

/**
 * Paid job-posting plans + boosters (ADR-0013 Decision B) + per-payer hiring capacity
 * (ADR-0016). Imports PricingModule to resolve prices through the one engine; EventsService
 * (global) emits payment.* + job_posting.purchased/boosted + capacity.purchased +
 * posting_plan.paused/resumed; SERVER_CONFIG (global) gates real payments + holds the
 * capacity default + the InternalServiceGuard token for the capacity endpoint.
 */
@Module({
  imports: [PricingModule],
  controllers: [PostingPlansController, CapacityController],
  providers: [PostingPlansService, PostingPlansRepository],
  // Export ONLY the service so the payer-portal route group (ADR-0019) can reuse the exact
  // same capacity buy/read logic. PostingPlansRepository stays unexported (single-writer),
  // mirroring how UnlocksModule exports only UnlockService.
  exports: [PostingPlansService],
})
export class PostingPlansModule {}
