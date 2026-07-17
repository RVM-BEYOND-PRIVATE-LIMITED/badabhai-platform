import { Global, Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { AuthModule } from "../auth/auth.module";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";
import { RateLimitModule } from "../common/rate-limit/rate-limit.module";
import { StorageModule } from "../storage/storage.module";
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
  // upload/read URLs into the private WORKER_PHOTOS_BUCKET).
  // ADR-0032 A1: the photo/show_photo change points enqueue a resume re-render on
  // the EXISTING render queue (the same seam ResumeService uses). Registering the
  // queue here — as AuthModule and RateLimitModule already do — keeps WorkersModule
  // free of any ResumeModule import, so no cycle is created.
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
