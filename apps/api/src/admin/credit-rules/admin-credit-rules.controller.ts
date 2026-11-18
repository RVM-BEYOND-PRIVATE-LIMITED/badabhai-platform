import { Body, Controller, Get, HttpCode, Put, UseGuards } from "@nestjs/common";
import { DEFAULT_CREDIT_RULES } from "@badabhai/pricing";
import { Ctx, type RequestContext } from "../../common/request-context";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AdminAuthGuard, CurrentAdmin, type AuthenticatedAdmin } from "../admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "../admin-roles.guard";
import {
  CreditRulesService,
  type ActiveCreditRules,
} from "../../credit-rules/credit-rules.service";
import {
  AdminUpdateCreditRulesSchema,
  type AdminCreditRulesResponse,
  type AdminUpdateCreditRulesDto,
  type AdminUpdateCreditRulesResponse,
} from "./admin-credit-rules.dto";

function toResponse(active: ActiveCreditRules): AdminCreditRulesResponse {
  return {
    rules: active.rules,
    defaults: DEFAULT_CREDIT_RULES,
    revision: active.revision,
    source: active.source,
    updated_at: active.updatedAt?.toISOString() ?? null,
  };
}

/**
 * #2750 item 1 — the credit rules' settings in the admin console.
 *
 *   GET /admin/credit-rules   the active rules, the brief's defaults and the revision to edit.
 *   PUT /admin/credit-rules   write the next revision (all rules, `expected_revision`, a reason).
 *
 * Both are behind {@link AdminAuthGuard} + {@link AdminRolesGuard} with ONE capability,
 * `manage_credit_rules` (super_admin only: an edit changes every company's price at once). Both
 * answer 404 while the `credit_rules` switch is off everywhere, so nothing reads the table before
 * its migration; with the switch on and the table missing they answer 503.
 *
 * The actor is always `@CurrentAdmin().id`; no body field names an admin.
 */
@Controller("admin")
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminCreditRulesController {
  constructor(private readonly rules: CreditRulesService) {}

  @Get("credit-rules")
  @RequireAdminRole("manage_credit_rules")
  async getCreditRules(): Promise<AdminCreditRulesResponse> {
    this.rules.assertLive();
    return toResponse(await this.rules.readForAdmin());
  }

  @Put("credit-rules")
  @HttpCode(200)
  @RequireAdminRole("manage_credit_rules")
  async updateCreditRules(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body(new ZodValidationPipe(AdminUpdateCreditRulesSchema)) dto: AdminUpdateCreditRulesDto,
    @Ctx() ctx: RequestContext,
  ): Promise<AdminUpdateCreditRulesResponse> {
    this.rules.assertLive();
    const result = await this.rules.update(
      admin.id,
      { rules: dto.rules, expectedRevision: dto.expected_revision, reasonText: dto.reason_text },
      ctx,
    );
    return { ...toResponse(result), changed: result.changed, changed_keys: result.changedKeys };
  }
}
