import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { resolvePrice, type Quote } from "@badabhai/pricing";
import { areRealPaymentsEnabled, isCapacityEnforcementEnabled, type ServerConfig } from "@badabhai/config";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { PostingPlan, PostingBoost } from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import { SERVER_CONFIG } from "../config/config.module";
import { EventsService } from "../events/events.service";
import { PricingService } from "../pricing/pricing.service";
import { PostingPlansRepository } from "./posting-plans.repository";
import type {
  BuyPlanDto,
  BuyBoostDto,
  BuyCapacityDto,
  PayerBuyPlanDto,
  PayerBuyBoostDto,
} from "./posting-plans.dto";

const MS_PER_DAY = 86_400_000;

/** The capacity product code in the pricing catalog (ADR-0016). */
const CAPACITY_PRODUCT = "hiring_capacity";

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

/**
 * The payer-self capacity read (GET /payer/capacity). PII-free: opaque payer_id, counts,
 * a catalog tier code, and a window timestamp only. `active_plan_count` is the DERIVED
 * live count of the AUTHENTICATED payer's currently-active plans (status='active', not
 * expired) — added additively (ADR-0016 / payer-portal hardening A3): the allowance
 * (`max_active_vacancies`) vs how much of it is in use, so the portal can show headroom.
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
 */
@Injectable()
export class PostingPlansService {
  private readonly logger = new Logger(PostingPlansService.name);

