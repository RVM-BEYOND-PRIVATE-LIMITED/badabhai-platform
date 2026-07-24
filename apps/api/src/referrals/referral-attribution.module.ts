import { Module } from "@nestjs/common";
import { ConsentModule } from "../consent/consent.module";
import { MessagingModule } from "../messaging/messaging.module";
import { AgencyModule } from "../agency/agency.module";
import { AuthModule } from "../auth/auth.module";
import { RateLimitModule } from "../common/rate-limit/rate-limit.module";
import { ReferralAttributionService } from "./referral-attribution.service";
import { ReferralAttributionController } from "./referral-attribution.controller";

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
 */
@Module({
  imports: [ConsentModule, MessagingModule, AgencyModule, AuthModule, RateLimitModule],
  controllers: [ReferralAttributionController],
  providers: [ReferralAttributionService],
})
export class ReferralAttributionModule {}
