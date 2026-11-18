import { Body, Controller, Param, Put, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { Ctx, type RequestContext } from "../common/request-context";
import { campusCallIdOf } from "./campus-call";
import {
  CAMPUS_LINK_BASE_PATH,
  CampusReviewBodySchema,
  CampusTargetingOptionsBodySchema,
} from "./campus-link.contract";
import {
  CampusPostingReviewService,
  type CampusReviewDecision,
  type CampusReviewResult,
} from "./campus-posting-review.service";
import { CampusIdempotencyKey, CampusZodPipe } from "./campus-request";
import { CampusServiceGuard } from "./campus-service.guard";
import {
  CampusTargetingOptionsService,
  type CampusTargetingOptionsList,
  type CampusTargetingOptionsResult,
} from "./campus-targeting-options.service";

/**
 * #2746 PR 5 — BadaBhai Campus's review and targeting routes. HTTP ONLY: the rules are in
 * `CampusPostingReviewService` and `CampusTargetingOptionsService`.
 *
 * Its own controller (not `CampusLinkController`), behind the same `CampusServiceGuard` and never
 * `InternalServiceGuard`: the guard's own token, address allow-list, per-minute cap and audit row
 * per call, and the neutral 404 while `CAMPUS_LINK_ENABLED` is off. Every write takes the contract's
 * `Idempotency-Key` (400 `IDEMPOTENCY_KEY_REQUIRED` without it) and a strict body (400
 * `VALIDATION_FAILED`). Both PUTs are idempotent by content, so the key is checked, not stored.
 */
@Controller(CAMPUS_LINK_BASE_PATH)
@UseGuards(CampusServiceGuard)
export class CampusReviewController {
  constructor(
    private readonly reviews: CampusPostingReviewService,
    private readonly targeting: CampusTargetingOptionsService,
  ) {}

  /** The placement team approves or rejects the RVM part of a posting. */
  @Put("job-postings/:id/review")
  reviewPosting(
    @Param("id") id: string,
    @CampusIdempotencyKey() _idempotencyKey: string,
    @Body(new CampusZodPipe(CampusReviewBodySchema)) decision: CampusReviewDecision,
    @Ctx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CampusReviewResult> {
    return this.reviews.review(id, decision, { ctx, callId: campusCallIdOf(res) });
  }

  /** Campus replaces the whole list of branches and courses a company may target. */
  @Put("targeting-options")
  setTargetingOptions(
    @CampusIdempotencyKey() _idempotencyKey: string,
    @Body(new CampusZodPipe(CampusTargetingOptionsBodySchema)) list: CampusTargetingOptionsList,
    @Ctx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CampusTargetingOptionsResult> {
    return this.targeting.replace(list, { ctx, callId: campusCallIdOf(res) });
  }
}
