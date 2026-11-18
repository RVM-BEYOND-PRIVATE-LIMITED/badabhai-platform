import { Body, Controller, Delete, Param, Put, UseGuards } from "@nestjs/common";
import type { z } from "zod";
import { Ctx, type RequestContext } from "../common/request-context";
import { campusCall } from "./campus-errors";
import {
  CAMPUS_LINK_BASE_PATH,
  CampusExternalRefSchema,
  CampusSearchGrantBodySchema,
  type CampusSearchGrantSchema,
} from "./campus-link.contract";
import { CampusIdempotencyKey, CampusZodPipe } from "./campus-request";
import { CampusServiceGuard } from "./campus-service.guard";
import {
  InstituteSearchGrantsService,
  type SearchGrantView,
} from "./institute-search-grants.service";

type GrantAnswer = z.input<typeof CampusSearchGrantSchema>;

/**
 * Named-company search grants (#2752 item 10), behind the Campus credential. `grant_ref` is the
 * lasting idempotency guard: the same ref again answers the grant it made, for good.
 */
@Controller(CAMPUS_LINK_BASE_PATH)
@UseGuards(CampusServiceGuard)
export class CampusGrantsController {
  constructor(private readonly grants: InstituteSearchGrantsService) {}

  /**
   * The student said yes to this company in RVM's app. Stored only after BadaBhai reads that yes
   * from RVM by `consent_ref`, for this company and this student: anything else is
   * `STUDENT_NOT_AVAILABLE` and no row.
   */
  @Put("search-grants/:grant_ref")
  async grant(
    @Param("grant_ref", new CampusZodPipe(CampusExternalRefSchema)) grantRef: string,
    @Body(new CampusZodPipe(CampusSearchGrantBodySchema))
    body: z.infer<typeof CampusSearchGrantBodySchema>,
    @CampusIdempotencyKey() _idempotencyKey: string,
    @Ctx() ctx: RequestContext,
  ): Promise<GrantAnswer> {
    return toAnswer(await campusCall(() => this.grants.grant(grantRef, body, ctx)));
  }

  /** The grant ends: he leaves that company's search, and it opens him no more by this grant. */
  @Delete("search-grants/:grant_ref")
  async revoke(
    @Param("grant_ref", new CampusZodPipe(CampusExternalRefSchema)) grantRef: string,
    @CampusIdempotencyKey() _idempotencyKey: string,
    @Ctx() ctx: RequestContext,
  ): Promise<GrantAnswer> {
    return toAnswer(await campusCall(() => this.grants.revoke(grantRef, ctx)));
  }
}

function toAnswer(grant: SearchGrantView): GrantAnswer {
  return {
    grant_ref: grant.grantRef,
    company_id: grant.companyId,
    student_ref: grant.studentRef,
    state: grant.state,
    changed_at: grant.changedAt.toISOString(),
  };
}
