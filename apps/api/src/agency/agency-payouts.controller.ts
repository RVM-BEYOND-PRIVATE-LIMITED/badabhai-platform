import { Body, Controller, Get, HttpCode, Post, UseGuards } from "@nestjs/common";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { PayerAuthGuard, CurrentPayer, type AuthenticatedPayer } from "../payers/payer-auth.guard";
import { PayerRoleGuard, PayerRoles } from "../payers/payer-role.guard";
import { OrgRoles, PayerOrgRoleGuard } from "../payers/payer-org-role.guard";
import { AgencyKycService } from "./agency-kyc.service";
import { AgencyPayoutService } from "./agency-payout.service";
import { AgencyPayoutsEnabledGuard } from "./agency-payouts-enabled.guard";
import { SubmitAgencyKycSchema, type SubmitAgencyKycDto } from "./agency-kyc.dto";

/**
 * Agency SUPPLY-MONEY surface (ADR-0022 Amendment 2) — KYC + earnings + payout requests.
 *
 * RBAC: EVERY route is agent-only — `PayerAuthGuard` (authn) + `PayerRoleGuard` +
 * `@PayerRoles('agent')` (an employer token → 403) — and behind `AgencyPayoutsEnabledGuard`
 * (a NEUTRAL 404 while `AGENCY_PAYOUTS_ENABLED` is OFF, so the whole surface is inert by
 * default and no financial PII is collected). The acting agency is ALWAYS the verified SESSION
 * payer (`@CurrentPayer().id`, XB-A) — never a body/param, so a caller can only ever act on
 * their OWN org's KYC / earnings / payouts. All money is MOCK (no real disbursement).
 *
 * OWNER-ONLY (ADR-0053 owner ruling O-5): agency KYC, earnings and payouts are ORG-level, and
 * only the org's OWNER may reach them — `PayerOrgRoleGuard` + `@OrgRoles("owner")`, the same
 * gate as team management, deciding on the same acting org the tenant scope keys by. A
 * recruiter member gets that guard's neutral 403; a payer with no org membership gets its 403
 * too (fail closed). The ORDER is the control: the flag gate runs BEFORE the org-role gate, so
 * while `AGENCY_PAYOUTS_ENABLED` is off every caller — owner or recruiter — gets the SAME 404
 * and the surface is no org-role oracle (pinned in guard-contract.test.ts). The services key
 * every row by the session payer's TENANT key, resolving it once at their entry point (ADR-0053
 * §5.2) — so a request here makes two membership reads, the guard's and the service's. Accepted
 * on this low-frequency, flag-gated surface (ADR-0053 §5.4 budgets the tenant routes' p95).
 */
@Controller("payer/agency")
@UseGuards(PayerAuthGuard, PayerRoleGuard, AgencyPayoutsEnabledGuard, PayerOrgRoleGuard)
@PayerRoles("agent")
@OrgRoles("owner")
export class AgencyPayoutsController {
  constructor(
    private readonly kyc: AgencyKycService,
    private readonly payouts: AgencyPayoutService,
  ) {}

  /** Submit/replace KYC (PAN + bank, encrypted at rest → pending). Returns the MASKED view. */
  @Post("kyc")
  @HttpCode(201)
  submitKyc(
    @Body(new ZodValidationPipe(SubmitAgencyKycSchema)) dto: SubmitAgencyKycDto,
    @CurrentPayer() payer: AuthenticatedPayer,
  ) {
    return this.kyc.submit(payer.id, dto);
  }

  /** The agency org's OWN KYC status — masked (last-4 only). */
  @Get("kyc")
  getKyc(@CurrentPayer() payer: AuthenticatedPayer) {
    return this.kyc.getOwnView(payer.id);
  }

  /** Earnings/commission analytics off REAL accrual data + the gate state. */
  @Get("earnings")
  getEarnings(@CurrentPayer() payer: AuthenticatedPayer) {
    return this.payouts.getEarnings(payer.id);
  }

  /**
   * Request a payout of the currently-requestable accruals. The GATE (verified KYC + ≥ ₹
   * threshold) runs in the service; a refusal returns `{ ok:false, blocked:true, reason }`
   * (200) and changes nothing, a pass returns `{ ok:true, requestId, amountInr, accrualCount }`.
   * MOCK — no real money moves.
   */
  @Post("payouts")
  @HttpCode(200)
  requestPayout(@CurrentPayer() payer: AuthenticatedPayer) {
    return this.payouts.requestPayout(payer.id);
  }

  /** The agency org's OWN payout request history (ids / ₹ / status). */
  @Get("payouts")
  async listPayouts(@CurrentPayer() payer: AuthenticatedPayer) {
    const rows = await this.payouts.listRequests(payer.id);
    return rows.map((r) => ({
      id: r.id,
      amountInr: r.amountInr,
      accrualCount: r.accrualCount,
      status: r.status,
      createdAt: r.createdAt,
    }));
  }
}
