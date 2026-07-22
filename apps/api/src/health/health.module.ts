import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { ACCOUNT_DELETION_QUEUE, RESUME_RENDER_QUEUE } from "../queue/queue.constants";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";

@Module({
  imports: [
    // Reuse BullMQ's existing Redis connection for the readiness PING (registers
    // the queue only to obtain its client — no second connection), exactly like
    // AuthModule does for the OTP flow. The DATABASE token comes from the @Global
    // DatabaseModule, so it needs no explicit import here.
    BullModule.registerQueue({ name: RESUME_RENDER_QUEUE }),
    // ADR-0031 — same idiom: registered ONLY so the readiness probe can look up the
    // deletion-sweep job scheduler. Registration is idempotent and shares the one
    // Redis connection; this module neither produces nor consumes these jobs.
    BullModule.registerQueue({ name: ACCOUNT_DELETION_QUEUE }),
    // TD81 — HealthService's FOURTH dependency, `AiService`, needs NO import here:
    // AiModule is @Global (ai.module.ts) and is imported once by AppModule, exactly
    // like the DATABASE token above. Importing it again would be redundant, and
    // re-declaring AiService as a provider here would be actively wrong — it would
    // mint a SECOND instance with its own opening cache alongside the one chat and
    // resume already share.
  ],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
