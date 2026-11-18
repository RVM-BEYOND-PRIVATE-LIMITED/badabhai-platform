import { Module } from "@nestjs/common";
import { CreditRulesModule } from "../credit-rules/credit-rules.module";
import { FeatureRolloutModule } from "../feature-rollout/feature-rollout.module";
import { PricingModule } from "../pricing/pricing.module";
import { PostingChoiceRepository } from "./posting-choice.repository";
import { PostingChoiceService } from "./posting-choice.service";

/**
 * #2751 items 1 to 3 — the posting choice (which posting button a company tapped). Imported by
 * `JobPostingsModule` (the publish records the tap) and the payer portal (the options route).
 *
 * One-way edges only: FeatureRolloutModule (the `posting_choice` and `credit_rules` switches),
 * CreditRulesModule (the welcome credit count) and PricingModule (the Starter pack's live price)
 * import nothing that reaches back here. EventsService, DATABASE and SERVER_CONFIG are global.
 */
@Module({
  imports: [FeatureRolloutModule, CreditRulesModule, PricingModule],
  providers: [PostingChoiceService, PostingChoiceRepository],
  exports: [PostingChoiceService],
})
export class PostingChoiceModule {}
