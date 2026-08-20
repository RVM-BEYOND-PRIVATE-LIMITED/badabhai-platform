import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { JwtModule } from "@nestjs/jwt";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";
import { DatabaseModule } from "../database/database.module";
import { EventsModule } from "../events/events.module";
import { PayersModule } from "../payers/payers.module";
import { AdminRepository } from "./admin.repository";
import { AdminSessionService } from "./admin-session.service";
import { AdminOtpService } from "./admin-otp.service";
import { AdminMfaSecretStore } from "./admin-mfa.store";
import { AdminAuthGuard } from "./admin-auth.guard";
import { AdminRolesGuard } from "./admin-roles.guard";
import { AdminAiTraceFlagGuard } from "./admin-ai-trace-flag.guard";
import { AdminAuthService } from "./admin-auth.service";
import { AdminAuthController } from "./admin-auth.controller";
import { AdminEventsRepository } from "./admin-events.repository";
import { AdminEventsService } from "./admin-events.service";
import { AdminEventsController } from "./admin-events.controller";
import { AdminActionsRepository } from "./admin-actions.repository";
import { AdminActionsService } from "./admin-actions.service";
import { AdminActionsController } from "./admin-actions.controller";
import { AdminPiiRevealRepository } from "./admin-pii-reveal.repository";
import { AdminPiiRevealCapService } from "./admin-pii-reveal-cap.service";
import { AdminPiiRevealService } from "./admin-pii-reveal.service";
import { AdminPiiRevealController } from "./admin-pii-reveal.controller";
import { AdminKillSwitchService } from "./admin-kill-switch.service";
import { AdminKillSwitchController } from "./admin-kill-switch.controller";
import { AdminIdentityRepository } from "./admin-identity.repository";
import { AdminIdentityCapService } from "./admin-identity-cap.service";
import { AdminIdentityService } from "./admin-identity.service";
import { AdminEntitiesRepository } from "./admin-entities.repository";
import { AdminEntitiesService } from "./admin-entities.service";
import { AdminEntitiesController } from "./admin-entities.controller";
import { AdminFinanceRepository } from "./admin-finance.repository";
import { AdminFinanceService } from "./admin-finance.service";
import { AdminFinanceController } from "./admin-finance.controller";
import { AdminDirectoryRepository } from "./admin-directory.repository";
import { AdminDirectoryService } from "./admin-directory.service";
import { AdminDirectoryController } from "./admin-directory.controller";
import { AdminDashboardRepository } from "./admin-dashboard.repository";
import { AdminDashboardService } from "./admin-dashboard.service";
import { AdminDashboardController } from "./admin-dashboard.controller";
import { AdminWorkerJourneyRepository } from "./admin-worker-journey.repository";
import { AdminWorkerJourneyService } from "./admin-worker-journey.service";
import { AdminWorkerJourneyController } from "./admin-worker-journey.controller";
import { AdminFeedbackRepository } from "./admin-feedback.repository";
import { AdminFeedbackService } from "./admin-feedback.service";
import { AdminFeedbackController } from "./admin-feedback.controller";
import { AdminAiTracesRepository } from "./admin-ai-traces.repository";
import { AdminAiTraceCapService } from "./admin-ai-trace-cap.service";
import { AdminAiTracesService } from "./admin-ai-traces.service";
import { AdminAiTracesController } from "./admin-ai-traces.controller";

