import { Body, Controller, Get, HttpCode, Inject, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { PayerAuthGuard, CurrentPayer, type AuthenticatedPayer } from "../payers/payer-auth.guard";
import { PayerDisclosureRateLimit } from "../payers/payer-disclosure-rate-limit.service";
import { CandidateSearchService } from "./candidate-search.service";
import {
  CandidateSearchSchema,
  type CandidateFiltersDto,
  type CandidateSearchDto,
  type CandidateSearchResponseDto,
} from "./candidate-search.dto";

/** A missing body is the unfiltered first page — `{}` — never a 400 for an empty POST. */
const CandidateSearchBodySchema = z.preprocess((v) => v ?? {}, CandidateSearchSchema);

/** The hourly bucket the search pages count against (see `PAYER_CANDIDATE_SEARCH_MAX_PER_HOUR`). */
export const CANDIDATE_SEARCH_RATE_SCOPE = "payer_candidate_search";

/**
 * The payer's ALL-CANDIDATES search (ADR-0040, phase E2; owner rulings 2026-11-03). Company and
 * agency sessions alike — the pool is the platform's, not a posting's.
 *
 * HTTP ONLY: it validates, applies the per-payer cap and delegates to
 * {@link CandidateSearchService}, which owns membership, ordering, masking and the event.
 *  - The payer is the verified SESSION (XB-A): the body has no slot for a `payer_id`, and
 *    `.strict()` turns a smuggled one into a 400.
 *  - POST, not GET, though it writes nothing: the filter set is a list (the precedent is
 *    `POST /payer/match/reach-preview`). 200, not 201 — it creates nothing.
 *  - SCRAPE BOUND: one unit of the payer's own hourly bucket per page, charged BEFORE any read,
 *    so a capped payer touches no data. Fails closed (429) when Redis is down. Each page is at
 *    most 50 masked rows; identity is only ever released per worker by `POST /payer/unlocks`.
 *  - `GET /payer/candidates/filters` is the option lists only (closed vocabulary + the cities the
 *    pool records); it reads no candidate, so it carries no cap.
 */
@Controller("payer/candidates")
@UseGuards(PayerAuthGuard)
export class CandidateSearchController {
  constructor(
    private readonly candidates: CandidateSearchService,
    private readonly rateLimit: PayerDisclosureRateLimit,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  @Post("search")
  @HttpCode(200)
  async search(
    @Body(new ZodValidationPipe(CandidateSearchBodySchema)) dto: CandidateSearchDto,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ): Promise<CandidateSearchResponseDto> {
    await this.rateLimit.assertWithinHourlyCap(payer.id, {
      scope: CANDIDATE_SEARCH_RATE_SCOPE,
      cap: this.config.PAYER_CANDIDATE_SEARCH_MAX_PER_HOUR,
    });
    return this.candidates.search(payer.id, dto, ctx);
  }

  @Get("filters")
  async filters(): Promise<CandidateFiltersDto> {
    return this.candidates.filters();
  }
}
