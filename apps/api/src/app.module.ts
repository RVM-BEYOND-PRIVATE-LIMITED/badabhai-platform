import { Module, type MiddlewareConsumer, type NestModule } from "@nestjs/common";
import { AppConfigModule } from "./config/config.module";
import { CryptoModule } from "./common/crypto.module";
import { DatabaseModule } from "./database/database.module";
import { QueueModule } from "./queue/queue.module";
import { EventsModule } from "./events/events.module";
import { AiModule } from "./ai/ai.module";
import { WorkersModule } from "./workers/workers.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { PushModule } from "./push/push.module";
import { HealthModule } from "./health/health.module";
import { AuthModule } from "./auth/auth.module";
import { ConsentModule } from "./consent/consent.module";
import { ChatModule } from "./chat/chat.module";
import { ProfilingModule } from "./profiling/profiling.module";
import { VoiceModule } from "./voice/voice.module";
import { SkillsModule } from "./skills/skills.module";
import { OccupationModule } from "./occupation/occupation.module";
import { ProfilesModule } from "./profiles/profiles.module";
import { ResumeModule } from "./resume/resume.module";
import { InterviewKitModule } from "./interview-kit/interview-kit.module";
import { ActionsModule } from "./actions/actions.module";
import { FeedbackModule } from "./feedback/feedback.module";
import { ApplicationsModule } from "./applications/applications.module";
import { JobsModule } from "./jobs/jobs.module";
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
import { ReferralAttributionModule } from "./referrals/referral-attribution.module";
import { AdminModule } from "./admin/admin.module";
import { EmailNotificationModule } from "./notifications/email-notification.module";
import { RateLimitModule } from "./common/rate-limit/rate-limit.module";
import { PdfModule } from "./common/pdf/pdf.module";
import { MatchModule } from "./match/match.module";
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
    // ADR-0034 — worker push (consumer half: provider + processor). Ships INERT:
    // PUSH_ENABLE_REAL defaults false, so the mock provider is bound and nothing sends.
    PushModule,
    RateLimitModule,
    PdfModule,
    // Matching V1 (ADR-0036) — @Global: match config + the worker-supply/reach
    // services are consumed by profiles (moments ①/②), job-postings (③),
    // applications (④/⑤), payer-portal (⑥) and posting-plans (the boost supply
    // gate). Behaviour is gated by MATCH_V1_ENABLED (default OFF); importing the
    // module changes nothing until that flips.
    MatchModule,
    // Feature modules:
    HealthModule,
    AuthModule,
    ConsentModule,
    ChatModule,
    // THE DETERMINISTIC INTERVIEW, imported EXPLICITLY even though `ChatModule` already pulls it
    // in transitively. The engine spent months in this repository reachable from nothing, behind
    // a boot test that asserted it had no controllers and was happy about it. An explicit import
    // is the line a reader checks to answer "is the voice form actually wired up?", and the boot
    // test now asserts this exact entry rather than its absence.
    ProfilingModule,
    VoiceModule,
    SkillsModule,
    OccupationModule,
    ProfilesModule,
    ResumeModule,
    InterviewKitModule,
    ActionsModule,
    // #997 — the worker's own feedback sink: POST /workers/me/feedback behind WorkerAuthGuard +
    // ConsentGuard, storing the row and its `feedback.submitted` event in ONE transaction. Its
    // own module because the route is its own controller, which is what keeps it out of
    // `OPS_ROUTES` — see `worker-feedback.controller.ts`.
    FeedbackModule,
    ApplicationsModule,
    // Worker-scoped job detail read (ADR-0024 final addendum): GET /jobs/:jobId,
    // WorkerAuthGuard + ConsentGuard, explicit PII-free projection, no event.
    JobsModule,
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
    // ADR-0038 — @Global: the ONE outbound-email pipeline every principal shares.
    EmailNotificationModule,
    PayerPortalModule,
    // Agency Supply Portal demand slice (ADR-0022): agent-only `/payer/agency/*` routes
    // (jobs CRUD + invites + referrals summary) + the consent-gated attribution seam.
    AgencyModule,
    ReferralAttributionModule,
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
