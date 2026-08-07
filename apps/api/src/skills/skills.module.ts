import { Module } from "@nestjs/common";
import { SkillsController } from "./skills.controller";
import { SkillsService } from "./skills.service";
import { SkillsRepository } from "./skills.repository";
import { SkillsInternalGuard } from "./skills-internal.guard";

/**
 * Skill-canonicalization support module (ADR-0030 / FORK-B-1 seam A): the INTERNAL
 * nearest-alias ANN lookup + unresolved-phrase upsert the (DB-free) ai-service calls.
 * EventsService comes from the @Global() EventsModule; DATABASE from the global
 * database module. SkillsInternalGuard (SCOPED token) reads SERVER_CONFIG (global).
 */
@Module({
  controllers: [SkillsController],
  providers: [SkillsService, SkillsRepository, SkillsInternalGuard],
  // The extraction processor re-validates the RAG-matched `job_domain_id` against the
  // catalog before persisting it. That check has to run on the api's owner connection
  // (same reason the lookups above do), and this repository already owns those queries.
  // `OccupationModule` reuses BOTH of these rather than minting parallels: the repository
  // owns layer L3's ANN query (and its EXPLAIN-plan test), and the guard is the same scoped
  // credential for the same principal reading the same public catalogue.
  exports: [SkillsRepository, SkillsInternalGuard],
})
export class SkillsModule {}
