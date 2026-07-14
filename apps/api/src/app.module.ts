import { Module, type MiddlewareConsumer, type NestModule } from "@nestjs/common";
import { AppConfigModule } from "./config/config.module";
import { CryptoModule } from "./common/crypto.module";
import { DatabaseModule } from "./database/database.module";
import { QueueModule } from "./queue/queue.module";
import { EventsModule } from "./events/events.module";
import { AiModule } from "./ai/ai.module";
import { WorkersModule } from "./workers/workers.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { HealthModule } from "./health/health.module";
import { AuthModule } from "./auth/auth.module";
import { ConsentModule } from "./consent/consent.module";
import { ChatModule } from "./chat/chat.module";
import { VoiceModule } from "./voice/voice.module";
import { ProfilesModule } from "./profiles/profiles.module";
import { ResumeModule } from "./resume/resume.module";
import { InterviewKitModule } from "./interview-kit/interview-kit.module";
import { ActionsModule } from "./actions/actions.module";
import { ApplicationsModule } from "./applications/applications.module";
import { JobPostingsModule } from "./job-postings/job-postings.module";
import { PricingModule } from "./pricing/pricing.module";
import { PostingPlansModule } from "./posting-plans/posting-plans.module";
import { ReachModule } from "./reach/reach.module";
import { PaceModule } from "./pace/pace.module";
import { UnlocksModule } from "./unlocks/unlocks.module";
import { MessagingModule } from "./messaging/messaging.module";
import { ResumeDisclosureModule } from "./disclosures/resume-disclosure.module";
import { PayersModule } from "./payers/payers.module";
import { PayerPortalModule } from "./payer-portal/payer-portal.module";
import { AgencyModule } from "./agency/agency.module";
import { AdminModule } from "./admin/admin.module";
import { RateLimitModule } from "./common/rate-limit/rate-limit.module";
import { PdfModule } from "./common/pdf/pdf.module";
import { RequestIdMiddleware } from "./common/middleware/request-id.middleware";

@Module({
  imports: [
    // Global cross-cutting modules:
    AppConfigModule,
    CryptoModule,
    DatabaseModule,
    QueueModule,
    EventsModule,
    AiModule,
    WorkersModule,
    NotificationsModule,
    RateLimitModule,
    PdfModule,
    // Feature modules:
    HealthModule,
    AuthModule,
    ConsentModule,
    ChatModule,
    VoiceModule,
    ProfilesModule,
    ResumeModule,
    InterviewKitModule,
    ActionsModule,
    ApplicationsModule,
    JobPostingsModule,
    PricingModule,
    PostingPlansModule,
    ReachModule,
    UnlocksModule,
    MessagingModule,
    ResumeDisclosureModule,
    PaceModule,
    // Payer portal (ADR-0019 Phase 1 — closes R16/LC-1): the previously un-wired
    // identity/tenancy foundation + the external self-serve `/payer/*` route group.
    PayersModule,
    PayerPortalModule,
    // Agency Supply Portal demand slice (ADR-0022): agent-only `/payer/agency/*` routes
    // (jobs CRUD + invites + referrals summary) + the consent-gated attribution seam.
    AgencyModule,
    // Admin Ops Portal — AUTH + RBAC + MFA foundation (ADR-0025 ADMIN-1): the 4th principal
    // (`/admin/*` route group behind AdminAuthGuard). Auth + RBAC + MFA only; the feature
    // routes (events query / entity actions / PII reveal) are ADMIN-2/ADMIN-3.
    AdminModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes("*");
  }
}
