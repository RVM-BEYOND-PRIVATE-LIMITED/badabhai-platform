import { ForbiddenException, Inject, Injectable, Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { PayerOrgsRepository, type ResolvedOrg } from "./payer-orgs.repository";
import {
  chooseActingOrg,
  type ActingOrgChoice,
  type ActiveMembershipFacts,
  type PayerOrgTenancyMode,
  type PayerTenantScope,
  type TenancyDenial,
  type TenantKey,
} from "./payer-tenant-scope";

/** The one body every tenancy refusal returns: no rule name, no org id (no oracle). */
export const TENANCY_DENIED_MESSAGE = "Not permitted for this organization";

/** {@link PayerTenantScopeService.resolveSelfView}: the self-view's org and tenant key. */
export interface PayerSelfTenancy {
  /** The acting org and the payer's role in it; `null` with no active membership or on a denial. */
  readonly org: ResolvedOrg | null;
  /** The tenant the payer acts for (the actor itself in `off`); `null` only on an `on` denial. */
  readonly tenantKey: TenantKey | null;
}

/**
 * ADR-0053 (PAY-DB-01) — THE payer tenant resolver.
 *
 * The only reader of `PAYER_ORG_TENANCY_MODE` (a static test pins it). Everything that asks
 * "which org does this payer act in" comes here, so the Team page, the session org claim,
 * `GET /payer/me` and — from Phase 2 — every tenant-row predicate share one answer.
 *
 * Two entry points, one decision ({@link chooseActingOrg}):
 *  - {@link resolve} — the tenant-route entry point (Phase 2 wires it into the services, and
 *    `PayerOrgRoleGuard` calls it once and hands the scope on — §5.2 rule 1 as amended). Returns
 *    the {@link PayerTenantScope} whose branded `tenantKey` the repositories will accept.
 *    `off`/`shadow` never fail a request: the key is the actor, whatever the membership read
 *    does. `on` fails closed: any denial or resolve error is a neutral 403 (R7).
 *  - {@link resolveActingOrg} — the org only, for the callers that existed before this ADR
 *    (the session claim, login). A denial is `null`
 *    (no org); a read error propagates, as it did when those callers read the repository
 *    themselves, so each keeps its own error handling unchanged.
 *  - {@link resolveSelfView} — `GET`/`PATCH /payer/me`: the same org PLUS the tenant key whose
 *    org name a posting carries (O-10), from the same single read; a denial is all-`null`.
 *
 * In Phase 1 no tenant predicate reads the scope yet, so `on` changes only which org those
 * four callers report for a team member (R2: the team org, not the most recent membership).
 *
 * `shadow` serves `off` and, on the same membership read, also decides `on` and logs it —
 * ids and enums only, no heal, never thrown. That log is the evidence for arming `on` (ADR §5.3).
 */
@Injectable()
export class PayerTenantScopeService {
  private readonly logger = new Logger(PayerTenantScopeService.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly orgs: PayerOrgsRepository,
  ) {}

  /** The configured mode. The ONE read of PAYER_ORG_TENANCY_MODE in the codebase. */
  private mode(): PayerOrgTenancyMode {
    return this.config.PAYER_ORG_TENANCY_MODE;
  }

  /** The tenant scope for one request. Resolve once at the service entry point; pass it down. */
  async resolve(actorPayerId: string): Promise<PayerTenantScope> {
    const mode = this.mode();
    if (mode !== "on") {
      try {
        return await this.servedWithoutTenancy(actorPayerId, mode);
      } catch {
        // `off` never fails a request: the key is the actor whatever the membership read did.
        this.logger.warn(
          `payer tenancy: membership read failed (mode=${mode} actor=${actorPayerId})`,
        );
        return this.expectResolved(chooseActingOrg([], actorPayerId, mode));
      }
    }

    let choice: ActingOrgChoice;
    try {
      choice = await this.decideOn(actorPayerId);
    } catch {
      // R7: a resolve error is a 403, never an allow.
      this.logger.error(`payer tenancy: resolve failed (actor=${actorPayerId})`);
      throw new ForbiddenException(TENANCY_DENIED_MESSAGE);
    }
    if (choice.kind !== "resolved") {
      this.logDenial(actorPayerId, choice.kind === "denied" ? choice.reason : "no_membership");
      throw new ForbiddenException(TENANCY_DENIED_MESSAGE);
    }
    return choice.scope;
  }

  /**
   * The org the payer acts in and their role in it, or `null` when there is none (no active
   * membership, or an `on` denial). Same decision as {@link resolve}.
   */
  async resolveActingOrg(actorPayerId: string): Promise<ResolvedOrg | null> {
    return (await this.resolveSelfView(actorPayerId)).org;
  }

  /**
   * `GET`/`PATCH /payer/me`'s view of the payer's tenancy, from ONE membership read and the same
   * decision as {@link resolve}: the acting org (as {@link resolveActingOrg}) and the TENANT KEY
   * whose org name a posting the payer publishes carries (O-10, the form's `org_label` prefill).
   * Never a 403 — the account page must load for a payer tenancy refuses: an `on` denial is
   * `{ org: null, tenantKey: null }` (logged, as every denial). A read error propagates, as it
   * always has for these callers.
   */
  async resolveSelfView(actorPayerId: string): Promise<PayerSelfTenancy> {
    const mode = this.mode();
    if (mode !== "on") {
      const scope = await this.servedWithoutTenancy(actorPayerId, mode);
      return { org: toResolvedOrg(scope), tenantKey: scope.tenantKey };
    }

    const choice = await this.decideOn(actorPayerId);
    if (choice.kind === "resolved") {
      return { org: toResolvedOrg(choice.scope), tenantKey: choice.scope.tenantKey };
    }
    this.logDenial(actorPayerId, choice.kind === "denied" ? choice.reason : "no_membership");
    return { org: null, tenantKey: null };
  }

  /**
   * LOGIN's entry point: the acting org, healing a payer who has NO membership at all with their
   * solo org — exactly once, in every mode (review L1). `on` already heals inside the decision
   * (R4) and never heals a payer who is merely denied (a heal cannot fix a denial). `off`/`shadow`
   * never heal on their own (the guard and the claim must not write), so this heals once there.
   */
  async ensureActingOrg(actorPayerId: string): Promise<ResolvedOrg | null> {
    if (this.mode() === "on") return this.resolveActingOrg(actorPayerId);
    const existing = await this.resolveActingOrg(actorPayerId);
    if (existing) return existing;
    await this.orgs.ensureSoloOrg(actorPayerId);
    return this.resolveActingOrg(actorPayerId);
  }

  /** `off`/`shadow`: serve the pre-ADR answer; in `shadow`, also log what `on` would decide. */
  private async servedWithoutTenancy(
    actorPayerId: string,
    mode: Exclude<PayerOrgTenancyMode, "on">,
  ): Promise<PayerTenantScope> {
    const startedAt = Date.now();
    const memberships = await this.orgs.listActiveMembershipsWithAnchor(actorPayerId);
    const served = this.expectResolved(chooseActingOrg(memberships, actorPayerId, mode));
    if (mode === "shadow") this.logShadow(actorPayerId, memberships, startedAt);
    return served;
  }

  /** `on`: decide; with no membership at all, heal the solo org once (R4) and decide again. */
  private async decideOn(actorPayerId: string): Promise<ActingOrgChoice> {
    const first = chooseActingOrg(
      await this.orgs.listActiveMembershipsWithAnchor(actorPayerId),
      actorPayerId,
      "on",
    );
    if (first.kind !== "no_membership") return first;
    await this.orgs.ensureSoloOrg(actorPayerId);
    return chooseActingOrg(
      await this.orgs.listActiveMembershipsWithAnchor(actorPayerId),
      actorPayerId,
      "on",
    );
  }

  /**
   * One line per shadow resolution: `{actor, would_key, would_differ, outcome, ms}` (ADR §5.3).
   * Opaque ids and enums only. Never heals (a shadow read must not write) and never throws.
   */
  private logShadow(
    actorPayerId: string,
    memberships: readonly ActiveMembershipFacts[],
    startedAt: number,
  ): void {
    try {
      const wouldBe = chooseActingOrg(memberships, actorPayerId, "on");
      const wouldKey = wouldBe.kind === "resolved" ? wouldBe.scope.tenantKey : "-";
      const outcome =
        wouldBe.kind === "resolved"
          ? "resolved"
          : wouldBe.kind === "denied"
            ? wouldBe.reason
            : "would_heal";
      this.logger.log(
        `payer tenancy shadow: actor=${actorPayerId} would_key=${wouldKey} ` +
          `would_differ=${wouldBe.kind === "resolved" && wouldKey !== actorPayerId} ` +
          `outcome=${outcome} ms=${Date.now() - startedAt}`,
      );
    } catch {
      this.logger.warn(`payer tenancy shadow: evaluation failed (actor=${actorPayerId})`);
    }
  }

  /** R3 is an error log (an invariant breach the census must find); the others are warnings. */
  private logDenial(actorPayerId: string, reason: TenancyDenial): void {
    const line = `payer tenancy denied: reason=${reason} actor=${actorPayerId}`;
    if (reason === "multiple_team_memberships") this.logger.error(line);
    else this.logger.warn(line);
  }

  /** `off`/`shadow` always resolve; anything else is a defect in {@link chooseActingOrg}. */
  private expectResolved(choice: ActingOrgChoice): PayerTenantScope {
    if (choice.kind !== "resolved") throw new Error("payer tenancy: off/shadow must resolve");
    return choice.scope;
  }
}

function toResolvedOrg(scope: PayerTenantScope): ResolvedOrg | null {
  return scope.orgId !== null && scope.orgRole !== null
    ? { orgId: scope.orgId, orgRole: scope.orgRole }
    : null;
}