/**
 * Admin Ops Portal — AUTH + RBAC + MFA foundation (ADR-0025 ADMIN-1). The 4th, highly-
 * privileged principal: a real per-person admin identity (`admin_users`), a revocable
 * rolling httpOnly-JWT session (own `ADMIN_JWT_SECRET` + `admin_session:` namespace +
 * `typ:"admin"` audience pin), email-OTP + a TOTP second factor (Node-crypto only), and the
 * deny-by-default capability model. Mirrors the payer module's structure.
 *
 * The session JWT is signed with `ADMIN_JWT_SECRET` (DISTINCT from the worker/payer
 * `JWT_SECRET`) via a module-LOCAL {@link JwtModule} registration — so the `JwtService`
 * injected into {@link AdminSessionService} uses the admin secret, never the worker/payer one.
 * `EventsModule` provides `EventsService` (the admin auth events ride the spine, READ-ONLY:
 * the admin code only EMITs via EventsService, never UPDATE/DELETE on `events`). `PiiCryptoService`
 * (CryptoModule), `SERVER_CONFIG`, and `IpRateLimit` (RateLimitModule) are @Global.
 *
 * SCOPE NOTE (ADR-0025): ADMIN-1 is auth + RBAC + MFA. ADMIN-2 adds the READ-ONLY event-spine
 * query API (`AdminEventsController`/`AdminEventsService`/`AdminEventsRepository`): list/detail/
 * trace/timeline/metrics/export, all `read_events`-gated except export (`export` capability,
 * super_admin/ops_admin only). The events repository is SELECT-ONLY (spine immutability, must-fix
 * #3). ADMIN-3a adds the GOVERNED ENTITY ACTIONS (`AdminActionsController`/`AdminActionsService`/
 * `AdminActionsRepository`): suspend/reinstate payer, grant credits, force-close posting,
 * flag/unflag worker, and admin management (invite/role/suspend, `manage_admins` super_admin
 * only). Each mutates a SYSTEM-OF-RECORD table and emits EXACTLY ONE value-free
 * `admin.action_performed` via EventsService — the spine stays append-only (must-fix #3): the
 * actions repository writes payers/credit_ledger/job_postings/worker_flags/admin_users, NEVER
 * `events`. ADMIN-3b adds the reason-gated, audited, rate-capped worker-PII REVEAL
 * (`AdminPiiRevealController`/`AdminPiiRevealService`/`AdminPiiRevealRepository` +
 * `AdminPiiRevealCapService`): `POST /admin/workers/:id/reveal-contact`, `reveal_pii`-gated
 * (super_admin/support ONLY), behind the DEFAULT-OFF `ADMIN_PII_REVEAL_ENABLED` flag (neutral 404
 * when off). It audits BEFORE decrypt (`admin.pii_viewed`, value-free), per-admin rate-caps
 * fail-closed (`admin.pii_reveal_cap_exceeded` breach), and decrypts the phone ONLY into the HTTP
 * response (never logged/cached/persisted/evented). ADMIN-3c adds the KILL-SWITCH surface
 * (`AdminKillSwitchController`/`AdminKillSwitchService`): `GET /admin/kill-switch/status` (read-only
 * DISPLAY) + `POST /admin/kill-switch/pause-request` (a value-free `admin.kill_switch_pause_requested`
 * audit of a SAFE-DIRECTION pause INTENT), `toggle_kill_switch`-gated (super_admin ONLY). Per OQ-6 it
 * DISPLAYS + records a pause intent ONLY — it NEVER enables a real provider (enabling stays
 * env/deploy-gated, §2 #5); there is no enable/resume/toggle route by construction. OBS-4 (migrating the existing
 * ops read routes behind a dual-accept guard) is DEFERRED — this module does NOT touch the
 * existing ops/InternalService routes or `apps/web`. SSE live-tail is DEFERRED to ADMIN-7.
 * BP-5 adds the DASHBOARD SUMMARY (`AdminDashboardController`/`AdminDashboardService`/
 * `AdminDashboardRepository`): `GET /admin/dashboard/summary`, `read_entities`-gated — the same
 * capability the finance aggregates declare, chosen by the DATA (live system-of-record state +
 * money; only the cap-breach block reads the spine). SELECT-ONLY and ID-FREE: AI spend from 0077's
 * `platform_ai_cost_totals` (total, by provider, by task type) carrying an explicit
 * `accruing_since` marker — those totals START at 0077 and no backfill has run — plus cap
 * breaches split by `ai.spend_cap_exceeded`'s `reason` and unfiltered volume counts. It has its
 * OWN read repository; the WRITER (`AiCostTotalsRepository`) stays unexported from `AiModule`.
 *
 * #997 adds the WORKER-FEEDBACK read (`AdminFeedbackController`/`AdminFeedbackService`/
 * `AdminFeedbackRepository`): `GET /admin/feedback`, `read_entities`-gated, SELECT-ONLY and
 * keyset-paginated like BP-1. It is the ONE read on this surface that is not faceless — it
 * projects `message`, the worker's own free text, which #997 rules is fine to store and show
 * because the worker chose to say it to us. The boundary is unchanged everywhere else: no name,
 * no phone, no join to `workers`, and no search over the message body (a substring search over
 * free text is a PII discovery tool). Identity egress remains `reveal-contact` and only that.
 * ADR-0025 Amendment 1 adds `admin.feedback_viewed` to that read and an optional `workerId`
 * LOOKUP filter — an id the admin already holds, never a search over what anyone wrote.
 */
