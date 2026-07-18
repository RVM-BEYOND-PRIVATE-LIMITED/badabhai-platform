import { Module } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { areRealPushesEnabled } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { AuthModule } from "../auth/auth.module";
import { PushQueueModule } from "./push-queue.module";
import { PushRepository } from "./push.repository";
import { PushService } from "./push.service";
import { PushProcessor } from "./push.processor";
import { FcmPushProvider } from "./fcm-push.provider";
import { MockPushProvider, PUSH_PROVIDER } from "./push.provider";

/**
 * The CONSUMER half of worker push (ADR-0034): provider + service + queue processor.
 *
 * Imports `AuthModule` for `DevicesRepository` (token invalidation). That is cycle-free
 * because auth imports only {@link PushQueueModule} — the producer-only half — never
 * this module. Dependency runs one way: auth → push-queue, push → auth.
 */
@Module({
  imports: [AuthModule, PushQueueModule],
  providers: [
    PushRepository,
    PushService,
    PushProcessor,
    FcmPushProvider,
    MockPushProvider,
    {
      // FAIL-SAFE BY DEFAULT: the real provider is bound ONLY when PUSH_ENABLE_REAL is
      // true AND the credential + project id are present (areRealPushesEnabled). In
      // every other state the mock is bound and nothing leaves the process — so an
      // unconfigured or half-configured deploy cannot send, and `assertPushConfig`
      // has already failed the boot if the flag was on without a credential.
      provide: PUSH_PROVIDER,
      inject: [SERVER_CONFIG, FcmPushProvider, MockPushProvider],
      useFactory: (config: ServerConfig, real: FcmPushProvider, mock: MockPushProvider) =>
        areRealPushesEnabled(config) ? real : mock,
    },
  ],
  exports: [PushService],
})
export class PushModule {}
