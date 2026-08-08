import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
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
 * ONE IMPORT, AND IT IS THE GUARDS'. `AuthModule` supplies `WorkerAuthGuard` and
 * `ConsentGuard` together with THEIR OWN deps — `SessionService` and
 * `ConsentRepository` — which is the part that is easy to miss: a guard class is
 * resolved in the importing module's injector, so referencing it in `@UseGuards`
 * without this import is a BOOT-TIME failure ("dependencies: [null, SERVER_CONFIG,
 * null]") that no unit test constructing the controller by hand can see. Every other
 * module with a `/workers/me/*` route imports it for the same reason.
 *
 * Nothing else was needed: WorkersRepository, EventsService, SERVER_CONFIG and
 * SubjectRateLimit all come from @Global modules.
 */
@Module({
  imports: [AuthModule],
  controllers: [ActionsController, WorkerActionsController],
  providers: [ActionsService],
})
export class ActionsModule {}
