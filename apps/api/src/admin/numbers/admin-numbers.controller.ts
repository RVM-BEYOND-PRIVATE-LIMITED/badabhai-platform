import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Put,
  UseGuards,
} from "@nestjs/common";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { Ctx, type RequestContext } from "../../common/request-context";
import { AdminAuthGuard, CurrentAdmin, type AuthenticatedAdmin } from "../admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "../admin-roles.guard";
import { AdminNumbersEnabledGuard } from "./admin-numbers.flag";
import {
  AdminNumbersMarkTestAccountSchema,
  AdminNumbersPayerParamsSchema,
  NumbersIdempotencyKey,
  type AdminNumbersDefinitions,
  type AdminNumbersMarkTestAccountDto,
  type AdminNumbersPayerParamsDto,
  type AdminPayerTestAccountResult,
} from "./admin-numbers.dto";
import { AdminNumbersService } from "./admin-numbers.service";

/**
 * #2755 — the numbers screen (part A).
 *
 *   GET    /admin/numbers/definitions                 read_business_numbers   the catalogue
 *   PUT    /admin/numbers/test-accounts/:payerId      read_business_numbers   mark a test company
 *   DELETE /admin/numbers/test-accounts/:payerId      read_business_numbers   unmark it
 *
 * ONE CAPABILITY for all three, `read_business_numbers` (super_admin + ops_admin, owner question 1
 * default). The marks ride it because they exist only to decide what these figures count.
 *
 * THE ORDER: `AdminAuthGuard` (401 with no session), then `AdminNumbersEnabledGuard` (a neutral 404
 * for every role while `ADMIN_NUMBERS_ENABLED` is off, before any pipe or query), then
 * `AdminRolesGuard` (403 for a role without the capability once it is on). One method-level
 * capability per route, none on the class. `Cache-Control: no-store` on all three: the catalogue
 * describes the company's commercial figures, and a mark's answer is per-company state.
 */
@Controller("admin/numbers")
@UseGuards(AdminAuthGuard, AdminNumbersEnabledGuard, AdminRolesGuard)
export class AdminNumbersController {
  constructor(private readonly service: AdminNumbersService) {}

  @Get("definitions")
  @Header("Cache-Control", "no-store")
  @RequireAdminRole("read_business_numbers")
  definitions(): AdminNumbersDefinitions {
    return this.service.definitions();
  }

  @Put("test-accounts/:payerId")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @RequireAdminRole("read_business_numbers")
  markTestAccount(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminNumbersPayerParamsSchema)) params: AdminNumbersPayerParamsDto,
    @Body(new ZodValidationPipe(AdminNumbersMarkTestAccountSchema))
    dto: AdminNumbersMarkTestAccountDto,
    @NumbersIdempotencyKey() idempotencyKey: string,
    @Ctx() ctx: RequestContext,
  ): Promise<AdminPayerTestAccountResult> {
    return this.service.markByAdmin(admin, params.payerId, dto, idempotencyKey, ctx);
  }

  @Delete("test-accounts/:payerId")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @RequireAdminRole("read_business_numbers")
  unmarkTestAccount(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminNumbersPayerParamsSchema)) params: AdminNumbersPayerParamsDto,
    @Ctx() ctx: RequestContext,
  ): Promise<AdminPayerTestAccountResult> {
    return this.service.unmarkByAdmin(admin, params.payerId, ctx);
  }
}
