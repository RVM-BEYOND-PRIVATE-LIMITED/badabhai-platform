import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { Ctx, type RequestContext } from "../../common/request-context";
import { AdminAuthGuard, CurrentAdmin, type AuthenticatedAdmin } from "../admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "../admin-roles.guard";
import { AdminNumbersEnabledGuard } from "./admin-numbers.flag";
import {
  AdminNumbersLogCreditCallSchema,
  AdminNumbersMarkTestAccountSchema,
  AdminNumbersOutOfCreditsQuerySchema,
  AdminNumbersPayerParamsSchema,
  AdminNumbersWeeklyQuerySchema,
  NumbersIdempotencyKey,
  type AdminNumbersDefinitions,
  type AdminNumbersLogCreditCallDto,
  type AdminNumbersLogCreditCallResult,
  type AdminNumbersMarkTestAccountDto,
  type AdminNumbersOutOfCreditsPage,
  type AdminNumbersOutOfCreditsQueryDto,
  type AdminNumbersPayerParamsDto,
  type AdminNumbersWeekly,
  type AdminNumbersWeeklyQueryDto,
  type AdminPayerTestAccountResult,
} from "./admin-numbers.dto";
import { AdminNumbersService } from "./admin-numbers.service";
import { AdminNumbersCallsService } from "./admin-numbers-calls.service";
import { AdminNumbersWeeklyService } from "./admin-numbers-weekly.service";

/**
 * #2755 — the numbers screen (parts A, B and C).
 *
 *   GET    /admin/numbers/definitions                     read_business_numbers   the catalogue
 *   PUT    /admin/numbers/test-accounts/:payerId          read_business_numbers   mark a test company
 *   DELETE /admin/numbers/test-accounts/:payerId          read_business_numbers   unmark it
 *   GET    /admin/numbers/weekly                          read_business_numbers   the weekly figures
 *   GET    /admin/numbers/out-of-credits                  read_business_numbers   the call list
 *   POST   /admin/numbers/out-of-credits/:payerId/calls   read_business_numbers   log a call
 *
 * ONE CAPABILITY for all six, `read_business_numbers` (super_admin + ops_admin, owner question 1
 * default). The marks ride it because they exist only to decide what these figures count; the
 * call log because it exists only to work the call list. The call list's company NAME is
 * additionally `read_identity`'s, checked inside `AdminIdentityService` (never a second
 * decorator); its phone is never on these routes.
 *
 * THE ORDER: `AdminAuthGuard` (401 with no session), then `AdminNumbersEnabledGuard` (a neutral 404
 * for every role while `ADMIN_NUMBERS_ENABLED` is off, before any pipe or query), then
 * `AdminRolesGuard` (403 for a role without the capability once it is on). One method-level
 * capability per route, none on the class. `Cache-Control: no-store` on all six: the catalogue,
 * the weekly figures and the call list are the company's commercial numbers (the list may carry
 * decrypted names), and a mark's or a call's answer is per-company state. The weekly read is a GET
 * of the snapshot only: it writes nothing and emits nothing. Each part C handler has the SAME NAME
 * as the service method it calls. The two writes (the PUT mark and the POST call) take the
 * REQUIRED Idempotency-Key.
 */
@Controller("admin/numbers")
@UseGuards(AdminAuthGuard, AdminNumbersEnabledGuard, AdminRolesGuard)
export class AdminNumbersController {
  constructor(
    private readonly service: AdminNumbersService,
    private readonly weeklyNumbers: AdminNumbersWeeklyService,
    private readonly calls: AdminNumbersCallsService,
  ) {}

  @Get("definitions")
  @Header("Cache-Control", "no-store")
  @RequireAdminRole("read_business_numbers")
  definitions(): AdminNumbersDefinitions {
    return this.service.definitions();
  }

  @Get("weekly")
  @Header("Cache-Control", "no-store")
  @RequireAdminRole("read_business_numbers")
  weekly(
    @Query(new ZodValidationPipe(AdminNumbersWeeklyQuerySchema)) query: AdminNumbersWeeklyQueryDto,
  ): Promise<AdminNumbersWeekly> {
    return this.weeklyNumbers.weekly(query);
  }

  @Get("out-of-credits")
  @Header("Cache-Control", "no-store")
  @RequireAdminRole("read_business_numbers")
  outOfCredits(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Query(new ZodValidationPipe(AdminNumbersOutOfCreditsQuerySchema))
    query: AdminNumbersOutOfCreditsQueryDto,
    @Ctx() ctx: RequestContext,
  ): Promise<AdminNumbersOutOfCreditsPage> {
    return this.calls.outOfCredits(admin, query, ctx);
  }

  @Post("out-of-credits/:payerId/calls")
  @HttpCode(201)
  @Header("Cache-Control", "no-store")
  @RequireAdminRole("read_business_numbers")
  logCreditCall(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminNumbersPayerParamsSchema)) params: AdminNumbersPayerParamsDto,
    @Body(new ZodValidationPipe(AdminNumbersLogCreditCallSchema)) dto: AdminNumbersLogCreditCallDto,
    @NumbersIdempotencyKey() idempotencyKey: string,
    @Ctx() ctx: RequestContext,
  ): Promise<AdminNumbersLogCreditCallResult> {
    return this.calls.logCreditCall(admin, params.payerId, dto, idempotencyKey, ctx);
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
