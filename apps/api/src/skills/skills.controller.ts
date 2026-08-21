import { BadRequestException, Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { SkillsInternalGuard } from "./skills-internal.guard";
import { SkillsService } from "./skills.service";
import {
  NearestAliasesDtoSchema,
  type NearestAliasesDto,
  NearestDomainsDtoSchema,
  type NearestDomainsDto,
  RecordUnresolvedDtoSchema,
  type RecordUnresolvedDto,
  toAliasSearchScope,
} from "./skills.dto";

/**
 * INTERNAL skill-canonicalization routes (ADR-0030 / FORK-B-1 seam A) — the DB half of
 * the request path. The (DB-free) ai-service `HttpSkillStore` is the only caller:
 * `skill_alias`/`unresolved_phrase` are RLS-locked + REVOKE'd, so the authorized reads/
 * writes live here on the api's owner connection.
 *
 * SkillsInternalGuard (SCOPED secret SKILLS_INTERNAL_TOKEN, FAIL CLOSED when
 * unconfigured): service-to-service only — no user principal anywhere. Deliberately NOT
 * the all-routes INTERNAL_SERVICE_TOKEN (least privilege: the ai-service's credential
 * must not open the resume-PII/money routes — #222 review finding).
 */
@Controller("internal/skills")
@UseGuards(SkillsInternalGuard)
export class SkillsController {
  constructor(private readonly skills: SkillsService) {}

  /**
   * Domain-scoped nearest-alias ANN lookup. Read-only — no event.
   *
   * The body carries EXACTLY ONE of `domain_id` (legacy 11-slug skill domain) or
   * `job_domain_id` (canonical `jd_*`); the schema 400s on neither and on both. The
   * response shape is unchanged: `{ candidates: [{ skill_id, score }] }`.
   */
  @Post("nearest-aliases")
  @HttpCode(200)
  async nearestAliases(
    @Body(new ZodValidationPipe(NearestAliasesDtoSchema)) dto: NearestAliasesDto,
  ) {
    const scope = toAliasSearchScope(dto);
    // Unreachable behind the schema's exactly-one-of refine, and kept anyway: the ONE
    // outcome that must never happen is a domainless search over the whole vocabulary,
    // so the fallback is a 400 rather than a default scope. Fail closed.
    if (scope === null) {
      throw new BadRequestException(
        "exactly one of domain_id or job_domain_id is required",
      );
    }
    const candidates = await this.skills.nearestAliases(scope, dto.vector, dto.k);
    return { candidates };
  }

  /**
   * Job-domain shortlist for the generalized-profiling RAG pass. Read-only — no event.
   *
   * Rides the SAME scoped credential as the alias lookup rather than minting a second
   * one: both are the same principal (the ai-service), the same class of read (a vector
   * search over a public reference catalog), and the catalog carries no worker data at
   * all — so a separate token would add ceremony without narrowing anything.
   */
  @Post("nearest-domains")
  @HttpCode(200)
  async nearestDomains(
    @Body(new ZodValidationPipe(NearestDomainsDtoSchema)) dto: NearestDomainsDto,
  ) {
    const candidates = await this.skills.nearestDomains(dto.vector, dto.k);
    return { candidates };
  }

  /** Upsert one below-floor miss (phrase ALREADY pseudonymized) + emit the hash-only event. */
  @Post("unresolved")
  @HttpCode(204)
  async recordUnresolved(
    @Body(new ZodValidationPipe(RecordUnresolvedDtoSchema)) dto: RecordUnresolvedDto,
  ): Promise<void> {
    // The DTO's refine guarantees exactly one is present; `?? null` narrows the optionals
    // to the service's nullable contract without re-deciding anything here (HTTP only).
    await this.skills.recordUnresolved(
      dto.phrase,
      dto.domain_id ?? null,
      dto.lang,
      dto.job_domain_id ?? null,
    );
  }
}
