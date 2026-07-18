import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { JwtModule } from "@nestjs/jwt";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { ACCOUNT_DELETION_QUEUE, RESUME_RENDER_QUEUE } from "../queue/queue.constants";
import { SmsModule } from "../sms/sms.module";
import { ConsentModule } from "../consent/consent.module";
import { PushQueueModule } from "../push/push-queue.module";
import { StorageModule } from "../storage/storage.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { OtpService } from "./otp.service";
import { SessionService } from "./session.service";
import { AccountDeletionService } from "./account-deletion.service";
import { AccountDeletionSweepProcessor } from "./account-deletion-sweep.processor";
import { WorkerAuthGuard } from "./worker-auth.guard";
import { ConsentGuard, ConsentNotRevokedGuard } from "./consent.guard";
import { TestLoginGuard } from "./test-login.guard";
import { DevicesController } from "./devices.controller";
import { DevicesService } from "./devices.service";
import { DevicesRepository } from "./devices.repository";
import { PinController } from "./pin.controller";
import { PinService } from "./pin.service";
import { PinRepository } from "./pin.repository";
import { PinHasher } from "./pin-hasher.service";

@Module({
  imports: [
    SmsModule,
    // ConsentGuard reads the worker's latest consent via ConsentRepository.
    // ConsentModule does NOT import AuthModule, so there is no cycle.
    ConsentModule,
    // ADR-0026 Phase 5 — AccountDeletionService erases resume PDFs + archived conversations
    // via StorageService (service-role Storage). StorageModule does NOT import AuthModule, so
    // there is no cycle. WorkersRepository + EventsService + PiiCryptoService are @Global.
    StorageModule,
    // Reuse BullMQ's existing Redis connection for OTP + session keys (registers
    // the queue only to obtain its client — no second connection), exactly like
    // RateLimitModule does.
    BullModule.registerQueue({ name: RESUME_RENDER_QUEUE }),
    // ADR-0031 — the deletion-grace sweep queue (repeatable tick; DB marker authoritative).
    BullModule.registerQueue({ name: ACCOUNT_DELETION_QUEUE }),
    // ADR-0034 — PRODUCER-only push wiring (the queue + PushEnqueuer). Deliberately NOT
    // PushModule: the push PROCESSOR needs this module's device data, so importing the
    // full module here would be a cycle. This one knows only the queue, so the
    // dependency runs one way (auth -> push-queue, push -> auth).
    PushQueueModule,
    // Sign worker session tokens with JWT_SECRET from validated server config.
    // Pin the algorithm to HS256 (defense-in-depth): never accept a token signed
    // with a different/`none` alg, so a future asymmetric-key change can't open an
    // alg-confusion downgrade. Verification pins the allow-list too (session.service).
    JwtModule.registerAsync({
      inject: [SERVER_CONFIG],
      useFactory: (config: ServerConfig) => ({
        secret: config.JWT_SECRET,
        signOptions: { algorithm: "HS256" },
      }),
    }),
  ],
  controllers: [AuthController, DevicesController, PinController],
  // IpRateLimit is @Global (RateLimitModule) — do not re-provide it. DevicesRepository
  // reaches the @Global DATABASE token; DevicesService composes EventsService/PiiCrypto/
  // SessionService (all reachable here), and AuthService depends on DevicesService.
  // ADR-0026 Phase 3 (device-bound PIN): PinRepository reaches @Global DATABASE; PinHasher
  // composes PiiCryptoService; PinService composes SessionService/DevicesRepository/OtpService/
  // AuthService/EventsService/PiiCryptoService + the @Global WorkersRepository + the BullMQ
  // queue (the same Redis client SessionService uses) — all reachable in this module.
  providers: [
    AuthService,
    OtpService,
    SessionService,
    AccountDeletionService,
    AccountDeletionSweepProcessor,
    WorkerAuthGuard,
    ConsentGuard,
    ConsentNotRevokedGuard,
    // D-3 — gates POST /auth/test-login (neutral 404 while TEST_LOGIN_ENABLED is
    // off; prod-armed = boot failure via assertAuthConfig). SERVER_CONFIG is @Global.
    TestLoginGuard,
    DevicesService,
    DevicesRepository,
    PinService,
    PinRepository,
    PinHasher,
  ],
  // Export the guards AND their dependencies. When another module applies a guard
  // via @UseGuards, Nest resolves the guard's ctor deps in the IMPORTING module's
  // injector — so each dep must be reachable there, else it resolves to null and
  // the app fails to BOOT (caught by the boot test, not the plain unit tests).
  // SERVER_CONFIG is @Global. SessionService (this module) backs WorkerAuthGuard.
  // ConsentGuard depends on ConsentRepository, which lives in ConsentModule — a
  // module can only re-export a provider it OWNS, so we re-export the MODULE
  // (ConsentModule), which propagates its own export (ConsentRepository) onward.
  // DevicesRepository is exported for PushModule (ADR-0034), which imports AuthModule to
  // reach it for token invalidation. Providing it is NOT enough — a provider is private to
  // its module unless exported, so without this line PushService's 4th ctor param resolves
  // to null and the API fails to BOOT (exactly the failure this comment block warns about;
  // it took down the E2E run for #417 while every unit suite stayed green).
  exports: [WorkerAuthGuard, ConsentGuard, SessionService, ConsentModule, DevicesRepository],
})
export class AuthModule {}
