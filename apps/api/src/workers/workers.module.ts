import { Global, Module } from "@nestjs/common";
import { WorkersRepository } from "./workers.repository";
import { WorkersService } from "./workers.service";
import { WorkersController } from "./workers.controller";

/** Global: worker identity is needed by auth, consent, chat, profiles, etc. */
@Global()
@Module({
  controllers: [WorkersController],
  providers: [WorkersRepository, WorkersService],
  exports: [WorkersRepository],
})
export class WorkersModule {}
