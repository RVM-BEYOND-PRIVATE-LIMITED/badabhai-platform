import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { RequestIdempotency } from "../common/idempotency/request-idempotency.service";
import { HiresModule } from "../hires/hires.module";
import { PayerDisclosureRateLimit } from "../payers/payer-disclosure-rate-limit.service";
import { PayersModule } from "../payers/payers.module";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";
import { PayerUnlockOutcomesController } from "./payer-unlock-outcomes.controller";
import { UnlockFollowupEnabledGuard } from "./unlock-outcomes.flag";
import { UnlockOutcomesRepository } from "./unlock-outcomes.repository";
import { UnlockOutcomesService } from "./unlock-outcomes.service";

/**
 * #2753 item 10 — THE COMPANY FOLLOW-UP (`unlock_outcomes`): what became of each contact a company
 * opened. ITS OWN MODULE, so `unlocks/` (another stream's, #2749) is read with this module's own
 * queries and never edited. Imports:
 *   - `PayersModule` for `PayerAuthGuard` and `PayerTenantScopeService` (the tenant key);
 *   - `HiresModule` for `HiresService` (a `hired` answer confirms the hire record);
 *   - BullMQ's Redis connection (client only) for `RequestIdempotency` and the per-payer write cap
 *     (`PayerDisclosureRateLimit`), each provided here as `PayerPortalModule` and `AgencyModule` do.
 * DATABASE, SERVER_CONFIG, PiiCryptoService and EventsService come from global modules.
 *
 * EXPORTS `UnlockOutcomesService` so #2750's desk can call `recordDeskOutcome` on its own
 * transaction with no change here.
 */
@Module({
  imports: [PayersModule, HiresModule, BullModule.registerQueue({ name: RESUME_RENDER_QUEUE })],
  controllers: [PayerUnlockOutcomesController],
  providers: [
    UnlockOutcomesRepository,
    UnlockOutcomesService,
    UnlockFollowupEnabledGuard,
    PayerDisclosureRateLimit,
    RequestIdempotency,
  ],
  exports: [UnlockOutcomesService],
})
export class UnlockOutcomesModule {}
