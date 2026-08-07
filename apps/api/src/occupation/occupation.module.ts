/**
 * Occupation Intelligence — the retrieval half of the deterministic profiling engine.
 *
 * `OccupationService` is exported because the orchestrator calls it IN-PROCESS. The
 * controller exists for the ai-service and ops tooling; the chat path must not pay an HTTP
 * hop for a lookup the same process can answer from memory in two milliseconds.
 *
 * Imports `SkillsModule` for two things it deliberately does not reimplement: the ANN query
 * behind layer L3 (`SkillsRepository.nearestDomains`, which already owns the ANN-first CTE
 * and its EXPLAIN-plan test) and `SkillsInternalGuard`'s scoped credential.
 */
import { Module } from "@nestjs/common";

import { ProfilingModule } from "../profiling/profiling.module";
import { SkillsModule } from "../skills/skills.module";
import { OccupationController } from "./occupation.controller";
import { OccupationIndexService } from "./occupation-index.service";
import { OccupationRepository } from "./occupation.repository";
import { OccupationService } from "./occupation.service";

@Module({
  // `ProfilingModule` for `PackRegistryService` — the pack fallback chain and version pinning,
  // reused rather than reimplemented behind the question-pack route.
  imports: [SkillsModule, ProfilingModule],
  controllers: [OccupationController],
  providers: [OccupationIndexService, OccupationRepository, OccupationService],
  exports: [OccupationService, OccupationIndexService],
})
export class OccupationModule {}
