import { Controller, Get, Inject, UseGuards } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { PayerAuthGuard, CurrentPayer, type AuthenticatedPayer } from "../payers/payer-auth.guard";
import { PayerRoleGuard, PayerRoles } from "../payers/payer-role.guard";
import { PayerDisclosureRateLimit } from "../payers/payer-disclosure-rate-limit.service";
import { AgencyWorkersService, type AgencyWorkerView } from "./agency-workers.service";

/**
 * B5 — the agency's ENGAGEMENT view of the workers it referred (ADR-0022 portal).
 *
 * Agent-only, session-scoped (XB-A): the `inviter_payer_id` is the verified session
 * payer and appears nowhere in the route, the query or a body. There is deliberately
 * NO parameterised variant — an agency cannot ask about another agency's referrals
 * because there is nothing to ask WITH.
 *
 * SCRAPE BOUND: rides the same per-payer hourly cap as the other disclosure-adjacent
 * reads. This list is faceless, but it is still a per-person view of real workers, and
 * an unbounded poll of it over time is a behavioural dataset. Fail-closed.
 *
 * NO EVENT: a dashboard read changes nothing (see the service). The agency's actual
 * decisions are evented where they are taken.
 */
@Controller("payer/agency")
@UseGuards(PayerAuthGuard, PayerRoleGuard)
@PayerRoles("agent")
export class AgencyWorkersController {
  constructor(
    private readonly workers: AgencyWorkersService,
    private readonly rateLimit: PayerDisclosureRateLimit,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  /**
   * The referred workers who CONSENTED to their referring agent seeing their
   * activity. Everyone else is absent — and absent identically to "never referred",
   * so the list is not a consent oracle either.
   */
  @Get("workers")
  async listReferred(
    @CurrentPayer() payer: AuthenticatedPayer,
  ): Promise<{ workers: AgencyWorkerView[] }> {
    await this.rateLimit.assertWithinHourlyCap(payer.id, {
      scope: "payer_reach",
      cap: this.config.PAYER_REACH_MAX_PER_HOUR,
    });
    return this.workers.listReferred(payer.id);
  }
}
