import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { JwtModule } from "@nestjs/jwt";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";
import { DatabaseModule } from "../database/database.module";
import { PayersRepository } from "./payers.repository";
import { PayerSessionService } from "./payer-session.service";
import { PayerAuthGuard } from "./payer-auth.guard";
import { PayerDisclosureRateLimit } from "./payer-disclosure-rate-limit.service";

/**
 * Payer portal — IDENTITY + TENANCY FOUNDATION (ADR-0019 Phase 1, mock/staging-only).
 *
 * Provides the `payers` data access (PII at rest), the payer session mechanism,
 * `PayerAuthGuard`, and the per-payer disclosure/reach rate cap
 * ({@link PayerDisclosureRateLimit}, XB-G). Imported by the payer-portal route group
 * (signup/login/reach) AND by `UnlocksModule` (the retrofitted self-serve `/unlocks`
 * surface binds those routes to `PayerAuthGuard` + the XB-G cap, R16 / LC-1).
 * `PiiCryptoService` (CryptoModule) and `SERVER_CONFIG` are @Global. The tenant-
 * isolation chokepoint lives in `payer-scope.ts` (pure helpers, no DI).
 */
@Module({
  imports: [
    DatabaseModule,
    // Reuse BullMQ's Redis connection for the payer session store + the XB-G rate cap
    // (client only).
    BullModule.registerQueue({ name: RESUME_RENDER_QUEUE }),
    JwtModule.registerAsync({
      inject: [SERVER_CONFIG],
      useFactory: (config: ServerConfig) => ({
        secret: config.JWT_SECRET,
        signOptions: { algorithm: "HS256" },
      }),
    }),
  ],
  providers: [PayersRepository, PayerSessionService, PayerAuthGuard, PayerDisclosureRateLimit],
  exports: [PayersRepository, PayerSessionService, PayerAuthGuard, PayerDisclosureRateLimit],
})
export class PayersModule {}
