import { Global, Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { RESUME_RENDER_QUEUE } from "../../queue/queue.constants";
import { IpRateLimit } from "./ip-rate-limit.service";
import { SubjectRateLimit } from "./subject-rate-limit.service";

/**
 * Shared rate limiting (TD24). Global so any controller (resume download,
 * interview-kit download, the worker action sink) can inject a limiter without
 * re-wiring. Reuses the existing BullMQ Redis connection (registers
 * RESUME_RENDER_QUEUE only to obtain that client — no second connection).
 * PiiCryptoService comes from the @Global CryptoModule.
 *
 * TWO LIMITERS, split by what they are keyed on rather than by caller:
 * {@link IpRateLimit} for the anonymous per-IP case (hashes its input, because an
 * IP is PII), {@link SubjectRateLimit} for an already-authenticated principal
 * (opaque internal id, and a `cost` so a batch route can be capped on records
 * rather than on requests). Adding a third copy of the INCR/EXPIRE counter inside
 * a feature module is what this module exists to prevent.
 */
@Global()
@Module({
  imports: [BullModule.registerQueue({ name: RESUME_RENDER_QUEUE })],
  providers: [IpRateLimit, SubjectRateLimit],
  exports: [IpRateLimit, SubjectRateLimit],
})
export class RateLimitModule {}
