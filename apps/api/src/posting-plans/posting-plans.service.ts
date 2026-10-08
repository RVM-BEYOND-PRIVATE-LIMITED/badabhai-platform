import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type { Quote } from "@badabhai/pricing";
import { areRealPaymentsEnabled, isCapacityEnforcementEnabled, type ServerConfig } from "@badabhai/config";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { PostingPlan, PostingBoost, PostingPlanTier } from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import { SERVER_CONFIG } from "../config/config.module";
import { EventsService } from "../events/events.service";
import { PricingService } from "../pricing/pricing.service";
import { assertExpectedPrice, chargeQuote } from "../pricing/charge-price";
import { MatchConfigService } from "../match/match-config.service";
import { WorkerSkillsRepository } from "../match/worker-skills.repository";
import { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import type { PayerTenantScope, TenantKey } from "../payers/payer-tenant-scope";
import { PostingPlansRepository } from "./posting-plans.repository";
import { noActivePlanToTopUp } from "./no-active-plan-conflict";
import { assertNotAgencyTwin } from "../common/agency-twin-fence";
import type {
  BuyPlanDto,
  BuyBoostDto,
  BuyCapacityDto,
  PayerBuyPlanDto,
  PayerBuyBoostDto,
  PayerTopUpQuotaDto,
} from "./posting-plans.dto";

const MS_PER_DAY = 86_400_000;

/** The capacity product code in the pricing catalog (ADR-0016). */
const CAPACITY_PRODUCT = "hiring_capacity";

/** The quota top-up product code in the pricing catalog (B2). */
const QUOTA_TOPUP_PRODUCT = "quota_topup";

/**
 * A deferred event emission: a zero-arg thunk closing over already-computed, PII-FREE
 * values (ids/codes/enums/counts only) that calls `this.events.emit(...)`. We COLLECT
 * these INSIDE the advisory-locked transaction but FIRE them only AFTER commit — see
 * {@link PostingPlansService} class doc (the pool-vs-lock deadlock fix, mirrored from
 * UnlockService).
 */
type DeferredEmit = () => Promise<void>;

/** What the buyPlan / buyCapacity result carries back to the controller. */
export interface BuyPlanResult {
  plan: PostingPlan;
  quote: Quote;
  /** true when the plan was ACTUALLY written 'paused' (only ever when enforcement is ON). */
  paused: boolean;
  /**
   * true when the payer was over capacity, REGARDLESS of enforcement (ADR-0016, posture B).
   * In shadow mode (enforcement OFF) `wouldPause` can be true while `paused` is false: the
   * decision was computed and logged but no plan was paused.
   */
  wouldPause: boolean;
}

/** A boost purchase's result (the receipt row + the charged quote). */
export interface BuyBoostResult {
  boost: PostingBoost;
  quote: Quote;
}

/** A quota top-up's result (the topped-up plan + the charged quote). */
export interface TopUpQuotaResult {
  plan: PostingPlan;
  quote: Quote;
}

/**
 * The payer-self capacity read (GET /payer/capacity). PII-free: opaque payer_id, counts,
 * a catalog tier code, and a window timestamp only. `active_plan_count` is the DERIVED
 * live count of the TENANT's currently-active plans (status='active', not expired) —
 * added additively (ADR-0016 / payer-portal hardening A3): the allowance
 * (`max_active_vacancies`) vs how much of it is in use, so the portal can show headroom.
 * `payer_id` ECHOES THE CALLER (the session login), like `GET /payer/credits` (ADR-0053 §10);
 * the allowance and the count are the tenant's.
 */
export interface CapacityView {
  payer_id: string;
  max_active_vacancies: number;
  /** Derived count of the payer's currently-active (non-expired) plans. */
  active_plan_count: number;
  source_tier: string | null;
  expires_at: string | null;
}

export interface BuyCapacityResult {
  /** Echoes the caller (the session login), as {@link CapacityView.payer_id} does. */
  payer_id: string;
  quote: Quote;
  /** The allowance after this purchase (the catalog grant, raised). */
  max_active_vacancies: number;
  source_tier: string;
  expires_at: string | null;
  /** plan ids that were auto-resumed paused→active under the new allowance. */
  resumed_plan_ids: string[];
}

/**
 * Read-only per-posting stats derived from the ACTIVE plan + boost — the honest
 * numbers the payer's "My jobs" card renders instead of hardcoded zeros. PII-free
 * (counts / a tier enum / a boolean only). All fields are `null`/`false` when the
 * posting has no active plan/boost (a draft, or one whose plan expired) — there is
 * NO fabricated figure. `applicant_visibility_quota` here is the EFFECTIVE quota
 * (the immutable receipt + every top-up); `applicants_viewed_count` is the amount
 * used. snake_case to match the job-postings API response.
 */
export interface PostingStats {
  plan_tier: PostingPlanTier | null;
  applicant_visibility_quota: number | null;
  applicants_viewed_count: number | null;
  boosted: boolean;
}

/**
 * Paid job-posting plans + boosters (ADR-0013 Decision B) + per-payer hiring capacity
 * (ADR-0016). The buy flow: resolve the price through the ONE pricing engine → mock
 * payment (PAYMENTS_ENABLE_REAL=false; `real_call` stamped honestly) → write the
 * entitlement row (price/quota/window STAMPED, so a later catalog change can't rewrite
 * the receipt) → emit payment.* + the product event. PII-free, faceless (opaque payer_id).
 *
 * CAPACITY CHOKEPOINT (ADR-0016, ADR-0010 F-2 discipline): a plan purchase counts the
 * payer's currently-active vacancies and writes status='active' ONLY if it stays within
 * the payer's allowance (their payer_capacity row, else the config default); otherwise
 * it writes status='paused'. The count-and-write is ONE transaction under a per-payer
 * `pg_advisory_xact_lock` so N concurrent buys can never each read "under cap" and all
 * activate (NEVER read-then-write across statements).
 *
 * ENFORCEMENT FLAG (ADR-0016, posture B — CAPACITY_ENFORCEMENT_ENABLED, default OFF):
 * the over-cap decision is ALWAYS computed under the lock, but it only pauses when
 * enforcement is ON. Default OFF = SHADOW: nothing is paused; an over-cap purchase
 * stays 'active', records a PII-free would-pause LOG line (no spine event — pausing
 * nothing must not emit posting_plan.paused), and returns wouldPause=true. ON = enforce:
 * the plan is written 'paused' and posting_plan.paused is emitted, as before.
 *
 * DEADLOCK AVOIDANCE (mirrors UnlockService): EventsService.emit uses the GLOBAL db pool
 * (a SEPARATE connection). Emitting WHILE the advisory-locked transaction is held would,
 * under concurrency, need an extra pool connection while N requests queue on the lock →
 * pool-vs-lock deadlock. So the transaction NEVER emits: it collects deferred PII-free
 * emit thunks and we FIRE them AFTER commit (lock + connection released). POST-COMMIT
 * trade-off: an emit that fails cannot roll back the committed state — we LOG (class only,
 * no PII) and still return the committed result.
 *
 * Real money is a human-gated escalation (CLAUDE.md §7); a real-enabled flag without a
 * key fails CLOSED at boot (assertPaymentsConfig). No PayerAuthGuard in alpha (launch
 * gate, LC-1): the capacity endpoint is InternalServiceGuard-only and the `payer_id` it
 * acts on is ADVISORY (caller-supplied route param), documented on the controller + DTO.
 *
 * ORG TENANCY (ADR-0053, PAY-DB-01 P2c). Every entry point resolves the caller ONCE through
 * {@link PayerTenantScopeService} — the session payer and the ops body's `payer_id` alike
 * (§5.2 rules 1, 4) — or takes the scope its composed caller already resolved (`*InScope`,
 * the payer posting routes' one seam: `PayerPostingPlansService`). From there:
 *  - every `posting_plans` / `posting_boosts` / `payer_capacity` predicate and stamp, the
 *    capacity advisory lock and the coupon count use the TENANT key: the org buys, counts
 *    against and is capped by ONE allowance, and a coupon's per-payer limit is per org (O-4);
 *  - every event's envelope actor is the ACTING LOGIN, and its payload `payer_id` (and a
 *    payer-keyed subject) the tenant (§7). `posting_plan.paused/resumed` stay system-actor;
 *  - a response field that echoes the caller (`payer_id` on the capacity views) stays the
 *    caller (§10).
 * In mode `off` the tenant is the caller itself, so rows, events and responses are unchanged.
 * No money moves: a purchase writes a new row (or raises the allowance) under the key.
 */
@Injectable()
export class PostingPlansService {
  private readonly logger = new Logger(PostingPlansService.name);

  constructor(
    private readonly repo: PostingPlansRepository,
    private readonly events: EventsService,
    private readonly pricing: PricingService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    // ADR-0036 §7 — the boost supply gate reads its floor from `match_config` and its
    // reach count from `job_reach`. MatchModule is @Global, so no new import edge.
    private readonly matchConfig: MatchConfigService,
    private readonly matchReach: WorkerSkillsRepository,
    // ADR-0053 — the ONE payer tenant resolver (PayersModule, imported by PostingPlansModule).
    private readonly tenancy: PayerTenantScopeService,
  ) {}

  /**
   * The honest per-posting stats for `jobPostingId` OWNED by the tenant `tenant`. Reuses the
   * exact active-plan + active-boost predicates the top-up/boost writers use (no
   * SQL duplication, no divergence). Both reads are tenant-scoped (plan) / posting-
   * scoped (boost); a foreign or unknown posting simply yields the empty stats, so
   * this can never become an ownership oracle. Read-only, emits no event.
   *
   * Takes the key its caller ALREADY resolved (ADR-0053 §5.4): the payer postings list reads
   * one stats row per posting, so resolving in here would cost one resolution per posting.
   */
  async getPostingStats(jobPostingId: string, tenant: TenantKey): Promise<PostingStats> {
    const now = new Date();
    const [plan, boost] = await Promise.all([
      this.repo.findActivePlanForPostingAndPayer(jobPostingId, tenant, now),
      this.repo.findActiveBoost(jobPostingId, now),
    ]);
    return {
      plan_tier: plan?.tier ?? null,
      // EFFECTIVE quota = the immutable receipt + every top-up (documented on the
      // posting_plans schema). Used count is the applicants already viewed.
      applicant_visibility_quota: plan
        ? plan.applicantVisibilityQuota + plan.quotaTopupCount
        : null,
      applicants_viewed_count: plan?.applicantsViewedCount ?? null,
      boosted: boost !== undefined,
    };
  }

  /**
   * Ops buy-a-plan (`POST /job-postings/:id/plan`, InternalServiceGuard; the body `payer_id` is
   * ADVISORY). ADR-0053 §5.2 rule 4: that id goes through the SAME resolver as a session payer,
   * so the plan is its TENANT's and the events name it as the acting login. No posting-ownership
   * check here, exactly as before (the ops route never had one).
   */
  async buyPlan(jobPostingId: string, dto: BuyPlanDto, ctx: RequestContext): Promise<BuyPlanResult> {
    const { payer_id: actorPayerId, ...purchase } = dto;
    return this.buyPlanInScope(jobPostingId, await this.tenancy.resolve(actorPayerId), purchase, ctx);
  }

  /**
   * Buy a plan in a scope the caller already resolved: the ops route above, or the payer
   * route's one seam (`PayerPostingPlansService.forOwnedPosting`), which checked the posting's
   * ownership IN THIS SAME SCOPE before handing it here — never a second resolution.
   */
  async buyPlanInScope(
    jobPostingId: string,
    scope: PayerTenantScope,
    dto: PayerBuyPlanDto,
    ctx: RequestContext,
  ): Promise<BuyPlanResult> {
    const syncSource = await this.repo.findPostingSyncSource(jobPostingId);
    if (syncSource === undefined) {
      throw new NotFoundException(`Job posting ${jobPostingId} not found`);
    }
    // ADR-0050 §4.3 — no plan is ever sold against a system-owned agency twin.
    assertNotAgencyTwin(syncSource);
    const tenant = scope.tenantKey;
    const quote = await this.resolve("job_posting", dto.tier, dto.coupon, tenant, dto.expected_price_inr);
    if (quote.grants.kind !== "posting") {
      throw new BadRequestException("resolved product is not a posting plan");
    }
    const grants = quote.grants;
    const realCall = areRealPaymentsEnabled(this.config);
    // ADR-0016 posture B: when OFF (default) the over-cap decision is computed + logged
    // but never pauses (shadow). When ON the plan is paused + posting_plan.paused emitted.
    const enforce = isCapacityEnforcementEnabled(this.config);
    const now = new Date();

    // The whole [count active vacancies → decide status → insertPlan] is ONE transaction
    // holding the per-TENANT advisory lock (ADR-0016 / F-2: count-and-write atomic, never
    // read-then-write; ADR-0053 §6: two members of one org serialize on the org's lock).
    // It does NOT emit (deadlock fix) — it returns deferred thunks.
    const { plan, paused, wouldPause, deferred } = await this.repo.withTransaction(async (tx) => {
      const deferred: DeferredEmit[] = [];
      await this.repo.lockPayer(tx, tenant);

      // allowed = the tenant's row, else the config default (NO hard-coded number here).
      // Read on `tx` so it rides the advisory-locked connection — NEVER a second pool
      // connection while the lock is held (ADR-0016 / F-2 deadlock discipline).
      const capacityRow = await this.repo.getCapacity(tenant, tx);
      const allowed = capacityRow?.maxActiveVacancies ?? this.config.CAPACITY_DEFAULT_MAX_ACTIVE_VACANCIES;
      const activeNow = await this.repo.countActivePlansForPayer(tx, tenant, now);
      // Decision computed the SAME way under the lock for accuracy; whether it PAUSES
      // depends on the enforcement flag (posture B). A real pause only when enforce && over.
      const overCapacity = activeNow + 1 > allowed;
      const status = enforce && overCapacity ? "paused" : "active";

      const plan = await this.repo.insertPlan(
        {
          jobPostingId,
          payerId: tenant,
          tier: dto.tier,
          applicantVisibilityQuota: grants.applicantVisibilityQuota,
          status,
          paidAt: now,
          expiresAt: new Date(now.getTime() + grants.validityDays * MS_PER_DAY),
        },
        tx,
      );

      // Payment is collected (mock) regardless of paused/active — the receipt is real;
      // a paused plan simply does not serve until capacity frees up (ADR-0016 D3).
      deferred.push(() => this.emitPayment("payment.authorized", jobPostingId, scope, quote.finalInr, realCall, ctx));
      deferred.push(() => this.emitPayment("payment.captured", jobPostingId, scope, quote.finalInr, realCall, ctx));
      deferred.push(() => this.emitPurchased(plan.id, jobPostingId, scope, dto.tier, grants, quote, realCall, ctx));
      if (enforce && overCapacity) {
        // ENFORCING + over cap → a REAL pause: emit the spine event (event↔state honest).
        deferred.push(() => this.emitPlanPaused(plan.id, jobPostingId, tenant, ctx));
      } else if (overCapacity) {
        // SHADOW + over cap → nothing paused, so NO posting_plan.paused (that would assert
        // a pause that did not happen). Record a PII-free would-pause log line instead:
        // opaque ids + counts only — never a name/phone (faceless invariant).
        this.logger.log(
          `capacity shadow: plan WOULD pause under enforcement — payer_id=${tenant} plan_id=${plan.id} ` +
            `job_posting_id=${jobPostingId} activeNow=${activeNow} allowed=${allowed}`,
        );
      }
      return { plan, paused: enforce && overCapacity, wouldPause: overCapacity, deferred };
    });

    // COMMITTED — advisory lock + connection released. Emit the audit events now, then
    // the (PII-free) coupon redemption if one applied.
    await this.flushEvents(deferred);
    await this.emitCouponIfApplied(quote, scope, "job_posting", dto.tier, ctx);

    return { plan, quote, paused, wouldPause };
  }

  /**
   * Ops buy-a-boost (`POST /job-postings/:id/boost`, InternalServiceGuard; ADVISORY body
   * `payer_id`). Resolved through the same resolver as a session payer (ADR-0053 §5.2 rule 4),
   * exactly as {@link buyPlan}.
   */
  async buyBoost(jobPostingId: string, dto: BuyBoostDto, ctx: RequestContext): Promise<BuyBoostResult> {
    const { payer_id: actorPayerId, ...purchase } = dto;
    return this.buyBoostInScope(jobPostingId, await this.tenancy.resolve(actorPayerId), purchase, ctx);
  }

  /** Buy a boost in a scope the caller already resolved (see {@link buyPlanInScope}). */
  async buyBoostInScope(
    jobPostingId: string,
    scope: PayerTenantScope,
    dto: PayerBuyBoostDto,
    ctx: RequestContext,
  ): Promise<BuyBoostResult> {
    const syncSource = await this.repo.findPostingSyncSource(jobPostingId);
    if (syncSource === undefined) {
      throw new NotFoundException(`Job posting ${jobPostingId} not found`);
    }
    // ADR-0050 §4.3 — no boost is ever sold against a system-owned agency twin.
    assertNotAgencyTwin(syncSource);
    const now = new Date();
    // B-R3: no overlapping active boost.
    if (await this.repo.findActiveBoost(jobPostingId, now)) {
      throw new ConflictException("an active boost already exists for this posting");
    }
    const tenant = scope.tenantKey;
    const quote = await this.resolve("job_boost", dto.tier, dto.coupon, tenant, dto.expected_price_inr);
    if (quote.grants.kind !== "boost") {
      throw new BadRequestException("resolved product is not a boost");
    }

    // ── ADR-0036 §7 SUPPLY GATE ────────────────────────────────────────────────
    // Refuse the sale when the posting's matched supply is below the floor. Boost
    // PERMUTES ORDER within what a worker already qualified for (Policy 13) — it never
    // adds a card that failed the skill gate — so boosting a posting that reaches four
    // workers reorders four cards. Taking ₹999 for that costs the ₹999 AND the renewal
    // behind it. The floor is `match_config.boost_supply_floor`, never a constant here.
    //
    // BEFORE ANY PAYMENT EVENT, deliberately: a refusal must not leave a
    // `payment.authorized` on the spine for money that was never taken.
    await this.assertBoostSupply(jobPostingId, scope, dto.tier, ctx);

    const realCall = areRealPaymentsEnabled(this.config);

    await this.emitPayment("payment.authorized", jobPostingId, scope, quote.finalInr, realCall, ctx);
    const boost = await this.repo.insertBoost({
      jobPostingId,
      payerId: tenant,
      tier: dto.tier,
      status: "active",
      boostStartsAt: now,
      boostEndsAt: new Date(now.getTime() + quote.grants.boostDays * MS_PER_DAY),
    });
    // ADR-0036 §7 — the SERVED entity's boost window. `posting_boosts` stays the
    // immutable receipt (one row per purchase, never updated); `job_postings
    // .boosted_until` is the DERIVED serving state the feed's ORDER BY reads, so the
    // feed needs no join to `posting_boosts` on its hottest path.
    //
    // EXTEND, DON'T OVERWRITE: `GREATEST(now(), boosted_until) + N days`. Buying a
    // second boost while one is still running must ADD to the window, not truncate it
    // to N days from today — that would be selling a man time he already owns and
    // taking some away.
    await this.repo.extendPostingBoostWindow(jobPostingId, quote.grants.boostDays);
    await this.emitPayment("payment.captured", jobPostingId, scope, quote.finalInr, realCall, ctx);

    const boosted: PayloadInputOf<"job_posting.boosted"> = {
      boost_id: boost.id,
      job_posting_id: jobPostingId,
      payer_id: tenant,
      tier: dto.tier,
      boost_days: quote.grants.boostDays,
      price_inr: quote.finalInr,
      real_call: realCall,
    };
    await this.events.emit({
      event_name: "job_posting.boosted",
      actor: payerActor(scope),
      subject: { subject_type: "job_posting", subject_id: jobPostingId },
      payload: boosted,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
    await this.emitCouponIfApplied(quote, scope, "job_boost", dto.tier, ctx);

    return { boost, quote };
  }

  /**
   * Payer self-serve quota top-up (B2). Buys additional applicant-visibility views for one of
   * the tenant's OWN active posting plans ("view more → pay more"), resolved through the ONE
   * pricing engine (ADR-0013 — a `quota_topup` catalog product). The scope is the verified
   * SESSION payer's, resolved ONCE by the payer route's seam (`PayerPostingPlansService`), which
   * asserted the posting's ownership IN THAT SAME SCOPE before handing it here (no body value —
   * XB-A; no second resolution — ADR-0053 §5.2 rule 1).
   *
   * Flow (mirrors buyBoost — a single atomic write, no advisory lock needed): resolve price →
   * find the tenant's ACTIVE, unexpired plan for the posting (409 if none) → mock payment
   * (`real_call` honest) → ATOMIC increment quota_topup_count (re-asserting active+owned in the
   * WHERE, so a plan that expired since the read yields a 409, never a phantom grant) → emit
   * posting_plan.quota_topped + payment.* + coupon (all PII-free). The ORIGINAL stamped
   * `applicant_visibility_quota` receipt is never mutated; the top-up accumulates separately.
   */
  async topUpQuotaInScope(
    jobPostingId: string,
    scope: PayerTenantScope,
    dto: PayerTopUpQuotaDto,
    ctx: RequestContext,
  ): Promise<TopUpQuotaResult> {
    const tenant = scope.tenantKey;
    const quote = await this.resolve(QUOTA_TOPUP_PRODUCT, dto.tier, dto.coupon, tenant, dto.expected_price_inr);
    if (quote.grants.kind !== "quota_topup") {
      throw new BadRequestException("resolved product is not a quota top-up");
    }
    const grants = quote.grants;
    const realCall = areRealPaymentsEnabled(this.config);
    const now = new Date();

    // The plan to top up: the tenant's active, unexpired plan for this posting (tenant-scoped;
    // a foreign/absent plan is invisible → 409, no oracle). You must own an active plan first.
    // In `on` a teammate tops up the ORG's plan — whichever member bought it.
    const target = await this.repo.findActivePlanForPostingAndPayer(jobPostingId, tenant, now);
    // 409 `reason: "no_active_plan"` (#2111) — the same message as before, plus the reason.
    if (!target) throw noActivePlanToTopUp();

    // ATOMIC increment (re-guards active+owned+unexpired) BEFORE any payment emit, so a plan
    // that raced to expiry yields a clean 409 and NO payment event is recorded for a no-op.
    const updated = await this.repo.addQuotaTopup(
      target.id,
      tenant,
      grants.additionalVisibilityQuota,
      now,
    );
    if (!updated) throw noActivePlanToTopUp();

    await this.emitPayment("payment.authorized", jobPostingId, scope, quote.finalInr, realCall, ctx);
    await this.emitPayment("payment.captured", jobPostingId, scope, quote.finalInr, realCall, ctx);

    const payload: PayloadInputOf<"posting_plan.quota_topped"> = {
      plan_id: updated.id,
      job_posting_id: jobPostingId,
      payer_id: tenant,
      tier: dto.tier,
      quota_added: grants.additionalVisibilityQuota,
      quota_topup_total: updated.quotaTopupCount,
      price_inr: quote.finalInr,
      discount_inr: quote.discountInr,
      coupon_applied: quote.couponApplied !== null,
      real_call: realCall,
    };
    await this.events.emit({
      event_name: "posting_plan.quota_topped",
      actor: payerActor(scope),
      subject: { subject_type: "posting_plan", subject_id: updated.id },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
    await this.emitCouponIfApplied(quote, scope, QUOTA_TOPUP_PRODUCT, dto.tier, ctx);

    return { plan: updated, quote };
  }

  /**
   * Buy/upgrade the tenant's hiring capacity (ADR-0016) + AUTO-RESUME paused plans.
   * Flow: resolve the capacity tier price → mock payment (real_call honest) →
   * upsertCapacity (RAISE the allowance, stamp source_tier + expires_at from
   * validityDays) → emit capacity.purchased + payment.* → under a per-tenant advisory
   * lock, recompute the allowance and flip paused→active oldest-first up to
   * (allowed − currentActive), deferring a posting_plan.resumed per resumed plan, fired
   * post-commit. Idempotency: the advisory-locked recompute is naturally safe and the
   * upsert is keyed on payer_id with a GREATEST guard (a replay never lowers the grant).
   *
   * `actorPayerId` is the SESSION payer, resolved ONCE here (ADR-0053): in `on` a member's
   * purchase raises the ORG's one allowance and resumes the org's paused plans.
   */
  async buyCapacity(actorPayerId: string, dto: BuyCapacityDto, ctx: RequestContext): Promise<BuyCapacityResult> {
    const scope = await this.tenancy.resolve(actorPayerId);
    const tenant = scope.tenantKey;
    const quote = await this.resolve(CAPACITY_PRODUCT, dto.tier, dto.coupon, tenant, dto.expected_price_inr);
    if (quote.grants.kind !== "capacity") {
      throw new BadRequestException("resolved product is not a capacity grant");
    }
    const grants = quote.grants;
    const realCall = areRealPaymentsEnabled(this.config);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + grants.validityDays * MS_PER_DAY);

    // Auto-resume runs under the per-tenant advisory lock so it cannot race a concurrent
    // buyPlan (count-and-write atomic; ADR-0016 / F-2). The upsert is performed INSIDE
    // the same locked tx so the recompute sees the raised allowance. NO emit in the tx.
    const { resumedPlanIds, deferred } = await this.repo.withTransaction(async (tx) => {
      const deferred: DeferredEmit[] = [];
      await this.repo.lockPayer(tx, tenant);

      await this.repo.upsertCapacity(
        {
          payerId: tenant,
          maxActiveVacancies: grants.maxActiveVacancies,
          sourceTier: dto.tier,
          expiresAt,
        },
        tx,
      );

      // Recompute against the just-raised allowance and resume oldest-first up to the
      // headroom. We use the grant we just upserted directly as `allowed` (the GREATEST
      // upsert guard means the live allowance is at least this), avoiding a re-read of
      // our own in-tx write. The active count IS read tx-scoped under the advisory lock.
      const allowed = grants.maxActiveVacancies;
      const activeNow = await this.repo.countActivePlansForPayer(tx, tenant, now);
      let headroom = allowed - activeNow;

      const resumedPlanIds: string[] = [];
      if (headroom > 0) {
        const paused = await this.repo.listPausedPlansForPayer(tx, tenant);
        for (const plan of paused) {
          if (headroom <= 0) break;
          // Skip a paused plan whose own validity window has expired — it should not
          // resume into 'active' (it would not be a live vacancy). Leave it paused.
          if (plan.expiresAt && plan.expiresAt.getTime() <= now.getTime()) continue;
          await this.repo.setPlanStatus(tx, plan.id, "active");
          resumedPlanIds.push(plan.id);
          deferred.push(() => this.emitPlanResumed(plan.id, plan.jobPostingId, tenant, ctx));
          headroom -= 1;
        }
      }

      deferred.push(() => this.emitPayment("payment.authorized", null, scope, quote.finalInr, realCall, ctx));
      deferred.push(() => this.emitPayment("payment.captured", null, scope, quote.finalInr, realCall, ctx));
      deferred.push(() => this.emitCapacityPurchased(scope, dto.tier, grants.maxActiveVacancies, quote.finalInr, realCall, ctx));
      return { resumedPlanIds, deferred };
    });

    await this.flushEvents(deferred);
    await this.emitCouponIfApplied(quote, scope, CAPACITY_PRODUCT, dto.tier, ctx);

    return {
      // Echoes the caller (ADR-0053 §10); the allowance is the tenant's.
      payer_id: scope.actorPayerId,
      quote,
      max_active_vacancies: grants.maxActiveVacancies,
      source_tier: dto.tier,
      expires_at: expiresAt.toISOString(),
      resumed_plan_ids: resumedPlanIds,
    };
  }

  /**
   * The tenant's current hiring-capacity allowance (ADR-0016) — a PII-free read for the
   * payer-self portal. Returns the catalog grant + window only (opaque payer_id, codes,
   * counts; no name/phone). When the tenant has no row yet, reports the config default
   * allowance so the portal always shows a coherent capacity (no NULL hole).
   */
  async getCapacity(actorPayerId: string): Promise<CapacityView> {
    // ADR-0053: the SESSION payer resolved once; the allowance and the count are the tenant's.
    const scope = await this.tenancy.resolve(actorPayerId);
    const tenant = scope.tenantKey;
    const now = new Date();
    // Read the allowance row AND the derived live count on ONE tx so the portal sees a
    // consistent snapshot (`active_plan_count` vs `max_active_vacancies`). countActive…
    // is tx-scoped by signature; this is a plain read tx (no advisory lock — display only,
    // not the buy chokepoint). Both reads are PII-free (counts/codes/timestamps only) and
    // keyed by the RESOLVED tenant (XB-A: never a body/param id).
    const { row, activePlanCount } = await this.repo.withTransaction(async (tx) => ({
      row: await this.repo.getCapacity(tenant, tx),
      activePlanCount: await this.repo.countActivePlansForPayer(tx, tenant, now),
    }));
    const maxActiveVacancies =
      row?.maxActiveVacancies ?? this.config.CAPACITY_DEFAULT_MAX_ACTIVE_VACANCIES;
    return {
      payer_id: scope.actorPayerId,
      max_active_vacancies: maxActiveVacancies,
      active_plan_count: activePlanCount,
      source_tier: row?.sourceTier ?? null,
      expires_at: row?.expiresAt ? row.expiresAt.toISOString() : null,
    };
  }

  /**
   * ADR-0036 §7 — the boost SUPPLY GATE. Throws a 400 with an honest message and emits
   * `job_posting.boost_refused` when the posting's `job_reach` count is below
   * `match_config.boost_supply_floor`.
   *
   * THE ERROR IS HONEST, not neutral: it names the actual reach and the floor. This is
   * NOT an ownership oracle — the caller already proved ownership of the posting to get
   * here (the payer path via `PayerPostingPlansService.forOwnedPosting`, the ops path via the
   * service guard), and
   * the numbers are about the platform's supply for a trade the payer themselves chose,
   * not about another tenant. Hiding them would mean refusing a payer's money without
   * telling them why, which is the exact failure the fence exists to prevent.
   *
   * FAILS OPEN ON AN UNREADABLE REACH COUNT. If `job_reach` cannot be counted the sale
   * proceeds: a broken cache must not become an outage on the paid path, and the
   * repair tooling (`db:materialize:reach`) plus the E12/E13 alerts already cover a
   * genuinely empty reach set.
   */
  private async assertBoostSupply(
    jobPostingId: string,
    scope: PayerTenantScope,
    tier: string,
    ctx: RequestContext,
  ): Promise<void> {
    const cfg = await this.matchConfig.get();
    if (cfg.boostSupplyFloor <= 0) return; // floor disabled by config

    let reachTotal: number;
    try {
      reachTotal = (await this.matchReach.countReachForPosting(jobPostingId)).total;
    } catch (err) {
      const cls = err instanceof Error ? err.name : "UnknownError";
      this.logger.error(
        `boost supply gate could not read job_reach for posting=${jobPostingId} (${cls}); ` +
          `allowing the purchase rather than failing a paid path on a cache read`,
      );
      return;
    }
    if (reachTotal >= cfg.boostSupplyFloor) return;

    const payload: PayloadInputOf<"job_posting.boost_refused"> = {
      job_posting_id: jobPostingId,
      payer_id: scope.tenantKey,
      tier,
      reason: "supply_below_floor",
      reach_total: reachTotal,
      supply_floor: cfg.boostSupplyFloor,
    };
    await this.events.emit({
      event_name: "job_posting.boost_refused",
      actor: payerActor(scope),
      subject: { subject_type: "job_posting", subject_id: jobPostingId },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    throw new BadRequestException(
      `this posting currently reaches ${reachTotal} worker(s); a boost needs at least ` +
        `${cfg.boostSupplyFloor}. Boosting reorders the workers you already reach — it ` +
        `never adds new ones — so it would not help yet.`,
    );
  }

  /**
   * Resolve a price through the one charge function ({@link chargeQuote} — the same one the
   * payer catalog displays through), failing closed to an "unavailable" 400.
   *
   * #2085: when the payer sent the ₹ they confirmed, a different charge price is a 409
   * `price_mismatch`. Every caller resolves BEFORE its first write or payment event, so a
   * refusal charges nothing and leaves no ledger/receipt row behind.
   *
   * The coupon's usage is counted for the TENANT (ADR-0053 O-4): a coupon's `perPayerLimit`
   * is per org once the flag is on, and per login (the login is the tenant) while it is off.
   */
  private async resolve(
    product: string,
    tier: string,
    coupon: string | undefined,
    tenant: TenantKey,
    expectedPriceInr?: number,
  ): Promise<Quote> {
    const { catalog } = await this.pricing.getActiveCatalog();
    const usage = coupon ? await this.repo.couponUsage(coupon, tenant) : undefined;
    const result = chargeQuote(catalog, { productCode: product, tierCode: tier, couponCode: coupon, couponUsage: usage });
    if (!result.ok) throw new BadRequestException(`${product}/${tier} is not available`);
    assertExpectedPrice(expectedPriceInr, result.quote.finalInr);
    return result.quote;
  }

  /**
   * Fire the deferred, PII-free event emits AFTER the transaction has committed (so we
   * hold NO advisory lock and NO pool connection while emitting — the deadlock fix). The
   * committed DB state is the source of truth. On emit failure we LOG (class only, NO
   * PII) and continue (the alternative — emit-in-tx — reintroduces the pool-vs-lock
   * deadlock). Mirrors UnlockService.flushEvents.
   */
  private async flushEvents(deferred: DeferredEmit[]): Promise<void> {
    for (const emit of deferred) {
      try {
        await emit();
      } catch (err) {
        const cls = err instanceof Error ? err.name : "UnknownError";
        const msg = err instanceof Error ? err.message : "unknown";
        this.logger.error(`post-commit event emit failed: ${cls}: ${msg}`);
      }
    }
  }

  // ---- Event emitters (all PII-free; ids + codes + enums + counts only) -------
  // ADR-0053 §7: these are TENANT business events. The envelope actor is the ACTING LOGIN
  // (`scope.actorPayerId`); every payload `payer_id`, and a payer-keyed subject, is the TENANT
  // key. No schema changes shape; in mode `off` every value is the caller, exactly as before.

  private async emitPurchased(
    planId: string,
    jobPostingId: string,
    scope: PayerTenantScope,
    tier: PayerBuyPlanDto["tier"],
    grants: { applicantVisibilityQuota: number; validityDays: number },
    quote: Quote,
    realCall: boolean,
    ctx: RequestContext,
  ): Promise<void> {
    const purchased: PayloadInputOf<"job_posting.purchased"> = {
      plan_id: planId,
      job_posting_id: jobPostingId,
      payer_id: scope.tenantKey,
      tier,
      applicant_visibility_quota: grants.applicantVisibilityQuota,
      validity_days: grants.validityDays,
      price_inr: quote.finalInr,
      discount_inr: quote.discountInr,
      coupon_applied: quote.couponApplied !== null,
      real_call: realCall,
    };
    await this.events.emit({
      event_name: "job_posting.purchased",
      actor: payerActor(scope),
      subject: { subject_type: "job_posting", subject_id: jobPostingId },
      payload: purchased,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }

  private async emitPlanPaused(
    planId: string,
    jobPostingId: string,
    tenant: TenantKey,
    ctx: RequestContext,
  ): Promise<void> {
    const payload: PayloadInputOf<"posting_plan.paused"> = {
      plan_id: planId,
      job_posting_id: jobPostingId,
      payer_id: tenant,
      reason: "capacity_exceeded",
    };
    await this.events.emit({
      event_name: "posting_plan.paused",
      actor: { actor_type: "system" },
      subject: { subject_type: "posting_plan", subject_id: planId },
      payload,
      idempotencyKey: `posting_plan.paused:${planId}`,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }

  private async emitPlanResumed(
    planId: string,
    jobPostingId: string,
    tenant: TenantKey,
    ctx: RequestContext,
  ): Promise<void> {
    const payload: PayloadInputOf<"posting_plan.resumed"> = {
      plan_id: planId,
      job_posting_id: jobPostingId,
      payer_id: tenant,
      reason: "capacity_restored",
    };
    await this.events.emit({
      event_name: "posting_plan.resumed",
      actor: { actor_type: "system" },
      subject: { subject_type: "posting_plan", subject_id: planId },
      payload,
      // Symmetry with posting_plan.paused: a plan resumes at most once in the current
      // pause-once/resume-once lifecycle, so the plan id keys this emit idempotently —
      // a post-commit flush replay re-emits the same audit row at most once (N1).
      idempotencyKey: `posting_plan.resumed:${planId}`,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }

  private async emitCapacityPurchased(
    scope: PayerTenantScope,
    tier: string,
    maxActiveVacancies: number,
    priceInr: number,
    realCall: boolean,
    ctx: RequestContext,
  ): Promise<void> {
    const payload: PayloadInputOf<"capacity.purchased"> = {
      payer_id: scope.tenantKey,
      tier,
      max_active_vacancies: maxActiveVacancies,
      price_inr: priceInr,
      real_call: realCall,
    };
    await this.events.emit({
      event_name: "capacity.purchased",
      actor: payerActor(scope),
      // Tenant-scoped subject (subject_id = the allowance's payer_id), matching the
      // coupon.redeemed precedent.
      subject: { subject_type: "pricing_plan", subject_id: scope.tenantKey },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }

  private async emitPayment(
    name: "payment.authorized" | "payment.captured",
    jobPostingId: string | null,
    scope: PayerTenantScope,
    amountInr: number,
    realCall: boolean,
    ctx: RequestContext,
  ): Promise<void> {
    const payload: PayloadInputOf<"payment.authorized"> = {
      payer_id: scope.tenantKey,
      amount_inr: amountInr,
      real_call: realCall,
    };
    await this.events.emit({
      event_name: name,
      actor: payerActor(scope),
      // Capacity purchases are not tied to a posting → tenant-scoped pricing_plan subject.
      subject: jobPostingId
        ? { subject_type: "job_posting", subject_id: jobPostingId }
        : { subject_type: "pricing_plan", subject_id: scope.tenantKey },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }

  /**
   * `coupon.redeemed` — its payload `payer_id` is the TENANT, which is exactly what
   * {@link PostingPlansRepository.couponUsage} counts: a coupon's per-payer limit is per org
   * once the flag is on (O-4).
   */
  private async emitCouponIfApplied(
    quote: Quote,
    scope: PayerTenantScope,
    product: string,
    tier: string,
    ctx: RequestContext,
  ): Promise<void> {
    if (quote.couponApplied === null) return;
    const payload: PayloadInputOf<"coupon.redeemed"> = {
      coupon_code: quote.couponApplied,
      payer_id: scope.tenantKey,
      product,
      tier,
      discount_inr: quote.discountInr,
    };
    await this.events.emit({
      event_name: "coupon.redeemed",
      actor: payerActor(scope),
      subject: { subject_type: "pricing_plan", subject_id: scope.tenantKey },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }
}

/** The event actor on a purchase: the ACTING LOGIN, never the tenant (ADR-0053 §7). */
function payerActor(scope: PayerTenantScope): { actor_type: "payer"; actor_id: string } {
  return { actor_type: "payer", actor_id: scope.actorPayerId };
}
