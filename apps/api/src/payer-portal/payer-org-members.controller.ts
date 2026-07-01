import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { PayerAuthGuard, CurrentPayer, type AuthenticatedPayer } from "../payers/payer-auth.guard";
import {
  PayerOrgRoleGuard,
  OrgRoles,
  CurrentOrg,
  type PayerOrgContext,
} from "../payers/payer-org-role.guard";
import { PayerOrgMembersService } from "./payer-org-members.service";
import { InviteMemberSchema, type InviteMemberDto } from "./payer-org-members.dto";

/**
 * Payer org member management (ADR-0027 / B5.3) — the backend the payer-web `team/` page
 * wires to. Route group `/payer/org/members`, behind {@link PayerAuthGuard} +
 * {@link PayerOrgRoleGuard}: the guard resolves the caller's org (`@CurrentOrg`) and, on the
 * write routes, enforces `@OrgRoles("owner")`. Reads are open to any org member. The org is
 * ALWAYS the caller's resolved org — never a body/param value (XB-A) — so a payer can only
 * ever see/mutate THEIR OWN org's members. Faceless: emails are masked in responses, and
 * every event is PII-free. MOCK invites (no real send in B5.3).
 */
@Controller("payer/org/members")
@UseGuards(PayerAuthGuard, PayerOrgRoleGuard)
export class PayerOrgMembersController {
  constructor(private readonly members: PayerOrgMembersService) {}

  /** List the caller's OWN org members (masked). Any org member may read. */
  @Get()
  list(@CurrentOrg() org: PayerOrgContext, @CurrentPayer() payer: AuthenticatedPayer) {
    return this.members.list(org, payer.id);
  }

  /** Invite a teammate to the caller's org (OWNER only). `org_id`/`invited_by` from the session. */
  @Post()
  @OrgRoles("owner")
  @HttpCode(201)
  invite(
    @Body(new ZodValidationPipe(InviteMemberSchema)) dto: InviteMemberDto,
    @CurrentOrg() org: PayerOrgContext,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ) {
    return this.members.invite(org, payer.id, dto, ctx);
  }

  /** Remove a teammate from the caller's org (OWNER only; soft-delete, no-oracle 404). */
  @Delete(":id")
  @OrgRoles("owner")
  @HttpCode(200)
  remove(
    @Param("id", new ParseUUIDPipe()) id: string,
    @CurrentOrg() org: PayerOrgContext,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ) {
    return this.members.remove(org, payer.id, id, ctx);
  }
}
