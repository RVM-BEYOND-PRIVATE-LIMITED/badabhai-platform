import { Module } from "@nestjs/common";
import { PricingModule } from "../pricing/pricing.module";
import { PostingPlansController } from "./posting-plans.controller";
import { PostingPlansService } from "./posting-plans.service";
import { PostingPlansRepository } from "./posting-plans.repository";

/**
 * Paid job-posting plans + boosters (ADR-0013 Decision B) + per-payer hiring capacity
 * (ADR-0016). Imports PricingModule to resolve prices through the one engine; EventsService
 * (global) emits payment.* + job_posting.purchased/boosted + capacity.purchased +
 * posting_plan.paused/resumed; SERVER_CONFIG (global) gates real payments + holds the
 * capacity default.
 *
 * #1166 (2026-08-26): the ops `CapacityController` (`POST /payers/:payerId/capacity`,
 * InternalServiceGuard, advisory `:payerId`) was RETIRED — no caller existed anywhere in
 * the repo, its Flutter capacity-purchase UI was already removed, and it duplicated the
 * live payer-self route below. `PostingPlansService.buyCapacity` is unchanged and still
 * exported for that route.
 */
@Module({
  imports: [PricingModule],
  controllers: [PostingPlansController],
  providers: [PostingPlansService, PostingPlansRepository],
  // Export ONLY the service so the payer-portal route group (ADR-0019) can reuse the exact
  // same capacity buy/read logic. PostingPlansRepository stays unexported (single-writer),
  // mirroring how UnlocksModule exports only UnlockService.
  exports: [PostingPlansService],
})
export class PostingPlansModule {}
