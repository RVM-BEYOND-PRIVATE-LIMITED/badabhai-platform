import { Global, Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { RESUME_RENDER_QUEUE } from "../../queue/queue.constants";
import { IpRateLimit } from "./ip-rate-limit.service";

/**
 * Shared per-IP rate limiting (TD24). Global so any controller (resume download,
 * interview-kit download) can inject {@link IpRateLimit} without re-wiring. Reuses
 * the existing BullMQ Redis connection (registers RESUME_RENDER_QUEUE only to
 * obtain that client — no second connection). PiiCryptoService comes from the
 * @Global CryptoModule.
 */
@Global()
@Module({
  imports: [BullModule.registerQueue({ name: RESUME_RENDER_QUEUE })],
  providers: [IpRateLimit],
  exports: [IpRateLimit],
})
export class RateLimitModule {}
