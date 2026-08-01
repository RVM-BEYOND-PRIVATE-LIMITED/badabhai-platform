import { Body, Controller, Get, HttpCode, Inject, Param, Post, UseGuards } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { PayerAuthGuard, CurrentPayer, type AuthenticatedPayer } from "../payers/payer-auth.guard";
import { PayerRoleGuard, PayerRoles } from "../payers/payer-role.guard";
import { PayerDisclosureRateLimit } from "../payers/payer-disclosure-rate-limit.service";
import { AgencyService } from "./agency.service";
import {
  CreateAgencyInviteSchema,
  CreateAgencyInviteBatchSchema,
  AgencyInviteCodeParamSchema,
  type CreateAgencyInviteDto,
  type CreateAgencyInviteBatchDto,
} from "./agency.dto";

/**
 * Agency Supply Portal — INVITE mint/click + the read-only referrals SUMMARY (ADR-0022).
 * Every route is agent-only (`@UseGuards(PayerAuthGuard, PayerRoleGuard)` +
 * `@PayerRoles('agent')`), one principal per route. The owning `inviter_payer_id` is the
 * verified SESSION payer (XB-A) — never a body/param.
 *
 * FACELESS: mint takes NO phone/name/email/worker-id (only an optional non-PII campaign
 * tag) and returns an opaque code only. There is deliberately NO agency-facing endpoint
 * that accepts a worker id — attribution is the consent-gated INTERNAL seam
 * ({@link AgencyService.attributeWorkerToInvite}), INTENDED to be invoked from the worker
 * consent path. That wiring is a tracked fast-follow; until it lands the seam has no
 * caller, so no attribution occurs (fail-safe — it is exported but inert).
 *
 * The summary is AGGREGATE-ONLY with a k-anon floor (no consent oracle). Mock + staging-
 * only (ADR-0022 Phase 1).
 */
@Controller("payer/agency")
@UseGuards(PayerAuthGuard, PayerRoleGuard)
@PayerRoles("agent")
export class AgencyInvitesController {
  constructor(
    private readonly agency: AgencyService,
    private readonly rateLimit: PayerDisclosureRateLimit,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  /**
   * Mint an OWN opaque invite code. Enforces the per-payer INVITE-MINT CAP (ADR-0022
   * security condition) via {@link PayerDisclosureRateLimit} on a dedicated scope, FAIL
   * CLOSED (a Redis outage rejects). Emits agency_invite.created. Returns the code only.
   */
  @Post("invites")
  @HttpCode(201)
  async createInvite(
    @Body(new ZodValidationPipe(CreateAgencyInviteSchema)) dto: CreateAgencyInviteDto,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ) {
    await this.rateLimit.assertWithinHourlyCap(payer.id, {
      scope: "agency_invite_mint",
      cap: this.config.AGENCY_INVITE_MINT_MAX_PER_HOUR,
    });
    return this.agency.createInvite(payer.id, dto.campaign, ctx);
  }

  /**
   * BATCH mint (ADR-0022 Amendment 3) — mint `count` OWNED opaque invite codes at once.
   *
   * NOT the DEAD module-2 bulk upload. The difference is the DIRECTION and REFERENT of the
   * data, not the count: bulk upload is INBOUND and has ARITY OVER PEOPLE (the agency
   * asserts a list of real, non-consented individuals and the platform ingests contactable
   * identifiers for them); this is OUTBOUND generation of REFERENT-FREE bearer tokens whose
   * request body is a SCALAR CARDINALITY. `CreateAgencyInviteBatchSchema` is `.strict()`
   * and contains no array-typed property, which is what carries that distinction — see the
   * long note there before adding ANY field here.
   *
   * NO DELIVERY: this endpoint accepts no phone/email/recipient and sends nothing. Sharing
   * the links is out-of-band, by the agency. That is a permanent boundary, not a deferral —
   * the moment the platform delivers, it must be told WHERE, and that IS module 2.
   *
   * CAP: charges `count` units of the SAME `agency_invite_mint` bucket the singular mint
   * uses (one atomic reservation, up front, fail-closed) — so a batch of N and N single
   * mints are indistinguishable to the counter, and alternating between the two paths buys
   * nothing. A batch that would cross the cap mints ZERO invites and emits ZERO events, and
   * returns the same neutral 429 as the singular mint (cap-reached and Redis-down are
   * deliberately indistinguishable — no infrastructure-state probe).
   */
  @Post("invites/batch")
  @HttpCode(201)
  async createInviteBatch(
    @Body(new ZodValidationPipe(CreateAgencyInviteBatchSchema)) dto: CreateAgencyInviteBatchDto,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ) {
    await this.rateLimit.assertWithinHourlyCap(payer.id, {
      scope: "agency_invite_mint",
      cap: this.config.AGENCY_INVITE_MINT_MAX_PER_HOUR,
      amount: dto.count,
    });
    return this.agency.createInviteBatch(payer.id, dto.count, dto.campaign, ctx);
  }

  /**
   * Agency-scoped MOCK recording of an attribution click (created -> clicked). This is
   * agent-only (the class guards apply) — it is the agency's own funnel-state stub, NOT the
   * public invitee-facing click. The real invitee click funnel is the existing PUBLIC
   * ADR-0020 endpoint `POST /invites/:code/click` (messaging.controller). Neutral/no-op on an
   * unknown code (no-oracle); carries no PII; does NOT attribute a worker (that is the
   * consent-gated internal seam).
   */
  @Post("invites/:code/click")
  @HttpCode(200)
  recordClick(
    @Param(new ZodValidationPipe(AgencyInviteCodeParamSchema)) params: { code: string },
  ) {
    return this.agency.recordInviteClick(params.code);
  }

  /**
   * The agency's OWN funnel counts by stage (created/clicked/accepted), scoped by the
   * SESSION `inviter_payer_id`. AGGREGATE-ONLY with a k-anon floor — counts below the floor
   * are suppressed so a single named invitee's consent can never be inferred (no oracle).
   */
  @Get("referrals/summary")
  referralsSummary(@CurrentPayer() payer: AuthenticatedPayer) {
    return this.agency.referralsSummary(payer.id);
  }
}
