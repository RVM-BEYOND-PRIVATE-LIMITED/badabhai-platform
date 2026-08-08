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
import { PackRegistryService } from "../profiling/pack-registry.service";
import { SkillsInternalGuard } from "../skills/skills-internal.guard";
import {
  RecordUnresolvedOccupationDtoSchema,
  ResolveOccupationDtoSchema,
  ResolveQuestionPackDtoSchema,
  type RecordUnresolvedOccupationDto,
  type ResolveOccupationDto,
  type ResolveQuestionPackDto,
} from "./occupation.dto";
import { OccupationService } from "./occupation.service";

@Controller("internal/occupation")
@UseGuards(SkillsInternalGuard)
export class OccupationController {
  constructor(
    private readonly occupation: OccupationService,
    // Prakash's registry, reused rather than re-resolved. It already owns the fallback chain,
    // the version pinning and the pack cache — and a second resolver here is precisely how the
    // engine and the deploy gate came to disagree about a worker's family once already.
    private readonly packs: PackRegistryService,
  ) {}

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

  /**
   * Which question pack a family or an occupation gets. Read-only — no event.
   *
   * THE THREE SELECTORS ANSWER THREE DIFFERENT QUESTIONS, which is why they are not
   * interchangeable:
   *
   *   job_domain_id  "what would this worker actually be asked" — walks the fallback chain,
   *                  so an unauthored trade correctly answers with its parent's pack.
   *   family_id      "what does THIS family own" — no fall-through, so ops can see that a
   *                  family has no pack yet instead of being shown somebody else's.
   *   pack_id+ver    the exact pinned version, never re-resolved to whatever is active now.
   */
  @Post("question-pack")
  @HttpCode(200)
  async questionPack(
    @Body(new ZodValidationPipe(ResolveQuestionPackDtoSchema)) dto: ResolveQuestionPackDto,
  ) {
    const now = Date.now();
    let pack = null;

    if (dto.pack_id !== undefined && dto.pack_version !== undefined) {
      pack = await this.packs.loadPinned(dto.pack_id, dto.pack_version, now);
    } else if (dto.family_id !== undefined) {
      pack = await this.packs.loadForFamily(dto.family_id, now);
    } else if (dto.job_domain_id !== undefined) {
      const domain = this.occupation.describeDomain(dto.job_domain_id);
      // A 404 here, rather than falling through to the universal pack. The caller named an
      // occupation; answering about a different one would be a wrong answer wearing a 200.
      if (domain === null) throw new NotFoundException("unknown or non-selectable occupation");
      pack = await this.packs.resolveForOccupation(
        {
          job_domain_id: domain.jobDomainId,
          label: domain.label,
          isco_unit_code: domain.iscoUnitCode,
          match_status: "matched_lexical",
          match_score: null,
          match_layer: null,
          pack_id: null,
          pack_version: null,
          catalog_version: domain.catalogVersion,
        },
        now,
      );
    }

    if (pack === null) throw new NotFoundException("no active question pack for that selector");
    return { pack };
  }

  /**
   * Record a below-floor occupation phrase (ALREADY pseudonymized) and emit the hash-only
   * event. 204 — the caller has nothing to do with the count.
   *
   * A SEPARATE CALL, NOT SOMETHING `resolve` DOES FOR ITSELF. `resolve` receives the
   * worker's raw utterance; this table's contract is pseudonymized text only. Recording
   * automatically would put raw worker words into an ops queue, silently, on every
   * unmatched turn.
   */
  @Post("unresolved")
  @HttpCode(204)
  async recordUnresolved(
    @Body(new ZodValidationPipe(RecordUnresolvedOccupationDtoSchema))
    dto: RecordUnresolvedOccupationDto,
  ): Promise<void> {
    await this.occupation.recordUnresolved(dto.phrase, dto.lang);
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
