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
import { ChatCompanionModule } from "./chat-companion/chat-companion.module";
import { JobPostingsModule } from "./job-postings/job-postings.module";
import { PricingModule } from "./pricing/pricing.module";
import { PostingPlansModule } from "./posting-plans/posting-plans.module";
import { ReachModule } from "./reach/reach.module";
import { PaceModule } from "./pace/pace.module";
import { UnlocksModule } from "./unlocks/unlocks.module";
import { RelayModule } from "./relay/relay.module";
import { MessagingModule } from "./messaging/messaging.module";
import { ResumeDisclosureModule } from "./disclosures/resume-disclosure.module";
import { PayersModule } from "./payers/payers.module";
import { PayerPortalModule } from "./payer-portal/payer-portal.module";
import { CandidatesModule } from "./candidates/candidates.module";
import { CampusJobsModule } from "./campus-link/campus-jobs.module";
import { CampusLinkModule } from "./campus-link/campus-link.module";
import { CampusReviewModule } from "./campus-link/campus-review.module";
import { CampusWaiversModule } from "./campus-link/campus-waivers.module";
import { AgencyModule } from "./agency/agency.module";
import { AgencyTwinModule } from "./agency-twin/agency-twin.module";
import { CampusDrivesModule } from "./campus-drives/campus-drives.module";
import { DisplayPrefsModule } from "./display-prefs/display-prefs.module";
import { SearchExitModule } from "./search-exit/search-exit.module";
import { StillLookingModule } from "./still-looking/still-looking.module";
import { ReferralAttributionModule } from "./referrals/referral-attribution.module";
import { AdminModule } from "./admin/admin.module";
import { AdminPostingsModule } from "./admin-postings/admin-postings.module";
import { AdminHiresModule } from "./hires/admin-hires.module";
import { PayOnJoiningModule } from "./pay-on-joining/pay-on-joining.module";
import { AdminNumbersModule } from "./admin/numbers/admin-numbers.module";
import { AdminLaunchTestsModule } from "./admin/launch-tests/admin-launch-tests.module";
import { UnlockOutcomesModule } from "./unlock-outcomes/unlock-outcomes.module";
import { EmailNotificationModule } from "./notifications/email-notification.module";
import { RateLimitModule } from "./common/rate-limit/rate-limit.module";
import { PdfModule } from "./common/pdf/pdf.module";
import { MatchModule } from "./match/match.module";
import { PostingTradesModule } from "./posting-trades/posting-trades.module";
import { LearnModule } from "./learn/learn.module";
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
    // ADR-0044 — the post-completion Bada Bhai companion: GET /chat/companion + POST
    // /chat/companion/message. A leaf module (nothing imports it back), after ResumeModule and
    // JobsModule whose exports it reads. INERT until CHAT_COMPANION_ENABLED is on.
    ChatCompanionModule,
    JobPostingsModule,
    // The 16-trade posting form catalogue: the payer route (`GET /payer/posting-trades`)
    // and the shared validator both posting producers use (2026-11-03).
    PostingTradesModule,
    PricingModule,
    PostingPlansModule,
    ReachModule,
    UnlocksModule,
    // E0 — the in-app relay: payer send + worker read/reply over a granted unlock.
    RelayModule,
    MessagingModule,
    ResumeDisclosureModule,
    PaceModule,
    // LEARN label producer (migration 0091) — drains spine events into `learn_labels`
    // so reach-learn can train on real outcomes instead of synthetic fixtures. Ships
    // INERT: LEARN_LABELS_ENABLED defaults false (dry-run counts only until armed).
    LearnModule,
    // Payer portal (ADR-0019 Phase 1 — closes R16/LC-1): the previously un-wired
    // identity/tenancy foundation + the external self-serve `/payer/*` route group.
    PayersModule,
    // ADR-0038 — @Global: the ONE outbound-email pipeline every principal shares.
    EmailNotificationModule,
    PayerPortalModule,
    // ADR-0040 / E2 (owner rulings 2026-11-03) — the payer ALL-CANDIDATES search:
    // `POST /payer/candidates/search` + `GET /payer/candidates/filters`. A leaf module.
    CandidatesModule,
    // #2752 — BadaBhai Campus's service API under /internal/campus/v1, behind its own
    // CampusServiceGuard. INERT until CAMPUS_LINK_ENABLED is on: every route is a neutral 404.
    CampusLinkModule,
    // #2752 part E — the Campus jobs and applications routes (one-way onto the link module).
    CampusJobsModule,
    // #2746 PR 5 — Campus records the placement team's RVM review and sets the targeting options,
    // behind the same guard and flag. Its own module, so CampusLinkModule is imported, not edited.
    CampusReviewModule,
    // #2750 item 5 - the placement team's waiver switch (404 while the credit rules are off).
    CampusWaiversModule,
    // Agency Supply Portal demand slice (ADR-0022): agent-only `/payer/agency/*` routes
    // (jobs CRUD + invites + referrals summary) + the consent-gated attribution seam.
    AgencyModule,
    // ADR-0050 (#1957) — the agency-job V1 twin sync (event poll + sweep). A leaf; behind
    // AGENCY_TWIN_SYNC_ENABLED (off = the kill switch pauses every twin).
    AgencyTwinModule,
    // #2746 PR 6 — campus-drive requests: the company asks (/payer/campus-drive-requests), RVM's
    // placement team decides from Campus (/internal/campus/v1/drive-requests, CampusServiceGuard).
    // INERT until CAMPUS_DRIVE_REQUESTS_ROLLOUT is pilot or on: every route is a neutral 404.
    CampusDrivesModule,
    // #2819 — the theme of a worker, a company or agency login and an admin (`…/me/display-prefs`).
    // INERT until THEME_ROLLOUT opens for a login: GET answers light / theme_open false, PATCH 404.
    DisplayPrefsModule,
    // #2753 item 6 — leave company search (`workers/me/search-visibility`). INERT until
    // SEARCH_EXIT_ENABLED is on: both routes are a plain 404 and nothing reads worker_search_exits.
    SearchExitModule,
    // #2753 item 5 — the monthly "still looking?" check (`workers/me/still-looking`) and its daily
    // sweep. INERT until STILL_LOOKING_CHECK_ENABLED is on: both routes are a plain 404 and the sweep
    // reads nothing. Its push also needs STILL_LOOKING_PUSH_ENABLED (default off).
    StillLookingModule,
    ReferralAttributionModule,
    // Admin Ops Portal — AUTH + RBAC + MFA foundation (ADR-0025 ADMIN-1): the 4th principal
    // (`/admin/*` route group behind AdminAuthGuard). Auth + RBAC + MFA only; the feature
    // routes (events query / entity actions / PII reveal) are ADMIN-2/ADMIN-3.
    AdminModule,
    // #2566 — the admin posting-control WRITE surface. Above JobPostingsModule/AgencyModule
    // (both import AdminModule for its guards), so the dependency is one-directional.
    AdminPostingsModule,
    // #2753 item 9 — GET /admin/hires. Above AdminModule (its guards) and HiresModule; a 404 while
    // HIRE_RECORDS_ENABLED is off.
    AdminHiresModule,
    // #2753 item 11 — the pay-on-joining pilot's hire record (/admin/pay-on-joining-hires). A leaf
    // above AdminModule. INERT until PAY_ON_JOINING_RECORDS_ENABLED is on: every route is a 404.
    PayOnJoiningModule,
    // #2755 — the numbers screen (/admin/numbers/*): the definitions catalogue and the test-company
    // marks. A leaf above AdminModule. INERT until ADMIN_NUMBERS_ENABLED is on: every route is a 404.
    AdminNumbersModule,
    // #2755 part D — the two pre-launch tests' records (/admin/launch-tests/*). A leaf above
    // AdminModule. INERT until ADMIN_NUMBERS_ENABLED is on: every route is a 404.
    AdminLaunchTestsModule,
    // #2753 item 10 — the company follow-up: GET /payer/unlock-outcomes/due and
    // POST /payer/unlocks/:unlockId/outcome. A leaf onto PayersModule and HiresModule; a 404 while
    // UNLOCK_FOLLOWUP_ENABLED is off.
    UnlockOutcomesModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes("*");
  }
}
