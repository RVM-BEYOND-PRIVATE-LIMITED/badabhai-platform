import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { JwtModule } from "@nestjs/jwt";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";
import { SmsModule } from "../sms/sms.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { OtpService } from "./otp.service";
import { SessionService } from "./session.service";
import { WorkerAuthGuard } from "./worker-auth.guard";

@Module({
  imports: [
    SmsModule,
    // Reuse BullMQ's existing Redis connection for OTP + session keys (registers
    // the queue only to obtain its client — no second connection), exactly like
    // RateLimitModule does.
    BullModule.registerQueue({ name: RESUME_RENDER_QUEUE }),
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
  controllers: [AuthController],
  // IpRateLimit is @Global (RateLimitModule) — do not re-provide it.
  providers: [AuthService, OtpService, SessionService, WorkerAuthGuard],
  // Export the guard AND its SessionService dependency. When another module
  // (ResumeModule) applies WorkerAuthGuard via @UseGuards, Nest resolves the
  // guard's ctor deps in the importing module's injector — so SessionService must
  // be exported too, else its index-0 dep resolves to null and the app fails to
  // boot (caught by the e2e, not unit tests). SERVER_CONFIG is @Global.
  exports: [WorkerAuthGuard, SessionService],
})
export class AuthModule {}
