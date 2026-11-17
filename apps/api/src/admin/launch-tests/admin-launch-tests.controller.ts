import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { Ctx, type RequestContext } from "../../common/request-context";
import { AdminAuthGuard, CurrentAdmin, type AuthenticatedAdmin } from "../admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "../admin-roles.guard";
import { NumbersIdempotencyKey } from "../numbers/admin-numbers.dto";
import { AdminNumbersEnabledGuard } from "../numbers/admin-numbers.flag";
import {
  AdminLaunchTestCohortQuerySchema,
  AdminLaunchTestParamsSchema,
  AdminLaunchTestRecordSchema,
  AdminLaunchTestUpdateSchema,
  type AdminContactsPerHireReport,
  type AdminLaunchTestCohortPage,
  type AdminLaunchTestCohortQueryDto,
  type AdminLaunchTestParamsDto,
  type AdminLaunchTestRecordDto,
  type AdminLaunchTestRecordResult,
  type AdminLaunchTestUpdateDto,
  type AdminLaunchTestUpdateResult,
} from "./admin-launch-tests.dto";
import { AdminLaunchTestsService } from "./admin-launch-tests.service";

/**
 * #2755 part D — the two pre-launch tests' records (items 9 and 10).
 *
 *   GET   /admin/launch-tests/cohort              read_business_numbers   test A's factories
 *   POST  /admin/launch-tests/cohort              read_business_numbers   record a factory
 *   PATCH /admin/launch-tests/cohort/:id          read_business_numbers   its link and result
 *   GET   /admin/launch-tests/contacts-per-hire   read_business_numbers   test B's report
 *
 * THE NUMBERS SCREEN'S GATES, IN ITS ORDER: `AdminAuthGuard` (401), then part A's
 * `AdminNumbersEnabledGuard` (a neutral 404 for every role while `ADMIN_NUMBERS_ENABLED` is off,
 * before any pipe or query), then `AdminRolesGuard` (403 for support and analyst). One method-level
 * capability per route, none on the class. The factory name is additionally `read_identity`'s,
 * checked inside `AdminIdentityService` (never a second decorator). Both writes take part A's
 * REQUIRED `Idempotency-Key`. `Cache-Control: no-store` on all four: the cohort list may carry
 * decrypted names, and every answer is the company's pre-launch sales record.
 *
 * Each handler has the SAME NAME as the service method it calls (the no-store derivation in
 * `admin-static-guards.test.ts` relies on it).
 */
@Controller("admin/launch-tests")
@UseGuards(AdminAuthGuard, AdminNumbersEnabledGuard, AdminRolesGuard)
export class AdminLaunchTestsController {
  constructor(private readonly service: AdminLaunchTestsService) {}

  @Get("cohort")
  @Header("Cache-Control", "no-store")
  @RequireAdminRole("read_business_numbers")
  listCohort(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Query(new ZodValidationPipe(AdminLaunchTestCohortQuerySchema))
    query: AdminLaunchTestCohortQueryDto,
    @Ctx() ctx: RequestContext,
  ): Promise<AdminLaunchTestCohortPage> {
    return this.service.listCohort(admin, query, ctx);
  }

  @Post("cohort")
  @HttpCode(201)
  @Header("Cache-Control", "no-store")
  @RequireAdminRole("read_business_numbers")
  recordFactory(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body(new ZodValidationPipe(AdminLaunchTestRecordSchema)) dto: AdminLaunchTestRecordDto,
    @NumbersIdempotencyKey() idempotencyKey: string,
    @Ctx() ctx: RequestContext,
  ): Promise<AdminLaunchTestRecordResult> {
    return this.service.recordFactory(admin, dto, idempotencyKey, ctx);
  }

  @Patch("cohort/:id")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @RequireAdminRole("read_business_numbers")
  updateFactory(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminLaunchTestParamsSchema)) params: AdminLaunchTestParamsDto,
    @Body(new ZodValidationPipe(AdminLaunchTestUpdateSchema)) dto: AdminLaunchTestUpdateDto,
    @NumbersIdempotencyKey() idempotencyKey: string,
    @Ctx() ctx: RequestContext,
  ): Promise<AdminLaunchTestUpdateResult> {
    return this.service.updateFactory(admin, params.id, dto, idempotencyKey, ctx);
  }

  @Get("contacts-per-hire")
  @Header("Cache-Control", "no-store")
  @RequireAdminRole("read_business_numbers")
  contactsPerHire(): Promise<AdminContactsPerHireReport> {
    return this.service.contactsPerHire();
  }
}
