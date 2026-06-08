import { Global, Module } from "@nestjs/common";
import { EventsRepository } from "./events.repository";
import { EventsService } from "./events.service";
import { EventsController } from "./events.controller";

/** Global so any feature module can emit events without re-importing. */
@Global()
@Module({
  controllers: [EventsController],
  providers: [EventsRepository, EventsService],
  exports: [EventsService],
})
export class EventsModule {}
