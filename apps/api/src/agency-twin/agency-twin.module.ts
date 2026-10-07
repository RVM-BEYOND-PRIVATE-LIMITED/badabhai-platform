import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { AGENCY_TWIN_SYNC_QUEUE } from "../queue/queue.constants";
import { AgencyTwinRepository } from "./agency-twin.repository";
import { AgencyTwinService } from "./agency-twin.service";
import { AgencyTwinSyncProcessor } from "./agency-twin-sync.processor";

/**
 * ADR-0050 (#1957) — the agency-job V1 twin sync. A LEAF module: nothing imports it, and it
 * imports nothing from the agency module (C3 — the agency service is not changed to call it; it
 * reads the committed `jobs` row and the `job.*` events the agency service already emits).
 *
 * Global deps: DATABASE, SERVER_CONFIG, EventsService, MatchConfigService (MatchModule is
 * @Global). The queue is registered here because the processor lives here.
 */
@Module({
  imports: [BullModule.registerQueue({ name: AGENCY_TWIN_SYNC_QUEUE })],
  providers: [AgencyTwinRepository, AgencyTwinService, AgencyTwinSyncProcessor],
})
export class AgencyTwinModule {}