  constructor(
    private readonly repo: PostingPlansRepository,
    private readonly events: EventsService,
    private readonly pricing: PricingService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  async buyPlan(jobPostingId: string, dto: BuyPlanDto, ctx: RequestContext): Promise<BuyPlanResult> {
    if (!(await this.repo.postingExists(jobPostingId))) {
      throw new NotFoundException(`Job posting ${jobPostingId} not found`);
    }
    const quote = await this.resolve("job_posting", dto.tier, dto.coupon, dto.payer_id);
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
    // holding the per-payer advisory lock (ADR-0016 / F-2: count-and-write atomic, never
    // read-then-write). It does NOT emit (deadlock fix) — it returns deferred thunks.
    const { plan, paused, wouldPause, deferred } = await this.repo.withTransaction(async (tx) => {
      const deferred: DeferredEmit[] = [];
      await this.repo.lockPayer(tx, dto.payer_id);

      // allowed = the payer's row, else the config default (NO hard-coded number here).
      // Read on `tx` so it rides the advisory-locked connection — NEVER a second pool
      // connection while the lock is held (ADR-0016 / F-2 deadlock discipline).
      const capacityRow = await this.repo.getCapacity(dto.payer_id, tx);
      const allowed = capacityRow?.maxActiveVacancies ?? this.config.CAPACITY_DEFAULT_MAX_ACTIVE_VACANCIES;
      const activeNow = await this.repo.countActivePlansForPayer(tx, dto.payer_id, now);
      // Decision computed the SAME way under the lock for accuracy; whether it PAUSES
      // depends on the enforcement flag (posture B). A real pause only when enforce && over.
      const overCapacity = activeNow + 1 > allowed;
      const status = enforce && overCapacity ? "paused" : "active";

      const plan = await this.repo.insertPlan(
        {
          jobPostingId,
          payerId: dto.payer_id,
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
      deferred.push(() => this.emitPayment("payment.authorized", jobPostingId, dto.payer_id, quote.finalInr, realCall, ctx));
      deferred.push(() => this.emitPayment("payment.captured", jobPostingId, dto.payer_id, quote.finalInr, realCall, ctx));
      deferred.push(() => this.emitPurchased(plan.id, jobPostingId, dto, grants, quote, realCall, ctx));
      if (enforce && overCapacity) {
        // ENFORCING + over cap → a REAL pause: emit the spine event (event↔state honest).
        deferred.push(() => this.emitPlanPaused(plan.id, jobPostingId, dto.payer_id, ctx));
      } else if (overCapacity) {
        // SHADOW + over cap → nothing paused, so NO posting_plan.paused (that would assert
        // a pause that did not happen). Record a PII-free would-pause log line instead:
        // opaque ids + counts only — never a name/phone (faceless invariant).
        this.logger.log(
          `capacity shadow: plan WOULD pause under enforcement — payer_id=${dto.payer_id} plan_id=${plan.id} ` +
            `job_posting_id=${jobPostingId} activeNow=${activeNow} allowed=${allowed}`,
        );
      }
      return { plan, paused: enforce && overCapacity, wouldPause: overCapacity, deferred };
    });

    // COMMITTED — advisory lock + connection released. Emit the audit events now, then
    // the (PII-free) coupon redemption if one applied.
    await this.flushEvents(deferred);
    await this.emitCouponIfApplied(quote, dto.payer_id, "job_posting", dto.tier, ctx);

    return { plan, quote, paused, wouldPause };
  }

  /**
   * Payer self-serve buy-a-plan (B3 / LC-1 fix). The `payerId` is the VERIFIED SESSION payer
   * (never a body value — XB-A), stamped into the internal {@link BuyPlanDto} and then run
   * through {@link buyPlan} UNCHANGED (same price-resolve → mock pay → capacity chokepoint →
   * spine events). OWNERSHIP of the posting is asserted by the caller (the payer controller's
   * no-oracle `getOneForPayer`) BEFORE this runs, so a payer can only buy a plan for their own
   * posting. This is a thin authz-narrowing wrapper — no new payment/event logic.
   */
  buyPlanForPayer(
    jobPostingId: string,
    payerId: string,
    dto: PayerBuyPlanDto,
    ctx: RequestContext,
  ): Promise<BuyPlanResult> {
    return this.buyPlan(jobPostingId, { payer_id: payerId, tier: dto.tier, coupon: dto.coupon }, ctx);
  }

  /**
   * Payer self-serve buy-a-boost (B3 / LC-1 fix). Session `payerId` (XB-A) → {@link buyBoost}
   * unchanged. Ownership asserted by the caller before this runs (see {@link buyPlanForPayer}).
   */
  buyBoostForPayer(
    jobPostingId: string,
    payerId: string,
    dto: PayerBuyBoostDto,
    ctx: RequestContext,
  ): Promise<{ boost: PostingBoost; quote: Quote }> {
    return this.buyBoost(jobPostingId, { payer_id: payerId, tier: dto.tier, coupon: dto.coupon }, ctx);
  }

  async buyBoost(jobPostingId: string, dto: BuyBoostDto, ctx: RequestContext): Promise<{ boost: PostingBoost; quote: Quote }> {
    if (!(await this.repo.postingExists(jobPostingId))) {
      throw new NotFoundException(`Job posting ${jobPostingId} not found`);
    }
    const now = new Date();
    // B-R3: no overlapping active boost.
    if (await this.repo.findActiveBoost(jobPostingId, now)) {
      throw new ConflictException("an active boost already exists for this posting");
    }
    const quote = await this.resolve("job_boost", dto.tier, dto.coupon, dto.payer_id);
    if (quote.grants.kind !== "boost") {
      throw new BadRequestException("resolved product is not a boost");
    }
    const realCall = areRealPaymentsEnabled(this.config);

    await this.emitPayment("payment.authorized", jobPostingId, dto.payer_id, quote.finalInr, realCall, ctx);
    const boost = await this.repo.insertBoost({
      jobPostingId,
      payerId: dto.payer_id,
      tier: dto.tier,
      status: "active",
      boostStartsAt: now,
      boostEndsAt: new Date(now.getTime() + quote.grants.boostDays * MS_PER_DAY),
    });
    await this.emitPayment("payment.captured", jobPostingId, dto.payer_id, quote.finalInr, realCall, ctx);

    const boosted: PayloadInputOf<"job_posting.boosted"> = {
      boost_id: boost.id,
      job_posting_id: jobPostingId,
      payer_id: dto.payer_id,
      tier: dto.tier,
      boost_days: quote.grants.boostDays,
      price_inr: quote.finalInr,
      real_call: realCall,
    };
    await this.events.emit({
      event_name: "job_posting.boosted",
      actor: { actor_type: "payer", actor_id: dto.payer_id },
      subject: { subject_type: "job_posting", subject_id: jobPostingId },
      payload: boosted,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
    await this.emitCouponIfApplied(quote, dto.payer_id, "job_boost", dto.tier, ctx);

    return { boost, quote };
  }

  /**
   * Buy/upgrade per-payer hiring capacity (ADR-0016) + AUTO-RESUME paused plans.
   * Flow: resolve the capacity tier price → mock payment (real_call honest) →
   * upsertCapacity (RAISE the allowance, stamp source_tier + expires_at from
   * validityDays) → emit capacity.purchased + payment.* → under a per-payer advisory
   * lock, recompute the allowance and flip paused→active oldest-first up to
   * (allowed − currentActive), deferring a posting_plan.resumed per resumed plan, fired
   * post-commit. Idempotency: the advisory-locked recompute is naturally safe and the
   * upsert is keyed on payer_id with a GREATEST guard (a replay never lowers the grant).
   */
  async buyCapacity(payerId: string, dto: BuyCapacityDto, ctx: RequestContext): Promise<BuyCapacityResult> {
    const quote = await this.resolve(CAPACITY_PRODUCT, dto.tier, dto.coupon, payerId);
    if (quote.grants.kind !== "capacity") {
      throw new BadRequestException("resolved product is not a capacity grant");
    }
    const grants = quote.grants;
    const realCall = areRealPaymentsEnabled(this.config);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + grants.validityDays * MS_PER_DAY);

    // Auto-resume runs under the per-payer advisory lock so it cannot race a concurrent
    // buyPlan (count-and-write atomic; ADR-0016 / F-2). The upsert is performed INSIDE
    // the same locked tx so the recompute sees the raised allowance. NO emit in the tx.
    const { resumedPlanIds, deferred } = await this.repo.withTransaction(async (tx) => {
      const deferred: DeferredEmit[] = [];
      await this.repo.lockPayer(tx, payerId);

      await this.repo.upsertCapacity(
        { payerId, maxActiveVacancies: grants.maxActiveVacancies, sourceTier: dto.tier, expiresAt },
        tx,
      );

      // Recompute against the just-raised allowance and resume oldest-first up to the
      // headroom. We use the grant we just upserted directly as `allowed` (the GREATEST
      // upsert guard means the live allowance is at least this), avoiding a re-read of
      // our own in-tx write. The active count IS read tx-scoped under the advisory lock.
      const allowed = grants.maxActiveVacancies;
      const activeNow = await this.repo.countActivePlansForPayer(tx, payerId, now);
      let headroom = allowed - activeNow;

      const resumedPlanIds: string[] = [];
      if (headroom > 0) {
        const paused = await this.repo.listPausedPlansForPayer(tx, payerId);
        for (const plan of paused) {
          if (headroom <= 0) break;
          // Skip a paused plan whose own validity window has expired — it should not
          // resume into 'active' (it would not be a live vacancy). Leave it paused.
          if (plan.expiresAt && plan.expiresAt.getTime() <= now.getTime()) continue;
          await this.repo.setPlanStatus(tx, plan.id, "active");
          resumedPlanIds.push(plan.id);
          deferred.push(() => this.emitPlanResumed(plan.id, plan.jobPostingId, payerId, ctx));
          headroom -= 1;
        }
      }

      deferred.push(() => this.emitPayment("payment.authorized", null, payerId, quote.finalInr, realCall, ctx));
      deferred.push(() => this.emitPayment("payment.captured", null, payerId, quote.finalInr, realCall, ctx));
      deferred.push(() => this.emitCapacityPurchased(payerId, dto.tier, grants.maxActiveVacancies, quote.finalInr, realCall, ctx));
      return { resumedPlanIds, deferred };
    });

    await this.flushEvents(deferred);
    await this.emitCouponIfApplied(quote, payerId, CAPACITY_PRODUCT, dto.tier, ctx);

    return {
      payer_id: payerId,
      quote,
      max_active_vacancies: grants.maxActiveVacancies,
      source_tier: dto.tier,
      expires_at: expiresAt.toISOString(),
      resumed_plan_ids: resumedPlanIds,
    };
  }

  /**
   * The payer's current hiring-capacity allowance (ADR-0016) — a PII-free read for the
   * payer-self portal. Returns the catalog grant + window only (opaque payer_id, codes,
   * counts; no name/phone). When the payer has no row yet, reports the config default
   * allowance so the portal always shows a coherent capacity (no NULL hole).
   */
  async getCapacity(payerId: string): Promise<CapacityView> {
    const now = new Date();
    // Read the allowance row AND the derived live count on ONE tx so the portal sees a
    // consistent snapshot (`active_plan_count` vs `max_active_vacancies`). countActive…
    // is tx-scoped by signature; this is a plain read tx (no advisory lock — display only,
    // not the buy chokepoint). Both reads are PII-free (counts/codes/timestamps only) and
    // scoped to the AUTHENTICATED payerId (XB-A: never a body/param id).
    const { row, activePlanCount } = await this.repo.withTransaction(async (tx) => ({
      row: await this.repo.getCapacity(payerId, tx),
      activePlanCount: await this.repo.countActivePlansForPayer(tx, payerId, now),
    }));
    const maxActiveVacancies =
      row?.maxActiveVacancies ?? this.config.CAPACITY_DEFAULT_MAX_ACTIVE_VACANCIES;
    return {
      payer_id: payerId,
      max_active_vacancies: maxActiveVacancies,
      active_plan_count: activePlanCount,
      source_tier: row?.sourceTier ?? null,
      expires_at: row?.expiresAt ? row.expiresAt.toISOString() : null,
    };
  }

  /** Resolve a price through the one engine, failing closed to an "unavailable" 400. */
  private async resolve(product: string, tier: string, coupon: string | undefined, payerId: string): Promise<Quote> {
    const { catalog } = await this.pricing.getActiveCatalog();
    const usage = coupon ? await this.repo.couponUsage(coupon, payerId) : undefined;
    const result = resolvePrice(catalog, { productCode: product, tierCode: tier, couponCode: coupon, couponUsage: usage });
    if (!result.ok) throw new BadRequestException(`${product}/${tier} is not available`);
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

  private async emitPurchased(
    planId: string,
    jobPostingId: string,
    dto: BuyPlanDto,
    grants: { applicantVisibilityQuota: number; validityDays: number },
    quote: Quote,
    realCall: boolean,
    ctx: RequestContext,
  ): Promise<void> {
    const purchased: PayloadInputOf<"job_posting.purchased"> = {
      plan_id: planId,
      job_posting_id: jobPostingId,
      payer_id: dto.payer_id,
      tier: dto.tier,
      applicant_visibility_quota: grants.applicantVisibilityQuota,
      validity_days: grants.validityDays,
      price_inr: quote.finalInr,
      discount_inr: quote.discountInr,
      coupon_applied: quote.couponApplied !== null,
      real_call: realCall,
    };
    await this.events.emit({
      event_name: "job_posting.purchased",
      actor: { actor_type: "payer", actor_id: dto.payer_id },
      subject: { subject_type: "job_posting", subject_id: jobPostingId },
      payload: purchased,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }

  private async emitPlanPaused(
    planId: string,
    jobPostingId: string,
    payerId: string,
    ctx: RequestContext,
  ): Promise<void> {
    const payload: PayloadInputOf<"posting_plan.paused"> = {
      plan_id: planId,
      job_posting_id: jobPostingId,
      payer_id: payerId,
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
    payerId: string,
    ctx: RequestContext,
  ): Promise<void> {
    const payload: PayloadInputOf<"posting_plan.resumed"> = {
      plan_id: planId,
      job_posting_id: jobPostingId,
      payer_id: payerId,
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
    payerId: string,
    tier: string,
    maxActiveVacancies: number,
    priceInr: number,
    realCall: boolean,
    ctx: RequestContext,
  ): Promise<void> {
    const payload: PayloadInputOf<"capacity.purchased"> = {
      payer_id: payerId,
      tier,
      max_active_vacancies: maxActiveVacancies,
      price_inr: priceInr,
      real_call: realCall,
    };
    await this.events.emit({
      event_name: "capacity.purchased",
      actor: { actor_type: "payer", actor_id: payerId },
      // Payer-scoped subject (subject_id = payer_id), matching the coupon.redeemed precedent.
      subject: { subject_type: "pricing_plan", subject_id: payerId },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }

  private async emitPayment(
    name: "payment.authorized" | "payment.captured",
    jobPostingId: string | null,
    payerId: string,
    amountInr: number,
    realCall: boolean,
    ctx: RequestContext,
  ): Promise<void> {
    const payload: PayloadInputOf<"payment.authorized"> = {
      payer_id: payerId,
      amount_inr: amountInr,
      real_call: realCall,
    };
    await this.events.emit({
      event_name: name,
      actor: { actor_type: "payer", actor_id: payerId },
      // Capacity purchases are not tied to a posting → payer-scoped pricing_plan subject.
      subject: jobPostingId
        ? { subject_type: "job_posting", subject_id: jobPostingId }
        : { subject_type: "pricing_plan", subject_id: payerId },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }

  private async emitCouponIfApplied(
    quote: Quote,
    payerId: string,
    product: string,
    tier: string,
    ctx: RequestContext,
  ): Promise<void> {
    if (quote.couponApplied === null) return;
    const payload: PayloadInputOf<"coupon.redeemed"> = {
      coupon_code: quote.couponApplied,
      payer_id: payerId,
      product,
      tier,
      discount_inr: quote.discountInr,
    };
    await this.events.emit({
      event_name: "coupon.redeemed",
      actor: { actor_type: "payer", actor_id: payerId },
      subject: { subject_type: "pricing_plan", subject_id: payerId },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }
}
