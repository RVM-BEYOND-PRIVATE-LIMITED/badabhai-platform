import { Module } from "@nestjs/common";
import { SkillsController } from "./skills.controller";
import { SkillsService } from "./skills.service";
import { SkillsRepository } from "./skills.repository";

/**
 * Skill-canonicalization support module (ADR-0030 / FORK-B-1 seam A): the INTERNAL
 * nearest-alias ANN lookup + unresolved-phrase upsert the (DB-free) ai-service calls.
 * EventsService comes from the @Global() EventsModule; DATABASE from the global
 * database module. InternalServiceGuard reads SERVER_CONFIG (global config module).
 */
@Module({
  controllers: [SkillsController],
  providers: [SkillsService, SkillsRepository],
})
export class SkillsModule {}
