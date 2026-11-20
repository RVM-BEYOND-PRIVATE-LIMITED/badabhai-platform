import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";

import { CREDIT_BALANCE_AUDIT_QUEUE } from "../queue/queue.constants";
import { CreditBalanceAuditProcessor } from "./credit-balance-audit.processor";
import { CreditBalanceAuditRepository } from "./credit-balance-audit.repository";
import { CreditBalanceAuditService } from "./credit-balance-audit.service";

/**
 * #2774 — THE NIGHTLY CREDIT BALANCE AUDIT: a daily, read-only check that every wallet's balance
 * equals its ledger sum and its lots' remaining credits.
 *
 * ITS OWN MODULE, a leaf nothing imports, so no realm's module is edited and no cycle can close.
 * DATABASE, SERVER_CONFIG and EventsService come from global modules. INERT until
 * CREDIT_BALANCE_AUDIT_ENABLED is on: a tick returns at once without a query.
 */
@Module({
  imports: [BullModule.registerQueue({ name: CREDIT_BALANCE_AUDIT_QUEUE })],
  providers: [
    CreditBalanceAuditRepository,
    CreditBalanceAuditService,
    CreditBalanceAuditProcessor,
  ],
})
export class CreditBalanceAuditModule {}
