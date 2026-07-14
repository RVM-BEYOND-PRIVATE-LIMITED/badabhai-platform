import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { InternalServiceGuard } from "../common/guards/internal-service.guard";
import { SkillsService } from "./skills.service";
import {
  NearestAliasesDtoSchema,
  type NearestAliasesDto,
  RecordUnresolvedDtoSchema,
  type RecordUnresolvedDto,
} from "./skills.dto";

/**
 * INTERNAL skill-canonicalization routes (ADR-0030 / FORK-B-1 seam A) — the DB half of
 * the request path. The (DB-free) ai-service `HttpSkillStore` is the only caller:
 * `skill_alias`/`unresolved_phrase` are RLS-locked + REVOKE'd, so the authorized reads/
 * writes live here on the api's owner connection.
 *
 * InternalServiceGuard (shared secret, FAIL CLOSED when unconfigured): these are
 * service-to-service routes — no user principal, no worker identity anywhere in them.
 */
@Controller("internal/skills")
@UseGuards(InternalServiceGuard)
export class SkillsController {
  constructor(private readonly skills: SkillsService) {}

  /** Domain-scoped nearest-alias ANN lookup. Read-only — no event. */
  @Post("nearest-aliases")
  @HttpCode(200)
  async nearestAliases(
    @Body(new ZodValidationPipe(NearestAliasesDtoSchema)) dto: NearestAliasesDto,
  ) {
    const candidates = await this.skills.nearestAliases(dto.domain_id, dto.vector, dto.k);
    return { candidates };
  }

  /** Upsert one below-floor miss (phrase ALREADY pseudonymized) + emit the hash-only event. */
  @Post("unresolved")
  @HttpCode(204)
  async recordUnresolved(
    @Body(new ZodValidationPipe(RecordUnresolvedDtoSchema)) dto: RecordUnresolvedDto,
  ): Promise<void> {
    await this.skills.recordUnresolved(dto.phrase, dto.domain_id, dto.lang);
  }
}
