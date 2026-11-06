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
import { Ctx, type RequestContext } from "../../common/request-context";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AdminAuthGuard, CurrentAdmin, type AuthenticatedAdmin } from "../admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "../admin-roles.guard";
import {
  AdminCompaniesQuerySchema,
  AdminCompanyParamsSchema,
  AdminCompanyReasonSchema,
  AdminCreateCompanySchema,
  AdminUpdateCompanySchema,
  type AdminCompaniesPage,
  type AdminCompaniesQueryDto,
  type AdminCompanyDetail,
  type AdminCompanyParamsDto,
  type AdminCompanyReasonDto,
  type AdminCompanyWriteResult,
  type AdminCreateCompanyDto,
  type AdminCreateCompanyResponse,
  type AdminUpdateCompanyDto,
} from "./admin-companies.dto";
import { AdminCompaniesService } from "./admin-companies.service";

/**
 * #2564 (B10) — the admin COMPANY RECORD. `:id` is the company's ROOT payer id.
 *
 *   GET   /admin/companies                read_entities      list (one row per organisation)
 *   GET   /admin/companies/:id            read_entities      detail (+ contact when permitted)
 *   POST  /admin/companies                manage_companies   create company + first login
 *   PATCH /admin/companies/:id            manage_companies   edit name / company record
 *   POST  /admin/companies/:id/archive    manage_companies   archive the whole organisation
 *   POST  /admin/companies/:id/restore    manage_companies   restore it
 *
 * ONE method-level capability per route and none on the class (a class-level one would be
 * inherited by every route added later). `Cache-Control: no-store` on every route whose body can
 * carry a company NAME, contact PII or a one-time password; the three writes that return ids only
 * do not set it, so its presence keeps meaning "this body may hold PII".
 */
@Controller("admin/companies")
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminCompaniesController {
  constructor(private readonly service: AdminCompaniesService) {}

  @Get()
  @Header("Cache-Control", "no-store")
  @RequireAdminRole("read_entities")
  listCompanies(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Query(new ZodValidationPipe(AdminCompaniesQuerySchema)) query: AdminCompaniesQueryDto,
    @Ctx() ctx: RequestContext,
  ): Promise<AdminCompaniesPage> {
    return this.service.listCompanies(admin, query, ctx);
  }

  @Get(":id")
  @Header("Cache-Control", "no-store")
  @RequireAdminRole("read_entities")
  getCompany(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminCompanyParamsSchema)) params: AdminCompanyParamsDto,
    @Ctx() ctx: RequestContext,
  ): Promise<AdminCompanyDetail> {
    return this.service.getCompany(admin, params.id, ctx);
  }

  @Post()
  @HttpCode(201)
  @Header("Cache-Control", "no-store")
  @RequireAdminRole("manage_companies")
  createCompany(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body(new ZodValidationPipe(AdminCreateCompanySchema)) dto: AdminCreateCompanyDto,
    @Ctx() ctx: RequestContext,
  ): Promise<AdminCreateCompanyResponse> {
    return this.service.createCompany(admin, dto, ctx);
  }

  @Patch(":id")
  @HttpCode(200)
  @RequireAdminRole("manage_companies")
  updateCompany(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminCompanyParamsSchema)) params: AdminCompanyParamsDto,
    @Body(new ZodValidationPipe(AdminUpdateCompanySchema)) dto: AdminUpdateCompanyDto,
    @Ctx() ctx: RequestContext,
  ): Promise<AdminCompanyWriteResult> {
    return this.service.updateCompany(admin, params.id, dto, ctx);
  }

  @Post(":id/archive")
  @HttpCode(200)
  @RequireAdminRole("manage_companies")
  archiveCompany(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminCompanyParamsSchema)) params: AdminCompanyParamsDto,
    @Body(new ZodValidationPipe(AdminCompanyReasonSchema)) dto: AdminCompanyReasonDto,
    @Ctx() ctx: RequestContext,
  ): Promise<AdminCompanyWriteResult> {
    return this.service.archiveCompany(admin, params.id, dto, ctx);
  }

  @Post(":id/restore")
  @HttpCode(200)
  @RequireAdminRole("manage_companies")
  restoreCompany(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminCompanyParamsSchema)) params: AdminCompanyParamsDto,
    @Body(new ZodValidationPipe(AdminCompanyReasonSchema)) dto: AdminCompanyReasonDto,
    @Ctx() ctx: RequestContext,
  ): Promise<AdminCompanyWriteResult> {
    return this.service.restoreCompany(admin, params.id, dto, ctx);
  }
}
