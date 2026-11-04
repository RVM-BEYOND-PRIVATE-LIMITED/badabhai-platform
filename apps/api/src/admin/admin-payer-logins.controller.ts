import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { AdminAuthGuard, CurrentAdmin, type AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "./admin-roles.guard";
import { AdminPayerLoginsService } from "./admin-payer-logins.service";
import {
  AdminAccountsQuerySchema,
  AdminCreatePayerLoginSchema,
  AdminIssueTemporaryPasswordSchema,
  AdminRevokePayerPasswordSchema,
  type AdminAccountsQueryDto,
  type AdminCreatePayerLoginDto,
  type AdminIssueTemporaryPasswordDto,
  type AdminRevokePayerPasswordDto,
} from "./admin-payer-logins.dto";
import { AdminTargetParamsSchema, type AdminTargetParamsDto } from "./admin-actions.dto";

/**
 * #2563 — payer login management routes.
 *
 * RBAC: every route is behind {@link AdminAuthGuard} + {@link AdminRolesGuard} and declares
 * exactly ONE capability, `manage_payer_credentials` (super_admin, ops_admin, support). The
 * login ID and organisation name on the list are ADDITIVE and separately gated by
 * `read_identity` inside {@link AdminPayerLoginsService} — the route grant alone never
 * discloses contact identity.
 *
 * The actor is always `@CurrentAdmin().id` (never a body field); the target is the validated
 * path uuid. Every write accepts a closed reason code + written reason and commits it with the
 * credential change and the value-free `admin.action_performed`.
 */
@Controller("admin")
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminPayerLoginsController {
  constructor(private readonly service: AdminPayerLoginsService) {}

  /**
   * The User accounts list. `Cache-Control: no-store`: the response may carry decrypted login
   * IDs and organisation names, and a shared/browser cache must not retain them.
   */
  @Get("accounts")
  @Header("Cache-Control", "no-store")
  @RequireAdminRole("manage_payer_credentials")
  listAccounts(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Query(new ZodValidationPipe(AdminAccountsQuerySchema)) query: AdminAccountsQueryDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.listAccounts(admin, query, ctx);
  }

  /** Create a company/agency owner login, or a team member under an existing org. */
  @Post("payers")
  @HttpCode(201)
  @Header("Cache-Control", "no-store")
  @RequireAdminRole("manage_payer_credentials")
  createLogin(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body(new ZodValidationPipe(AdminCreatePayerLoginSchema)) dto: AdminCreatePayerLoginDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.createLogin(admin, dto, ctx);
  }

  /** Issue a new temporary password (the value is returned once, in this response). */
  @Post("payers/:id/password/temporary")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @RequireAdminRole("manage_payer_credentials")
  issueTemporaryPassword(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminTargetParamsSchema)) params: AdminTargetParamsDto,
    @Body(new ZodValidationPipe(AdminIssueTemporaryPasswordSchema))
    dto: AdminIssueTemporaryPasswordDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.issueTemporaryPassword(admin, params.id, dto, ctx);
  }

  /** Revoke password sign-in; the email-code door stays open. */
  @Post("payers/:id/password/revoke")
  @HttpCode(200)
  @RequireAdminRole("manage_payer_credentials")
  revokePassword(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminTargetParamsSchema)) params: AdminTargetParamsDto,
    @Body(new ZodValidationPipe(AdminRevokePayerPasswordSchema)) dto: AdminRevokePayerPasswordDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.revokePassword(admin, params.id, dto, ctx);
  }
}
