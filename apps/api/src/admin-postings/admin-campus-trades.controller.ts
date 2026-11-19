import { Body, Controller, Get, Put, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { AdminAuthGuard, CurrentAdmin, type AuthenticatedAdmin } from "../admin/admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "../admin/admin-roles.guard";
import { AdminJobAudienceEnabledGuard } from "../job-postings/admin-job-audience.flag";
import { CampusTradesPutSchema, type CampusTradesPutDto } from "./admin-campus-trades.dto";
import { AdminCampusTradesService } from "./admin-campus-trades.service";

/**
 * #2957 — the trades RVM trains, so only jobs in them can be sent to Campus (#2956, ADR-0068).
 *
 *   GET admin/campus-trades   every trade kind, with whether RVM trains it now (read_entities)
 *   PUT admin/campus-trades   replace the whole list, with a reason (manage_campus_trades:
 *                             super_admin only)
 *
 * Behind `ADMIN_JOB_AUDIENCE_ENABLED`, like the audience control the list serves (a neutral 404
 * for every role while off). The actor is ALWAYS the session admin.
 */
@Controller("admin/campus-trades")
@UseGuards(AdminAuthGuard, AdminJobAudienceEnabledGuard, AdminRolesGuard)
export class AdminCampusTradesController {
  constructor(private readonly service: AdminCampusTradesService) {}

  @Get()
  @RequireAdminRole("read_entities")
  get() {
    return this.service.get();
  }

  @Put()
  @RequireAdminRole("manage_campus_trades")
  replace(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body(new ZodValidationPipe(CampusTradesPutSchema)) dto: CampusTradesPutDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.replace(admin.id, dto, ctx);
  }
}
