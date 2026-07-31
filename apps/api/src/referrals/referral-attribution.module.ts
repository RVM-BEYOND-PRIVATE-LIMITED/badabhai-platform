import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { BullModule } from "@nestjs/bullmq";
import { REFERRAL_BONUS_QUEUE } from "../queue/queue.constants";
import { ConsentModule } from "../consent/consent.module";
import { MessagingModule } from "../messaging/messaging.module";
import { AgencyModule } from "../agency/agency.module";
import { AuthModule } from "../auth/auth.module";
import { RateLimitModule } from "../common/rate-limit/rate-limit.module";
import { ReferralAttributionService } from "./referral-attribution.service";
import { ReferralAttributionController } from "./referral-attribution.controller";
import { ReferralBonusService } from "./referral-bonus.service";
import { ReferralBonusRepository } from "./referral-bonus.repository";
import { ReferralBonusController } from "./referral-bonus.controller";
import { ReferralBonusProcessor } from "./referral-bonus.processor";
import { WorkerActivityInterceptor } from "./worker-activity.interceptor";

/**
 * Referral attribution (ADR-0020 + ADR-0022) — the worker-onboarding hook that finally
 * CALLS the two consent-gated attribution seams. Strictly additive.
 *
 * Imports (all one-directional — no module cycle; nothing imports THIS module except
 * AppModule):
 *  - {@link ConsentModule}   — ConsentRepository (the invariant-#6 active-consent gate)
 *  - {@link MessagingModule} — InviteService.recordAccept (worker→worker, ADR-0020)
 *  - {@link AgencyModule}    — AgencyService.attributeWorkerToInvite (agency→worker, ADR-0022)
 *  - {@link AuthModule}      — WorkerAuthGuard (the `invited_worker_id` is the SESSION worker)
 *
 * Deliberately does NOT live inside ConsentModule: ConsentModule is imported by BOTH
 * MessagingModule and AgencyModule (for ConsentRepository), so embedding the call there
 * would create a module cycle. A dedicated module keeps the graph acyclic.
 *
 * ALSO HOSTS (blocker B4 / §X.6 — the rest of the attribution chain):
 *  - {@link ReferralBonusService} + repository + ops controller — the MOCK ₹20 activation
 *    bonus and its fraud rule. It belongs here because it consumes exactly this module's
 *    output (the `invites` attribution) and nothing else.
 *  - {@link ReferralBonusProcessor} on REFERRAL_BONUS_QUEUE — the CONSUMER of the two real
 *    triggers (profile confirmed / unlock granted). Those producers only register the
 *    queue, so neither `profiles` nor `unlocks` gains a module edge into this one: no
 *    import cycle, and the evaluation stays off both request paths.
 *  - {@link WorkerActivityInterceptor} registered under `APP_INTERCEPTOR`. Nest applies such
 *    a provider GLOBALLY no matter which module declares it, so the `worker.active`
 *    retention signal is produced for every authenticated worker request WITHOUT modifying
 *    any controller, guard, or other module. It is declared here because retention is the
 *    downstream half of the same attribution chain.
 */
@Module({
  imports: [
    ConsentModule,
    MessagingModule,
    AgencyModule,
    AuthModule,
    RateLimitModule,
    // The bonus-evaluation queue — consumed by ReferralBonusProcessor below, produced by
    // ProfilesService (confirm) and UnlocksService (grant).
    BullModule.registerQueue({ name: REFERRAL_BONUS_QUEUE }),
  ],
  controllers: [ReferralAttributionController, ReferralBonusController],
  providers: [
    ReferralAttributionService,
    ReferralBonusService,
    ReferralBonusRepository,
    ReferralBonusProcessor,
    // GLOBAL by virtue of the APP_INTERCEPTOR token (not by being in this module).
    { provide: APP_INTERCEPTOR, useClass: WorkerActivityInterceptor },
  ],
})
export class ReferralAttributionModule {}
