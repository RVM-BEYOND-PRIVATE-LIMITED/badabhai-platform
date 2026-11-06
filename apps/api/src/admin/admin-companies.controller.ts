import { Body, Controller, Get, Header, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { AdminAuthGuard, CurrentAdmin, type AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "./admin-roles.guard";
import { AdminCompaniesService } from "./admin-companies.service";
import {
  AdminArchiveCompanySchema,
  AdminCompaniesQuerySchema,
  AdminCompanyParamsSchema,
  AdminCreateCompanySchema,
  AdminRestoreCompanySchema,
  AdminUpdateCompanySchema,
  type AdminArchiveCompanyDto,
  type AdminCompaniesQueryDto,
  type AdminCompanyParamsDto,
  type AdminCreateCompanyDto,
  type AdminRestoreCompanyDto,
  type AdminUpdateCompanyDto,
} from "./admin-companies.dto";

/**
 * Read-only + governed-write COMPANY API for the Admin Portal (#2564 B10) — one
 * row per organisation: the Companies tab's list, detail, team, create, edit,
 * archive and restore.
 *
 * ── RBAC ──────────────────────────────────────────────────────────────────────
 * Every route carries {@link AdminAuthGuard} + {@link AdminRolesGuard} and declares
 * exactly ONE capability at the METHOD level (deny-by-default). Reads sit on
 * `read_entities` (the admin read floor, all four roles); every WRITE sits on the
 * new `manage_companies` capability (super_admin, ops_admin, support) and carries
 * a written reason (code + text), recorded on the `audit_logs` row in the same
 * transaction as the system-of-record write and the events.
 *
 * Names and profile PII on the list/detail are ADDITIVE (resolved inside the
 * service through `AdminIdentityService`, same contract as the entity reads): a
 * role without `read_identity` gets the identical faceless response.
 */
@Controller("admin/companies")
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminCompaniesController {
  constructor(private readonly service: AdminCompaniesService) {}

  /**
   * One numbered page of organisations. `:search` matches whole-word name, GSTIN
   * or city fragment; every other filter is exact. Totals cover the filters.
   *
   * `Cache-Control: no-store` UNCONDITIONALLY (the entities' rule, verbatim): the
   * page can carry decrypted org names, and a header that varies with the caller's
   * capability is a cache-poisoning bug waiting to happen.
   */
  @Get()
  @Header("Cache-Control", "no-store")
  @RequireAdminRole("read_entities")
  listCompanies(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Query(new ZodValidationPipe(AdminCompaniesQuerySchema)) query: AdminCompaniesQueryDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.listCompanies(admin, query, ctx);
  }

  /**
   * One company's record. `:id` is the org anchor (founder) login; a member id
   * resolves to the same org, never to a second company.
   */
  @Get(":id")
  @Header("Cache-Control", "no-store")
  @RequireAdminRole("read_entities")
  getCompany(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminCompanyParamsSchema)) params: AdminCompanyParamsDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.getCompany(admin, params.id, ctx);
  }

  /** Every non-removed login in the org. Faceless — identifiers live on User accounts. */
  @Get(":id/members")
  @RequireAdminRole("read_entities")
  listMembers(
    @Param(new ZodValidationPipe(AdminCompanyParamsSchema)) params: AdminCompanyParamsDto,
  ) {
    return this.service.listMembers(params.id);
  }

  /**
   * Create a company/agency with its first (owner) login + temporary password.
   * The account is ACTIVE immediately; the credential must be changed at first
   * sign-in (the #2563 mechanism, verbatim).
   */
  @Post()
  @Header("Cache-Control", "no-store")
  @RequireAdminRole("manage_companies")
  createCompany(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body(new ZodValidationPipe(AdminCreateCompanySchema)) dto: AdminCreateCompanyDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.createCompany(admin, dto, ctx);
  }

  /** Edit the company record. Only changed fields write; the changed KEYS are evented. */
  @Patch(":id")
  @RequireAdminRole("manage_companies")
  updateCompany(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminCompanyParamsSchema)) params: AdminCompanyParamsDto,
    @Body(new ZodValidationPipe(AdminUpdateCompanySchema)) dto: AdminUpdateCompanyDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.updateCompany(admin, params.id, dto, ctx);
  }

  /** Freeze the whole company: every login archived, inventory frozen, sessions ended. */
  @Post(":id/archive")
  @RequireAdminRole("manage_companies")
  archiveCompany(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminCompanyParamsSchema)) params: AdminCompanyParamsDto,
    @Body(new ZodValidationPipe(AdminArchiveCompanySchema)) dto: AdminArchiveCompanyDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.archiveCompany(admin, params.id, dto, ctx);
  }

  /** Hand every archived login back to its previous status and thaw the inventory. */
  @Post(":id/restore")
  @RequireAdminRole("manage_companies")
  restoreCompany(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminCompanyParamsSchema)) params: AdminCompanyParamsDto,
    @Body(new ZodValidationPipe(AdminRestoreCompanySchema)) dto: AdminRestoreCompanyDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.restoreCompany(admin, params.id, dto, ctx);
  }
}
