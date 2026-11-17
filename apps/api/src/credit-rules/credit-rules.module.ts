import { Module } from "@nestjs/common";
import { FeatureRolloutModule } from "../feature-rollout/feature-rollout.module";
import { PayersModule } from "../payers/payers.module";
import { CreditRulesRepository } from "./credit-rules.repository";
import { CreditRulesService } from "./credit-rules.service";
import { WelcomeCreditsRepository } from "./welcome-credits.repository";
import { WelcomeCreditsService } from "./welcome-credits.service";

/**
 * #2750 — the credit rules' settings (`credit_rules_config`) and the grants they drive.
 *
 *   - {@link CreditRulesService}: the one reader every credit rule asks for its numbers.
 *   - {@link WelcomeCreditsService} (item 4): a verified company's welcome credits, once. Called by
 *     both posting-approval routes, the admin company edit and (#2754) the company move.
 *
 * DATABASE, SERVER_CONFIG and EventsService come from global modules. PayersModule (the read-only
 * tenant resolver) imports nothing of ours, so there is no cycle.
 */
@Module({
  imports: [FeatureRolloutModule, PayersModule],
  providers: [
    CreditRulesRepository,
    CreditRulesService,
    WelcomeCreditsRepository,
    WelcomeCreditsService,
  ],
  exports: [CreditRulesService, WelcomeCreditsService],
})
export class CreditRulesModule {}
