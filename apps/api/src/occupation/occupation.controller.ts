/**
 * INTERNAL occupation-retrieval routes.
 *
 * RIDES `SkillsInternalGuard`, NOT A NEW CREDENTIAL. Same principal (the ai-service and ops
 * tooling), same class of read (a lookup over a PUBLIC reference catalogue that contains no
 * worker data), and the guard already fails closed when its secret is unconfigured. Minting
 * a second scoped token for the same principal reading the same catalogue would add
 * ceremony without narrowing anything — the argument `skills.controller.ts` already makes
 * for its own second route.
 *
 * THE ORCHESTRATOR DOES NOT USE THESE ROUTES. It calls `OccupationService` in-process, in
 * the same Nest app. These exist for the ai-service, ops tooling and testability; putting
 * an HTTP hop on the chat hot path would spend the latency the ladder exists to save.
 */
import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, UseGuards } from "@nestjs/common";

import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { SkillsInternalGuard } from "../skills/skills-internal.guard";
import { ResolveOccupationDtoSchema, type ResolveOccupationDto } from "./occupation.dto";
import { OccupationService } from "./occupation.service";

@Controller("internal/occupation")
@UseGuards(SkillsInternalGuard)
export class OccupationController {
  constructor(private readonly occupation: OccupationService) {}

  /**
   * Resolve an occupation from a worker's words. Read-only — no event.
   *
   * `status: "degraded"` is a REAL, DISTINCT outcome and callers must treat it as one: it
   * means the index has never built, not that the phrase is unknown. Recording a degraded
   * answer as an unresolved phrase would poison the growth loop with trades the catalogue
   * already knows.
   */
  @Post("resolve")
  @HttpCode(200)
  async resolve(
    @Body(new ZodValidationPipe(ResolveOccupationDtoSchema)) dto: ResolveOccupationDto,
  ) {
    const result = await this.occupation.resolve(dto.text, {
      vector: dto.vector,
      allowVector: dto.allow_vector,
    });
    return {
      status: result.status,
      catalog_version: result.catalogVersion,
      pinned: result.pinned,
      candidates: result.candidates,
      needs_disambiguation: result.needsDisambiguation,
      disambiguation_options: result.disambiguationOptions,
      embed_spent: result.embedSpent,
      reason: result.reason,
    };
  }

  /** Catalogue metadata for one occupation, served from the in-process snapshot. */
  @Get("domain/:id")
  domain(@Param("id") id: string) {
    const found = this.occupation.describeDomain(id);
    // 404 covers both "no such occupation" and "not selectable" — a caller has no business
    // distinguishing them, and saying which would leak the shape of the catalogue's
    // non-selectable tail for free.
    if (found === null) throw new NotFoundException("unknown or non-selectable occupation");
    return {
      job_domain_id: found.jobDomainId,
      label: found.label,
      label_en: found.labelEn,
      label_hi: found.labelHi,
      isco_unit_code: found.iscoUnitCode,
      family_id: found.familyId,
      catalog_version: found.catalogVersion,
    };
  }
}
