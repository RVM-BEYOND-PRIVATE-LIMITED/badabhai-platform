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
 * SCOPE NOTE (ADR-0025): ADMIN-1 is auth + RBAC + MFA only. The capability-gated FEATURE
 * routes (events query, entity actions, PII reveal) are ADMIN-2/ADMIN-3. OBS-4 (migrating the
 * existing ops read routes behind a dual-accept guard) is DEFERRED — this module does NOT
 * touch the existing ops/InternalService routes or `apps/web`.
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
  controllers: [AdminAuthController],
  providers: [
    AdminRepository,
    AdminSessionService,
    AdminOtpService,
    AdminMfaSecretStore,
    AdminAuthService,
    AdminAuthGuard,
    AdminRolesGuard,
  ],
  exports: [AdminAuthGuard, AdminRolesGuard, AdminSessionService, AdminRepository],
})
export class AdminModule {}
