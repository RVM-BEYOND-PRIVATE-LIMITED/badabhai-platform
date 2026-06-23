import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";
import { PayersModule } from "../payers/payers.module";
import { ConsentModule } from "../consent/consent.module";
import { PayerDisclosureRateLimit } from "../payers/payer-disclosure-rate-limit.service";
import { AgencyService } from "./agency.service";
import { AgencyJobsRepository } from "./agency-jobs.repository";
import { AgencyInvitesRepository } from "./agency-invites.repository";
import { AgencyJobsController } from "./agency-jobs.controller";
import { AgencyInvitesController } from "./agency-invites.controller";

/**
 * Agency Supply Portal — demand slice (ADR-0022, ACCEPTED; mock + staging-only).
 *
 * A NEW module on the external self-serve payer surface. Every route is agent-only
 * (`@UseGuards(PayerAuthGuard, PayerRoleGuard)` + `@PayerRoles('agent')`) and tenant-scoped
 * on `jobs.payer_id` / `agency_invites.inviter_payer_id` via the payer-scope chokepoint —
 * the `payer_id` is always the verified SESSION payer (XB-A), never a body/param.
 *
 * Reuses:
 *  - {@link PayersModule} — PayerAuthGuard + PayerRoleGuard (exported) for the guard chain.
 *  - {@link ConsentModule} — ConsentRepository (exported) for the consent-gated attribution.
 *  - {@link EventsService} — @Global; emits the new job.* / agency_invite.* events.
 *  - {@link PayerDisclosureRateLimit} — the per-payer fail-closed cap, re-provided here on a
 *    new "agency_invite_mint" scope (the service is not exported by PayersModule); it needs
 *    the BullMQ Redis client, so the queue is registered here too (the PayerPortalModule
 *    pattern). SERVER_CONFIG is @Global.
 *
 * Applicants reuse the SHIPPED `/payer/reach/jobs/:jobId/applicants` — no applicant route
 * lives here. Does NOT modify any existing payer route (strictly additive).
 */
@Module({
  imports: [
    PayersModule,
    ConsentModule,
    // Reuse BullMQ's Redis connection (client only) for the per-payer invite-mint cap.
    BullModule.registerQueue({ name: RESUME_RENDER_QUEUE }),
  ],
  controllers: [AgencyJobsController, AgencyInvitesController],
  providers: [
    AgencyService,
    AgencyJobsRepository,
    AgencyInvitesRepository,
    PayerDisclosureRateLimit,
  ],
  // Export the service so the worker consent/onboarding path can invoke the consent-gated
  // attribution seam (attributeWorkerToInvite) when an invite code is present.
  exports: [AgencyService],
})
export class AgencyModule {}
