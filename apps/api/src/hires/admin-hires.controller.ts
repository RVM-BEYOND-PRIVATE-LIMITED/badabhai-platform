import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { AdminAuthGuard } from "../admin/admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "../admin/admin-roles.guard";
import { HireRecordsEnabledGuard } from "./hires.flag";
import {
  AdminHiresQuerySchema,
  type AdminHiresPage,
  type AdminHiresQueryDto,
} from "./admin-hires.dto";
import { HiresService } from "./hires.service";

/**
 * #2753 item 9 — the admin list of HIRE RECORDS.
 *
 *   GET /admin/hires   manage_companies   one keyset page, newest first, `?status=` optional
 *
 * ONE CAPABILITY, from the ADR-0025 matrix as it stands: `manage_companies` is held by exactly
 * `super_admin` and `ops_admin` (the issue's default for hire routes), and a hire record is a
 * company's record of whom it took on. Reused, not added: a matrix change needs the owner.
 *
 * THE ORDER: `AdminAuthGuard` (401 with no session), then `HireRecordsEnabledGuard` (404 for every
 * role while `HIRE_RECORDS_ENABLED` is off, so no role learns the surface exists), then
 * `AdminRolesGuard` (403 for a role without the capability once it is on).
 *
 * FACELESS, so no `Cache-Control: no-store` (on the admin surface that header means "this body may
 * hold PII"): ids, closed codes and dates only, as the admin applications list.
 */
@Controller("admin/hires")
@UseGuards(AdminAuthGuard, HireRecordsEnabledGuard, AdminRolesGuard)
export class AdminHiresController {
  constructor(private readonly hires: HiresService) {}

  @Get()
  @RequireAdminRole("manage_companies")
  list(
    @Query(new ZodValidationPipe(AdminHiresQuerySchema)) query: AdminHiresQueryDto,
  ): Promise<AdminHiresPage> {
    return this.hires.listForAdmin(query);
  }
}