@Module({
  imports: [
    DatabaseModule,
    EventsModule,
    // ADR-0037 — AdminActionsService needs PayerSessionService so suspending a payer
    // revokes their live sessions immediately. PayersModule exports it. One-directional:
    // PayersModule does not import AdminModule, so no forwardRef is needed.
    PayersModule,
    // Reuse BullMQ's Redis connection (client only) for the admin session/OTP/MFA-secret stores.
    BullModule.registerQueue({ name: RESUME_RENDER_QUEUE }),
    // The admin session is signed with ITS OWN secret — distinct from the worker/payer JWT.
    JwtModule.registerAsync({
      inject: [SERVER_CONFIG],
      useFactory: (config: ServerConfig) => ({
        secret: config.ADMIN_JWT_SECRET,
        signOptions: { algorithm: "HS256" },
      }),
    }),
  ],
  controllers: [
    AdminAuthController,
    AdminEventsController,
    AdminActionsController,
    AdminPiiRevealController,
    AdminKillSwitchController,
    AdminEntitiesController,
    AdminFinanceController,
    AdminDirectoryController,
    AdminDashboardController,
    AdminWorkerJourneyController,
    AdminFeedbackController,
    AdminAiTracesController,
  ],
  providers: [
    AdminRepository,
    AdminSessionService,
    AdminOtpService,
    AdminMfaSecretStore,
    AdminAuthService,
    AdminAuthGuard,
    AdminRolesGuard,
    // 0083 — the ADMIN_AI_TRACE_READ_ENABLED master switch, listed AHEAD of AdminRolesGuard in
    // AdminAiTracesController so the flag-off answer is a uniform neutral 404 for every role.
    AdminAiTraceFlagGuard,
    // ADMIN-2: read-only event-spine query API (select-only over `events`).
    AdminEventsRepository,
    AdminEventsService,
    // ADMIN-3a: governed entity actions (system-of-record writes + one value-free event each).
    AdminActionsRepository,
    AdminActionsService,
    // ADMIN-3b: reason-gated, audited, rate-capped worker-PII reveal (default-OFF flag). The
    // reveal repo is SELECT-ONLY on `workers` (encrypted phone) — never touches `events`. The
    // cap service reuses the BullMQ Redis client (fail-closed per-admin hour+day caps).
    AdminPiiRevealRepository,
    AdminPiiRevealCapService,
    AdminPiiRevealService,
    // ADMIN-3c: kill-switch surface — read-only DISPLAY + safe-direction PAUSE INTENT only. Reads
    // existing server-config gates; emits a value-free `admin.kill_switch_pause_requested`. It NEVER
    // enables a provider (enabling stays env/deploy-gated, §2 #5) — there is no enable code path.
    AdminKillSwitchService,
    // Owner ruling 2026-08-18 (reversing ADR-0025 Decision 4): the NAME layer shared by the
    // entity reads and the admin directory. `read_identity` (super_admin/ops_admin/support;
    // analyst DENIED) is checked INSIDE the service rather than by a second decorator, because
    // the routes must stay reachable on `read_entities` for every role — names are ADDITIVE.
    // Its repository is the ONE place under admin/** that projects a name column, so the
    // faceless projections next to it stay provably faceless. Its cap is a SEPARATE
    // `admin_identity:*` budget on the shared `AdminEgressCapService` — a list of names is a
    // bulk disclosure the single-subject reveal cap structurally cannot see, so without it the
    // reveal cap is bypassed by paging. Emits `admin.identity_viewed` (awaited, fail-closed,
    // BEFORE any decrypt) and the PII-free `admin.identity_cap_exceeded` breach — hence
    // EventsService, and PiiCryptoService for the decrypt-at-boundary.
    AdminIdentityRepository,
    AdminIdentityCapService,
    AdminIdentityService,
    // BP-1: entity reads (workers/payers/job-postings/applications/credits) behind
    // `read_entities`. SELECT-ONLY, explicit column projections, keyset-paginated. It does NOT
    // widen InternalServiceGuard and does not touch the existing ops read routes. Names on the
    // worker/payer reads come from AdminIdentityService above, never from this repository.
    AdminEntitiesRepository,
    AdminEntitiesService,
    // BP-2: finance reads (credit position, platform-wide ledger, payment orders) behind
    // `read_entities`. SELECT-ONLY. Every money-bearing response carries the payments
    // posture, so a mock rupee can never be read as a real one.
    AdminFinanceRepository,
    AdminFinanceService,
    // BP-3: the admin directory (`manage_admins`, super_admin only) + the role→capability
    // matrix (`read_entities`), served so the portal carries no second copy of the
    // authorization table. Its OWN repository is SELECT-ONLY and still projects no
    // email/name/mfa_secret; the `name` column comes from AdminIdentityService, gated on
    // `read_identity` rather than on the route's `manage_admins` — one capability, one meaning.
    AdminDirectoryRepository,
    AdminDirectoryService,
    // BP-5: the dashboard summary (platform AI spend by provider/task/breach-reason + volume
    // counts) behind `read_entities`, the same capability the finance aggregates declare.
    // SELECT-ONLY, with its OWN read-only repository over `platform_ai_cost_totals` —
    // `AiCostTotalsRepository` is the single WRITER of that table and stays unexported from
    // `AiModule`. The cap-breach split reuses `AdminEventsRepository` so `events` keeps exactly
    // one admin reader (build-blocked in `admin-static-guards.test.ts`).
    AdminDashboardRepository,
    AdminDashboardService,
    // Phase 6: the per-worker JOURNEY — the 7-step funnel plus the interview session reads
    // (list + detail, with the derived stuck question). Behind `read_entities`, SELECT-ONLY,
    // explicit column projections, keyset-paginated. It returns NO transcript text of any
    // kind: `chat_messages.body_text` and `voice_notes.transcript_text` are stored unmasked
    // and are deliberately outside this surface's projection (see the DTO header).
    // It is the ONE read service here that emits: `admin.worker_journey_viewed` (PII-free,
    // awaited, fail-closed) on both per-worker reads, because the journey is a behavioural
    // profile rather than an entity snapshot — hence EventsService in its constructor.
    //
    // Its event-spine reads live on `AdminEventsRepository`, not on its own repository, for
    // the same single-reader reason BP-5's cap-breach split does.
    AdminWorkerJourneyRepository,
    AdminWorkerJourneyService,
    // #997: the worker-FEEDBACK read (`read_entities`). SELECT-ONLY, keyset-paginated, and the
    // ONE non-faceless read on this surface — it projects `message`, the worker's own free text.
    // Deliberately its own module rather than a ninth entity read, so the faceless contract
    // stays absolute in the file that declares it. No name/phone, no join to `workers`, and no
    // search over the message body — narrowing by `workerId` is a LOOKUP, not a search.
    //
    // The SECOND read service here that emits: `admin.feedback_viewed` (ADR-0025 Amendment 1),
    // awaited and fail-closed, so reading a worker's WORDS leaves the same kind of trail as
    // reading their step counts — hence EventsService in its constructor too.
    AdminFeedbackRepository,
    AdminFeedbackService,
    // Migration 0083: the AI CALL TRACE read — two routes at two privilege levels over one
    // table. The LIST is PII-free (`read_entities`): task type, model, success, and the two
    // LENGTHS, so ops can answer "which calls are failing" without reading anyone's words.
    // The DETAIL DECRYPTS, and is the narrowest surface in this module: `read_ai_traces`
    // (super_admin ONLY) + the default-OFF `ADMIN_AI_TRACE_READ_ENABLED` flag (a NEUTRAL 404
    // when off, never a 403) + its OWN `admin_ai_trace:*` egress budget on the shared
    // `AdminEgressCapService` + a fail-closed `admin.ai_trace_viewed` audit row that must
    // commit BEFORE any plaintext exists — hence EventsService and PiiCryptoService.
    //
    // Its repository is SELECT-ONLY and is NOT `AiTracesRepository`: that class can insert,
    // and it stays unexported from the @Global `AiModule` so no class capable of writing a
    // trace enters this injector — the same rule that keeps `AiCostTotalsRepository` out, and
    // the same FeedbackRepository/AdminFeedbackRepository split.
    AdminAiTracesRepository,
    AdminAiTraceCapService,
    AdminAiTracesService,
  ],
  exports: [AdminAuthGuard, AdminRolesGuard, AdminSessionService, AdminRepository],
})
export class AdminModule {}
