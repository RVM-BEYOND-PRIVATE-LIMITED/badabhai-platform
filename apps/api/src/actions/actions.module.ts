import { Module } from "@nestjs/common";
import { ActionsController } from "./actions.controller";
import { WorkerActionsController } from "./worker-actions.controller";
import { ActionsService } from "./actions.service";

/**
 * Action recording, on two front doors over ONE service.
 *
 * `ActionsController` is the service-to-service route (`InternalServiceGuard`);
 * `WorkerActionsController` is the worker's own (`WorkerAuthGuard` + `ConsentGuard`)
 * — separate classes because Nest unions class-level guards, see that file's header.
 *
 * STILL NO IMPORTS. WorkersRepository, EventsService, SERVER_CONFIG and
 * SubjectRateLimit are all provided by @Global modules, so adding the worker
 * surface did not add a module edge.
 */
@Module({
  controllers: [ActionsController, WorkerActionsController],
  providers: [ActionsService],
})
export class ActionsModule {}
