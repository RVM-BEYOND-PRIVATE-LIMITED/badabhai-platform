import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { JwtModule } from "@nestjs/jwt";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";
import { DatabaseModule } from "../database/database.module";
import { EventsModule } from "../events/events.module";
import { AdminRepository } from "./admin.repository";
import { AdminSessionService } from "./admin-session.service";
import { AdminOtpService } from "./admin-otp.service";
import { AdminMfaSecretStore } from "./admin-mfa.store";
import { AdminAuthGuard } from "./admin-auth.guard";
import { AdminRolesGuard } from "./admin-roles.guard";
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
 * response (never logged/cached/persisted/evented). The kill-switch is ADMIN-3c. OBS-4 (migrating the existing
 * ops read routes behind a dual-accept guard) is DEFERRED — this module does NOT touch the
 * existing ops/InternalService routes or `apps/web`. SSE live-tail is DEFERRED to ADMIN-7.
 */
@Module({
  imports: [
    DatabaseModule,
    EventsModule,
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
  ],
  providers: [
    AdminRepository,
    AdminSessionService,
    AdminOtpService,
    AdminMfaSecretStore,
    AdminAuthService,
    AdminAuthGuard,
    AdminRolesGuard,
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
  ],
  exports: [AdminAuthGuard, AdminRolesGuard, AdminSessionService, AdminRepository],
})
export class AdminModule {}
