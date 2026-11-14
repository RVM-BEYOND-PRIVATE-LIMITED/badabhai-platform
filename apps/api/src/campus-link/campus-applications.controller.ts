import { Body, Controller, Delete, Get, Param, Post, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import type { z } from "zod";
import { Ctx, type RequestContext } from "../common/request-context";
import { campusCall } from "./campus-errors";
import {
  CAMPUS_LINK_BASE_PATH,
  CampusApplicationsQuerySchema,
  CampusApplyBodySchema,
  CampusExternalRefSchema,
} from "./campus-link.contract";
import { CampusIdempotencyKey, CampusZodPipe } from "./campus-request";
import { CampusServiceGuard } from "./campus-service.guard";
import { CampusApplicationsService } from "./campus-applications.service";

/**
 * Campus applications (#2752 item 8), behind the Campus credential. `external_ref` is the lasting
 * idempotency guard: the same ref again answers the application it made, for good.
 */
@Controller(CAMPUS_LINK_BASE_PATH)
@UseGuards(CampusServiceGuard)
export class CampusApplicationsController {
  constructor(private readonly applications: CampusApplicationsService) {}

  /** A student applies. `201` with the application, or `200` with the same one on a replay. */
  @Post("applications")
  async apply(
    @Body(new CampusZodPipe(CampusApplyBodySchema)) body: z.infer<typeof CampusApplyBodySchema>,
    @CampusIdempotencyKey() _idempotencyKey: string,
    @Ctx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { created, application } = await campusCall(() => this.applications.apply(body, ctx));
    res.status(created ? 201 : 200);
    return application;
  }

  /** The status feed Campus polls instead of a push. */
  @Get("applications")
  async feed(
    @Query(new CampusZodPipe(CampusApplicationsQuerySchema))
    query: z.infer<typeof CampusApplicationsQuerySchema>,
  ) {
    return campusCall(() => this.applications.feed(query));
  }

  /** The student withdrew on Campus: the company no longer sees him. Idempotent. */
  @Delete("applications/:external_ref")
  async withdraw(
    @Param("external_ref", new CampusZodPipe(CampusExternalRefSchema)) externalRef: string,
    @CampusIdempotencyKey() _idempotencyKey: string,
    @Ctx() ctx: RequestContext,
  ) {
    return campusCall(() => this.applications.withdraw(externalRef, ctx));
  }
}
