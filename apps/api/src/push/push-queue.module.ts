import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { PUSH_QUEUE } from "../queue/queue.constants";
import { PushEnqueuer } from "./push-enqueuer.service";

/**
 * PRODUCER-ONLY push wiring (ADR-0034).
 *
 * Split from {@link PushModule} on purpose. The producers are in the auth domain and
 * the consumer needs auth's device data, so a single push module would force
 * auth → push → auth. This module knows ONLY the queue, so `AuthModule` can import it
 * freely, while `PushModule` (processor + provider + repository) imports `AuthModule`.
 * The dependency runs one way: auth → push-queue, push → auth.
 */
@Module({
  imports: [BullModule.registerQueue({ name: PUSH_QUEUE })],
  providers: [PushEnqueuer],
  exports: [PushEnqueuer, BullModule],
})
export class PushQueueModule {}
