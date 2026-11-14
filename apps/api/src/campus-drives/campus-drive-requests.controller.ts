import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { Ctx, type RequestContext } from "../common/request-context";
import {
  CAMPUS_LINK_BASE_PATH,
  CampusDriveDecisionBodySchema,
  CampusDriveRequestsQuerySchema,
} from "../campus-link/campus-link.contract";
import { campusCallIdOf } from "../campus-link/campus-call";
import { CampusIdempotencyKey, CampusZodPipe } from "../campus-link/campus-request";
import { CampusServiceGuard } from "../campus-link/campus-service.guard";
import {
  CampusDriveDecisionsService,
  type CampusDriveDecisionBody,
  type CampusDriveDecisionResult,
  type CampusDriveRequestPage,
  type CampusDriveRequestsQuery,
} from "./campus-drive-decisions.service";

/**
 * #2746 PR 6 — BadaBhai Campus's drive-request routes. HTTP ONLY: the rules are
 * `CampusDriveDecisionsService`'s.
 *
 * Its own controller and module (not `CampusLinkController`), behind the same `CampusServiceGuard`
 * and NEVER `InternalServiceGuard`: the guard's own token, address allow-list, per-minute cap and
 * audit row per call, and the neutral 404 while `CAMPUS_LINK_ENABLED` is off. The decision takes
 * the contract's `Idempotency-Key` (400 `IDEMPOTENCY_KEY_REQUIRED` without it) and a strict body
 * (400 `VALIDATION_FAILED`); it is idempotent by content (the same decision again is a replay), so
 * the key is checked, not stored.
 */
@Controller(CAMPUS_LINK_BASE_PATH)
@UseGuards(CampusServiceGuard)
export class CampusDriveRequestsController {
  constructor(private readonly decisions: CampusDriveDecisionsService) {}

  /** The placement team's queue: drive requests in change order, with each contact. */
  @Get("drive-requests")
  listDriveRequests(
    @Query(new CampusZodPipe(CampusDriveRequestsQuerySchema)) query: CampusDriveRequestsQuery,
  ): Promise<CampusDriveRequestPage> {
    return this.decisions.list(query);
  }

  /** The placement team schedules, declines or completes a drive request. */
  @Post("drive-requests/:id/decision")
  @HttpCode(200)
  decideDriveRequest(
    @Param("id") id: string,
    @CampusIdempotencyKey() _idempotencyKey: string,
    @Body(new CampusZodPipe(CampusDriveDecisionBodySchema)) body: CampusDriveDecisionBody,
    @Ctx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CampusDriveDecisionResult> {
    return this.decisions.decide(id, body, { ctx, callId: campusCallIdOf(res) });
  }
}
