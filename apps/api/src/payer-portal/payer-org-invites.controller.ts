import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { PayerAuthGuard, CurrentPayer, type AuthenticatedPayer } from "../payers/payer-auth.guard";
import { PayerOrgMembersService } from "./payer-org-members.service";
import { AcceptInviteSchema, type AcceptInviteDto } from "./payer-org-members.dto";

/**
 * Payer org invite ACCEPT (ADR-0027 / B5.4). Route `POST /payer/org/invites/accept`, behind
 * {@link PayerAuthGuard} ONLY — DISTINCT from the owner-scoped member-management routes
 * ({@link import("./payer-org-members.controller").PayerOrgMembersController}, which also apply
 * {@link import("../payers/payer-org-role.guard").PayerOrgRoleGuard}). Accepting an invite
 * crosses INTO the inviting org, so the caller is NOT yet an org-role principal there — the org
 * is resolved from the single-use token, and the accept is bound to the caller's verified
 * identity in the service (not a body value, XB-A). The body carries only the raw token.
 */
@Controller("payer/org/invites")
@UseGuards(PayerAuthGuard)
export class PayerOrgInvitesController {
  constructor(private readonly members: PayerOrgMembersService) {}

  /** Accept a teammate invite with the single-use token from the accept link. */
  @Post("accept")
  @HttpCode(200)
  accept(
    @Body(new ZodValidationPipe(AcceptInviteSchema)) dto: AcceptInviteDto,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ) {
    return this.members.accept(payer.id, dto, ctx);
  }
}
