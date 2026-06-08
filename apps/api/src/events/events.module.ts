import { Global, Module } from "@nestjs/common";
import { EventsRepository } from "./events.repository";
import { EventsService } from "./events.service";

/** Global so any feature module can emit events without re-importing. */
@Global()
@Module({
  providers: [EventsRepository, EventsService],
  exports: [EventsService],
})
export class EventsModule {}
