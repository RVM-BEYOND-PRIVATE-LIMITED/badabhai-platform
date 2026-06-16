import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { resolvePrice, type Quote } from "@badabhai/pricing";
import { areRealPaymentsEnabled, type ServerConfig } from "@badabhai/config";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { PostingPlan, PostingBoost } from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import { SERVER_CONFIG } from "../config/config.module";
import { EventsService } from "../events/events.service";
import { PricingService } from "../pricing/pricing.service";
import { PostingPlansRepository } from "./posting-plans.repository";
import type { BuyPlanDto, BuyBoostDto } from "./posting-plans.dto";

const MS_PER_DAY = 86_400_000;

/**
 * Paid job-posting plans + boosters (ADR-0013 Decision B, E-R1: DIRECT purchase, not
 * credits). The flow: resolve the price through the ONE pricing engine → mock payment
 * (PAYMENTS_ENABLE_REAL=false; `real_call` stamped honestly) → write the entitlement row
 * (price/quota/window STAMPED, so a later catalog change can't rewrite the receipt) →
 * emit payment.* + job_posting.purchased/boosted (+ coupon.redeemed). PII-free.
 *
 * Real money is a human-gated escalation (CLAUDE.md §7); a real-enabled flag without a
 * key fails CLOSED at boot (assertPaymentsConfig). No PayerAuthGuard in alpha (launch gate).
 */
@Injectable()
export class PostingPlansService {
  constructor(
    private readonly repo: PostingPlansRepository,
    private readonly events: EventsService,
    private readonly pricing: PricingService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  async buyPlan(jobPostingId: string, dto: BuyPlanDto, ctx: RequestContext): Promise<{ plan: PostingPlan; quote: Quote }> {
    if (!(await this.repo.postingExists(jobPostingId))) {
      throw new NotFoundException(`Job posting ${jobPostingId} not found`);
    }
    const quote = await this.resolve("job_posting", dto.tier, dto.coupon, dto.payer_id);
    if (quote.grants.kind !== "posting") {
      throw new BadRequestException("resolved product is not a posting plan");
    }
    const realCall = areRealPaymentsEnabled(this.config);
    const now = new Date();

    await this.emitPayment("payment.authorized", jobPostingId, dto.payer_id, quote.finalInr, realCall, ctx);
    const plan = await this.repo.insertPlan({
      jobPostingId,
      payerId: dto.payer_id,
      tier: dto.tier,
      applicantVisibilityQuota: quote.grants.applicantVisibilityQuota,
      status: "active",
      paidAt: now,
      expiresAt: new Date(now.getTime() + quote.grants.validityDays * MS_PER_DAY),
    });
    await this.emitPayment("payment.captured", jobPostingId, dto.payer_id, quote.finalInr, realCall, ctx);

    const purchased: PayloadInputOf<"job_posting.purchased"> = {
      plan_id: plan.id,
      job_posting_id: jobPostingId,
      payer_id: dto.payer_id,
      tier: dto.tier,
      applicant_visibility_quota: quote.grants.applicantVisibilityQuota,
      validity_days: quote.grants.validityDays,
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
    await this.emitCouponIfApplied(quote, dto.payer_id, "job_posting", dto.tier, ctx);

    return { plan, quote };
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

  /** Resolve a price through the one engine, failing closed to an "unavailable" 400. */
  private async resolve(product: string, tier: string, coupon: string | undefined, payerId: string): Promise<Quote> {
    const { catalog } = await this.pricing.getActiveCatalog();
    const usage = coupon ? await this.repo.couponUsage(coupon, payerId) : undefined;
    const result = resolvePrice(catalog, { productCode: product, tierCode: tier, couponCode: coupon, couponUsage: usage });
    if (!result.ok) throw new BadRequestException(`${product}/${tier} is not available`);
    return result.quote;
  }

  private async emitPayment(
    name: "payment.authorized" | "payment.captured",
    jobPostingId: string,
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
      subject: { subject_type: "job_posting", subject_id: jobPostingId },
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
