import { Global, Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { AuthModule } from "../auth/auth.module";
import { RateLimitModule } from "../common/rate-limit/rate-limit.module";
import { StorageModule } from "../storage/storage.module";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";
import { WorkersRepository } from "./workers.repository";
import { WorkersService } from "./workers.service";
import { WorkersController } from "./workers.controller";

/** Global: worker identity is needed by auth, consent, chat, profiles, etc. */
@Global()
@Module({
  // AuthModule provides WorkerAuthGuard + ConsentGuard (+ their deps) for the
  // consent-gated PATCH /workers/me/name route. AuthModule does NOT import
  // WorkersModule (it reaches WorkersRepository via this @Global export), so
  // there is no cycle. StorageModule powers the ADR-0032 photo seam (signed
  // upload/read URLs into the private WORKER_PHOTOS_BUCKET). The render queue is
  // registered here so a photo/show_photo change can enqueue the TD77 forced
  // re-render that puts the photo onto the worker's existing resume PDF (produce
  // only — the processor itself lives in ResumeModule, so there is no cycle).
  imports: [
    AuthModule,
    StorageModule,
    RateLimitModule,
    BullModule.registerQueue({ name: RESUME_RENDER_QUEUE }),
  ],
  controllers: [WorkersController],
  providers: [WorkersRepository, WorkersService],
  exports: [WorkersRepository],
})
export class WorkersModule {}
