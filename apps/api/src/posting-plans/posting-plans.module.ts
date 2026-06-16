import { Module } from "@nestjs/common";
import { PricingModule } from "../pricing/pricing.module";
import { PostingPlansController } from "./posting-plans.controller";
import { PostingPlansService } from "./posting-plans.service";
import { PostingPlansRepository } from "./posting-plans.repository";

/**
 * Paid job-posting plans + boosters (ADR-0013 Decision B). Imports PricingModule to
 * resolve prices through the one engine; EventsService (global) emits payment.* +
 * job_posting.purchased/boosted; SERVER_CONFIG (global) gates real payments.
 */
@Module({
  imports: [PricingModule],
  controllers: [PostingPlansController],
  providers: [PostingPlansService, PostingPlansRepository],
})
export class PostingPlansModule {}
