import { Controller, Get, Header, Param, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { AdminAuthGuard, CurrentAdmin, type AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "./admin-roles.guard";
import { AdminCandidateDetailService } from "./admin-candidate-detail.service";
import {
  AdminCandidateParamsSchema,
  type AdminCandidateParamsDto,
} from "./admin-candidate-detail.dto";

/**
 * The Candidates FULL-DETAIL read (ADR-0062, #2560): one worker's record exactly as employers and
 * the résumé read it, each field's source, the résumé versions and the account state.
 *
 * RBAC: `AdminAuthGuard` + `AdminRolesGuard`, and exactly one method-level
 * `@RequireAdminRole("read_candidates")` (ADR-0062 §3.8 — all four roles). The NAME on the
 * response is additive and gated inside `AdminIdentityService` on `read_identity`, so an analyst
 * gets the same record with `name: null` rather than a 403.
 *
 * `Cache-Control: no-store` UNCONDITIONALLY: the body may carry a decrypted name and, for an
 * `edit_candidates` holder, the gated `correction_values` prefill (which may carry an employer
 * name or a certificate licence number). A header that varied with the caller's capabilities
 * would leak whether they hold those grants.
 *
 * HTTP only: the worker id comes from the validated path, the admin from the session the guard
 * resolved, and everything else is the service's.
 */
@Controller("admin")
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminCandidateDetailController {
  constructor(private readonly service: AdminCandidateDetailService) {}

  @Get("candidates/:id")
  @Header("Cache-Control", "no-store")
  @RequireAdminRole("read_candidates")
  getCandidate(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminCandidateParamsSchema)) params: AdminCandidateParamsDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.getCandidate(admin, params.id, ctx);
  }
}
