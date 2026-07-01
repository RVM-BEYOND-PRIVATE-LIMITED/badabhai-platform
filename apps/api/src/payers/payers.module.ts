import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { JwtModule } from "@nestjs/jwt";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";
import { DatabaseModule } from "../database/database.module";
import { PayersRepository } from "./payers.repository";
import { PayerOrgsRepository } from "./payer-orgs.repository";
import { PayerSessionService } from "./payer-session.service";
import { PayerAuthGuard } from "./payer-auth.guard";
import { PayerRoleGuard } from "./payer-role.guard";
import { PayerOrgRoleGuard } from "./payer-org-role.guard";
import { PayerAccountService } from "./payer-account.service";
import { PayerAccountController } from "./payer-account.controller";

/**
 * Payer portal — IDENTITY + TENANCY FOUNDATION (ADR-0019 Phase 1, mock/staging-only).
 *
 * Provides the `payers` data access (PII at rest), the payer session mechanism, and
 * `PayerAuthGuard`. Slice 1 (ADR-0019 LC-1) adds the FIRST payer-authenticated route
 * group — `PayerAccountController` (`GET /payer/me`) under `PayerAuthGuard` — so the
 * `apps/payer-web` portals can swap their mock session onto a real authed endpoint.
 * This module is now imported into `AppModule`. `PiiCryptoService` (CryptoModule) and
 * `SERVER_CONFIG` are @Global. The tenant-isolation chokepoint lives in
 * `payer-scope.ts` (pure helpers, no DI).
 *
 * ADR-0022 (Agency Supply Portal): exports `PayerRoleGuard` — the VERTICAL-authz primitive
 * the upcoming agency controllers pair with `PayerAuthGuard` to gate agent-only routes
 * (`@UseGuards(PayerAuthGuard, PayerRoleGuard)` + `@PayerRoles("agent")`). It is NOT applied
 * to any existing route here (additive, no regression). `Reflector` is provided by Nest core.
 */
@Module({
  imports: [
    DatabaseModule,
    // Reuse BullMQ's Redis connection for the payer session store (client only).
    BullModule.registerQueue({ name: RESUME_RENDER_QUEUE }),
    JwtModule.registerAsync({
      inject: [SERVER_CONFIG],
      useFactory: (config: ServerConfig) => ({
        secret: config.JWT_SECRET,
        signOptions: { algorithm: "HS256" },
      }),
    }),
  ],
  controllers: [PayerAccountController],
  providers: [
    PayersRepository,
    PayerOrgsRepository,
    PayerSessionService,
    PayerAuthGuard,
    PayerRoleGuard,
    PayerOrgRoleGuard,
    PayerAccountService,
  ],
  exports: [
    PayersRepository,
    PayerOrgsRepository,
    PayerSessionService,
    PayerAuthGuard,
    PayerRoleGuard,
    PayerOrgRoleGuard,
  ],
})
export class PayersModule {}
