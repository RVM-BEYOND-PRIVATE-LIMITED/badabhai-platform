import { Module } from "@nestjs/common";
import { ActionsController } from "./actions.controller";
import { ActionsService } from "./actions.service";

/**
 * Action recording. WorkersRepository (global) and EventsService (global) are
 * the only deps, so no imports are needed.
 */
@Module({
  controllers: [ActionsController],
  providers: [ActionsService],
})
export class ActionsModule {}
