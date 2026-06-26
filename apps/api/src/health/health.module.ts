import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";

@Module({
  imports: [
    // Reuse BullMQ's existing Redis connection for the readiness PING (registers
    // the queue only to obtain its client — no second connection), exactly like
    // AuthModule does for the OTP flow. The DATABASE token comes from the @Global
    // DatabaseModule, so it needs no explicit import here.
    BullModule.registerQueue({ name: RESUME_RENDER_QUEUE }),
  ],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
