import { Injectable } from "@nestjs/common";
import type { RequestContext } from "../common/request-context";
import { JobPostingsService } from "../job-postings/job-postings.service";
import type { JobPostingApi } from "../job-postings/job-postings.repository";
import type { ListJobPostingsQueryDto } from "../job-postings/job-postings.dto";
import {
  PostingPlansService,
  type BuyBoostResult,
  type BuyPlanResult,
  type PostingStats,
  type TopUpQuotaResult,
} from "../posting-plans/posting-plans.service";
import type {
  PayerBuyBoostDto,
  PayerBuyPlanDto,
  PayerTopUpQuotaDto,
} from "../posting-plans/posting-plans.dto";
import { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";

/** One of the tenant's postings with its plan / boost stats, read in ONE tenant resolution. */
export interface PostingWithStats {
  readonly posting: JobPostingApi;
  readonly stats: PostingStats;
}

/**
 * The three paid actions on ONE posting the caller's tenant owns, bound to the scope its
 * ownership was checked in. Holding one is proof the ownership check passed; it cannot be built
 * any other way, and it carries no id a caller could swap.
 */
export interface OwnedPostingPurchases {
  readonly buyPlan: (dto: PayerBuyPlanDto, ctx: RequestContext) => Promise<BuyPlanResult>;
  readonly buyBoost: (dto: PayerBuyBoostDto, ctx: RequestContext) => Promise<BuyBoostResult>;
  readonly topUpQuota: (dto: PayerTopUpQuotaDto, ctx: RequestContext) => Promise<TopUpQuotaResult>;
}

/**
 * ADR-0053 (PAY-DB-01) P2c — the payer posting surface's ONE seam onto plans, boosts, quota
 * top-ups and their per-posting stats. Each entry point resolves the SESSION payer's tenancy
 * exactly once (§5.2 rule 1) and uses that one scope for every read and write after it.
 *
 * WHY A SEAM AND NOT TWO CALLS (review of PR #2167, plan §3.1 "split purchase"). The plan, boost
 * and quota-top-up routes check posting ownership and then purchase. Done as two independent
 * service calls, each resolves on its own: the ownership read is the ORG's (P2a), and a purchase
 * keyed some other way would buy under a different tenant from the one that passed the check.
 * {@link forOwnedPosting} resolves once, checks ownership in that scope (the no-oracle 404 an
 * unknown or foreign id gets), and returns the purchases bound to THAT scope — the controller
 * cannot pair one route's check with another scope's purchase.
 *
 * The ownership check runs BEFORE the controller's idempotency reservation (a foreign or unknown
 * id still mints no Redis key, #2085/#2103), and the purchase runs inside it; the handle carries
 * the scope across, so nothing re-resolves.
 *
 * The postings list and the single read go through here too ({@link listWithStats},
 * {@link getOneWithStats}): their stats are read with the tenant key the posting read used, so
 * `GET /payer/job-postings` resolves once, not once per posting (§5.4; plan §3.1 "N+1" hazard).
 *
 * In mode `off` the tenant is the session payer, so every read and stamp is today's.
 */
@Injectable()
export class PayerPostingPlansService {
  constructor(
    private readonly jobPostings: JobPostingsService,
    private readonly plans: PostingPlansService,
    // ADR-0053 — the payer tenant resolver (PayersModule).
    private readonly tenancy: PayerTenantScopeService,
  ) {}

  /**
   * Resolve once, assert the tenant owns `jobPostingId` (the SAME neutral 404 for an unknown or
   * another tenant's posting), and return the paid actions bound to that scope.
   */
  async forOwnedPosting(jobPostingId: string, actorPayerId: string): Promise<OwnedPostingPurchases> {
    const scope = await this.tenancy.resolve(actorPayerId);
    await this.jobPostings.getOneInScope(jobPostingId, scope); // no-oracle 404
    return {
      buyPlan: (dto, ctx) => this.plans.buyPlanInScope(jobPostingId, scope, dto, ctx),
      buyBoost: (dto, ctx) => this.plans.buyBoostInScope(jobPostingId, scope, dto, ctx),
      topUpQuota: (dto, ctx) => this.plans.topUpQuotaInScope(jobPostingId, scope, dto, ctx),
    };
  }

  /** The tenant's postings, newest first, each with its plan / boost stats — one resolution. */
  async listWithStats(
    actorPayerId: string,
    query: ListJobPostingsQueryDto,
  ): Promise<PostingWithStats[]> {
    const scope = await this.tenancy.resolve(actorPayerId);
    const postings = await this.jobPostings.listInScope(scope, query);
    return Promise.all(
      postings.map(async (posting) => ({
        posting,
        stats: await this.plans.getPostingStats(posting.id, scope.tenantKey),
      })),
    );
  }

  /** One of the tenant's postings with its stats; no-oracle 404 for an unknown or foreign id. */
  async getOneWithStats(jobPostingId: string, actorPayerId: string): Promise<PostingWithStats> {
    const scope = await this.tenancy.resolve(actorPayerId);
    const posting = await this.jobPostings.getOneInScope(jobPostingId, scope);
    return { posting, stats: await this.plans.getPostingStats(posting.id, scope.tenantKey) };
  }
}
