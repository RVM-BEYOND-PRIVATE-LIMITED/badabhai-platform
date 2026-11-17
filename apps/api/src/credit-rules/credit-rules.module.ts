import { Module } from "@nestjs/common";
import { FeatureRolloutModule } from "../feature-rollout/feature-rollout.module";
import { CreditRulesRepository } from "./credit-rules.repository";
import { CreditRulesService } from "./credit-rules.service";

/**
 * #2750 — the credit rules' settings (`credit_rules_config`). Exports {@link CreditRulesService},
 * the one reader every credit rule asks for its numbers. DATABASE, SERVER_CONFIG and EventsService
 * come from global modules. Imported by AdminModule (the settings routes) and, as later parts land,
 * by the unlock, posting and admin-grant paths.
 */
@Module({
  imports: [FeatureRolloutModule],
  providers: [CreditRulesRepository, CreditRulesService],
  exports: [CreditRulesService],
})
export class CreditRulesModule {}
