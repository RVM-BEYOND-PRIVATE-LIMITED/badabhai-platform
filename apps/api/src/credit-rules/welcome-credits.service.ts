import { Injectable, Logger } from "@nestjs/common";
import type { PayloadInputOf, WELCOME_CREDITS_TRIGGERS } from "@badabhai/event-schema";
import { sqlStateOf } from "../common/db-error";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { FeatureRolloutService } from "../feature-rollout/feature-rollout.service";
import { isBarredPayerStatus } from "../payers/payer-barred-status";
import { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import type { TenantKey } from "../payers/payer-tenant-scope";
import { CreditRulesService } from "./credit-rules.service";
import {
  WelcomeCreditsRepository,
  type WelcomeEligibilityFacts,
} from "./welcome-credits.repository";

export type WelcomeCreditsTrigger = (typeof WELCOME_CREDITS_TRIGGERS)[number];

/** What one call did. Logged; never sent to a client. */
export type WelcomeCreditsOutcome =
  | "granted"
  | "already_granted"
  | "no_tenant"
  | "rules_off"
  | "zero_credits"
  | "not_eligible"
  | "failed";

/** Why a company is not (yet) eligible. Ids and codes only. */
export type WelcomeIneligibility =
  | "no_company"
  | "barred"
  | "not_approved"
  | "no_gst_or_proven_phone"
  | "no_approved_posting";

/**
 * #2750 item 4 (brief 4C.6, B2-20, B2-21, B4C-11, B7-04 to B7-07) — the WELCOME RULE: the first
 * time a company is VERIFIED AND has an APPROVED posting, it receives `welcomeCredits` (5), valid
 * `welcomeValidityDays` (30), ONCE, ever. Unused ones expire with an `expired` ledger line (the
 * #2749 sweep and spend path).
 *
 * VERIFIED (B7-06, the #2750 default): the admin approved the company record
 * (`verification_status = 'verified'`, employer or agency) AND it has a GSTIN on file OR a proven
 * phone (#2754 item 3's `payer_phone_proofs`, the account's CURRENT phone). An agency or contractor
 * account qualifies on the same rule (#2750 question 4's default). A suspended or archived company
 * never does. Owner ruling 2026-11-17: EVERY verified company, whatever old sign-up credits it
 * holds.
 *
 * ONE GRANT FUNCTION, every trigger (#2750 item 4): an admin or ops posting approval, an admin
 * edit of the company record, and the Campus company move (#2754, `company_import`). Each is
 * idempotent: the grant is keyed on the company, so a second trigger changes nothing.
 *
 * NEVER FAILS ITS CALLER. Each trigger calls it AFTER its own write committed; an error here is
 * logged (ids and the SQLSTATE) and the approval stands. The next trigger for the company retries.
 *
 * BEHIND THE `credit_rules` SWITCH, per company. Off, nothing is read or written: the signup grant
 * (`FreeTierService`) stays as it is until the owner retires it (publish `freeUnlockCredits: 0`).
 */
@Injectable()
export class WelcomeCreditsService {
  private readonly logger = new Logger(WelcomeCreditsService.name);

  constructor(
    private readonly repo: WelcomeCreditsRepository,
    private readonly rules: CreditRulesService,
    private readonly rollout: FeatureRolloutService,
    private readonly tenancy: PayerTenantScopeService,
    private readonly events: EventsService,
  ) {}

  /**
   * After a posting (or an agency job) was approved. `ownerPayerId` is the posting's stored
   * owner; its company is resolved read-only (no tenancy row is ever written for it here).
   */
  async afterPostingApproved(
    ownerPayerId: string,
    ctx: RequestContext,
  ): Promise<WelcomeCreditsOutcome> {
    return this.grantIfEligible(ownerPayerId, "posting_approved", ctx);
  }

  /** After an admin edited a company record (its approval or GSTIN may have made it eligible). */
  async afterCompanyUpdated(
    companyId: string,
    ctx: RequestContext,
  ): Promise<WelcomeCreditsOutcome> {
    return this.grantIfEligible(companyId, "company_updated", ctx);
  }

  /** The Campus company move (#2754): a moved company that is already eligible gets them now. */
  async afterCompanyImported(
    companyId: string,
    ctx: RequestContext,
  ): Promise<WelcomeCreditsOutcome> {
    return this.grantIfEligible(companyId, "company_import", ctx);
  }

  /** The rule, pure: eligible, or the first missing condition. */
  static ineligibility(facts: WelcomeEligibilityFacts): WelcomeIneligibility | null {
    if (facts.role === null) return "no_company";
    if (facts.status === null || isBarredPayerStatus(facts.status)) return "barred";
    if (facts.verificationStatus !== "verified") return "not_approved";
    if (!facts.hasGstNumber && !facts.phoneProven) return "no_gst_or_proven_phone";
    if (!facts.hasApprovedPosting) return "no_approved_posting";
    return null;
  }

  private async grantIfEligible(
    payerId: string,
    trigger: WelcomeCreditsTrigger,
    ctx: RequestContext,
  ): Promise<WelcomeCreditsOutcome> {
    try {
      const scope = await this.tenancy.resolveReadOnly(payerId);
      if (scope === null) return this.done("no_tenant", payerId, trigger);
      const tenant = scope.tenantKey;
      if ((await this.rollout.stateFor("credit_rules", tenant)) !== "on") {
        return "rules_off";
      }
      const rules = await this.rules.get();
      if (rules.welcomeCredits <= 0) return this.done("zero_credits", tenant, trigger);

      const missing = WelcomeCreditsService.ineligibility(await this.repo.eligibility(tenant));
      if (missing !== null) return this.done("not_eligible", tenant, trigger, missing);

      const expiresAt = new Date(Date.now() + rules.welcomeValidityDays * 86_400_000);
      const result = await this.repo.grantOnce(
        tenant,
        { credits: rules.welcomeCredits, expiresAt },
        (tx, lotId) =>
          this.emitGranted(tx, tenant, lotId, rules.welcomeCredits, expiresAt, trigger, ctx),
      );
      return this.done(result.applied ? "granted" : "already_granted", tenant, trigger);
    } catch (err) {
      this.logger.error(
        `welcome credits failed for payer=${payerId} trigger=${trigger} (sqlstate=${sqlStateOf(err) ?? "none"}); the next trigger retries`,
      );
      return "failed";
    }
  }

  private done(
    outcome: WelcomeCreditsOutcome,
    who: string,
    trigger: WelcomeCreditsTrigger,
    why?: WelcomeIneligibility,
  ): WelcomeCreditsOutcome {
    this.logger.log(
      `welcome credits ${outcome} payer=${who} trigger=${trigger}${why ? ` missing=${why}` : ""}`,
    );
    return outcome;
  }

  private async emitGranted(
    tx: Parameters<Parameters<WelcomeCreditsRepository["grantOnce"]>[2]>[0],
    tenant: TenantKey,
    lotId: string,
    credits: number,
    expiresAt: Date,
    trigger: WelcomeCreditsTrigger,
    ctx: RequestContext,
  ): Promise<void> {
    const payload: PayloadInputOf<"payer.welcome_credits_granted"> = {
      payer_id: tenant,
      lot_id: lotId,
      credits,
      expires_at: expiresAt.toISOString(),
      trigger,
    };
    await this.events.emit({
      event_name: "payer.welcome_credits_granted",
      actor: { actor_type: "system", actor_id: null },
      subject: { subject_type: "payer", subject_id: tenant },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
      idempotencyKey: `payer.welcome_credits_granted:${tenant}`,
      tx,
    });
  }
}
