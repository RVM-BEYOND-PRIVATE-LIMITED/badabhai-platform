import { Controller, Get, UseGuards } from "@nestjs/common";
import { AdminAuthGuard } from "../admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "../admin-roles.guard";
import {
  AdminCampusHeldRolesService,
  type CampusHeldRolesResponse,
} from "./admin-campus-held-roles.service";

/**
 * #3014 — the Campus held list (#3023 builds the screen's panel).
 *
 *   GET /admin/campus-roles/held   held Campus role names and RVM course names, with counts
 *
 * Behind {@link AdminAuthGuard} + {@link AdminRolesGuard} with `read_entities`: names and counts
 * only, no personal data. Read-only.
 */
@Controller("admin/campus-roles")
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminCampusHeldRolesController {
  constructor(private readonly service: AdminCampusHeldRolesService) {}

  @Get("held")
  @RequireAdminRole("read_entities")
  held(): Promise<CampusHeldRolesResponse> {
    return this.service.held();
  }
}
