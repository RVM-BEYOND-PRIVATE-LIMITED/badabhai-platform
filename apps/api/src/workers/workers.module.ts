import { Global, Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { WorkersRepository } from "./workers.repository";
import { WorkersService } from "./workers.service";
import { WorkersController } from "./workers.controller";

/** Global: worker identity is needed by auth, consent, chat, profiles, etc. */
@Global()
@Module({
  // AuthModule provides WorkerAuthGuard + ConsentGuard (+ their deps) for the
  // consent-gated PATCH /workers/me/name route. AuthModule does NOT import
  // WorkersModule (it reaches WorkersRepository via this @Global export), so
  // there is no cycle.
  imports: [AuthModule],
  controllers: [WorkersController],
  providers: [WorkersRepository, WorkersService],
  exports: [WorkersRepository],
})
export class WorkersModule {}
