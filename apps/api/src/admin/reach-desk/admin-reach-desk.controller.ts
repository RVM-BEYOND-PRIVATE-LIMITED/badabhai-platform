import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { Ctx, type RequestContext } from "../../common/request-context";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  ReachAttemptSchema,
  ReachCasesQuerySchema,
  ReachResolveSchema,
  type ReachAttemptDto,
  type ReachCasesQuery,
  type ReachResolveDto,
} from "../../reach-desk/reach-desk.dto";
import {
  ReachDeskService,
  type DeskReachCaseDetail,
  type DeskReachCaseView,
} from "../../reach-desk/reach-desk.service";
import { AdminAuthGuard, CurrentAdmin, type AuthenticatedAdmin } from "../admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "../admin-roles.guard";

/**
 * #2750 items 7 and 12 — the worker desk in the admin console.
 *
 *   GET  /admin/desk/reach-cases               the queue: open (nearest deadline first),
 *                                              resolved or all (newest first), with attempt counts.
 *   GET  /admin/desk/reach-cases/:id           one case with its attempt log.
 *   POST /admin/desk/reach-cases/:id/attempts  log one call (a closed result code).
 *   POST /admin/desk/reach-cases/:id/resolve   close it: reached and interested, reached and
 *                                              declined, or not reached (the credits come back).
 *
 * The paths are the issue's (#2750 item 8: `/admin/desk/reach-cases`).
 *
 * All four: {@link AdminAuthGuard} + {@link AdminRolesGuard}, capability `work_reach_desk`
 * (super_admin, ops_admin, support; owner ruling 2026-11-17); 404 while the `credit_rules` switch
 * is off everywhere, 503 with it on and the tables missing. A closed case answers 409
 * `CASE_RESOLVED`. The desk reaches the worker through the existing reason-gated reveal
 * (`POST /admin/workers/:id/reveal-contact`, `reveal_pii`) with the case id as the reason; nothing
 * here returns a number. The actor is always `@CurrentAdmin().id`.
 */
@Controller("admin")
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminReachDeskController {
  constructor(private readonly desk: ReachDeskService) {}

  @Get("desk/reach-cases")
  @RequireAdminRole("work_reach_desk")
  listReachCases(
    @Query(new ZodValidationPipe(ReachCasesQuerySchema)) query: ReachCasesQuery,
  ): Promise<{ cases: DeskReachCaseView[]; next_cursor: string | null }> {
    return this.desk.list({
      status: query.status,
      ...(query.cursor ? { cursor: query.cursor } : {}),
      limit: query.limit,
    });
  }

  @Get("desk/reach-cases/:id")
  @RequireAdminRole("work_reach_desk")
  getReachCase(@Param("id", new ParseUUIDPipe()) id: string): Promise<DeskReachCaseDetail> {
    return this.desk.get(id);
  }

  @Post("desk/reach-cases/:id/attempts")
  @HttpCode(200)
  @RequireAdminRole("work_reach_desk")
  logReachAttempt(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(ReachAttemptSchema)) dto: ReachAttemptDto,
  ): Promise<DeskReachCaseDetail> {
    return this.desk.logAttempt(admin.id, id, dto.result);
  }

  @Post("desk/reach-cases/:id/resolve")
  @HttpCode(200)
  @RequireAdminRole("work_reach_desk")
  resolveReachCase(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(ReachResolveSchema)) dto: ReachResolveDto,
    @Ctx() ctx: RequestContext,
  ): Promise<DeskReachCaseDetail> {
    return this.desk.resolveByDesk(admin.id, id, dto.outcome, dto.reason_text, ctx);
  }
}
