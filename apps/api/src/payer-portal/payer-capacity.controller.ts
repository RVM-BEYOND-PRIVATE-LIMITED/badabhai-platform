import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { Ctx, type RequestContext } from "../common/request-context";
import { RequestIdempotency } from "../common/idempotency/request-idempotency.service";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { PayerAuthGuard, CurrentPayer, type AuthenticatedPayer } from "../payers/payer-auth.guard";
import { PostingPlansService, type CapacityView } from "../posting-plans/posting-plans.service";
import { BuyCapacitySchema, type BuyCapacityDto } from "../posting-plans/posting-plans.dto";

/**
 * Payer-SELF hiring-capacity surface (ADR-0019 + ADR-0016). A payer may view and buy
 * THEIR OWN capacity allowance. This group is behind {@link PayerAuthGuard} and the
 * `payer_id` is ALWAYS the verified session payer (`req.payer.id`) — there is NO
 * `:payerId` param and the body carries NO `payer_id`, so a payer can never act under
 * another payer's id (XB-A, the IDOR guarantee).
 *
 * #1166 (2026-08-26): this is now the ONLY route onto {@link PostingPlansService}'s
 * capacity surface — the ops `CapacityController` (`InternalServiceGuard`, ADVISORY
 * `:payerId` param) that used to sit alongside it was RETIRED (no caller anywhere in the
 * repo; see the module docstring in `posting-plans.module.ts`).
 *
 * Thin HTTP only: validation via {@link ZodValidationPipe}; the price resolution, the
 * mock payment (PAYMENTS_ENABLE_REAL=false / real_call honest), the advisory-locked
 * auto-resume, and every capacity/payment spine event live in {@link PostingPlansService},
 * reused unchanged (mirrors how {@link import("./payer-unlocks.controller").PayerUnlocksController}
 * reuses UnlockService). Mock + staging-only; a `bb-security-review` PASS is the pre-merge gate.
 */
@Controller("payer/capacity")
@UseGuards(PayerAuthGuard)
export class PayerCapacityController {
  constructor(
    private readonly plans: PostingPlansService,
    private readonly idempotency: RequestIdempotency,
  ) {}

  /**
   * The caller's OWN capacity allowance (PII-free: opaque payer_id + counts/codes/window).
   * Includes `active_plan_count` — the derived live count of the SESSION payer's active
   * plans (XB-A: from `@CurrentPayer()`, never a body/param id) — so the portal can show
   * usage against the allowance.
   */
  @Get()
  ownCapacity(@CurrentPayer() payer: AuthenticatedPayer): Promise<CapacityView> {
    return this.plans.getCapacity(payer.id);
  }

  /**
   * Buy/upgrade the caller's OWN capacity. The `payer_id` is the SESSION payer — never
   * a body/param value (XB-A). Delegates to {@link PostingPlansService.buyCapacity},
   * which mock-pays + auto-resumes paused plans + emits the spine events.
   *
   * IDEMPOTENT UNDER `Idempotency-Key` (#1148), the same defect and the same seam as
   * `POST /payer/credits` (#1046). Without it: the app posts, the link times out after the
   * server has already committed, the payer taps again, and the purchase runs twice.
   *
   * WHY THERE IS NO NATURAL KEY HERE, which is the whole design question and is NOT answered
   * by copying the credits route. `POST /payer/unlocks` can be idempotent by `(payer, worker)`
   * because it writes a per-purchase GRANT row; boosts key on `posting_boosts`, the immutable
   * one-row-per-purchase receipt. Capacity writes no such artifact: `payer_capacity` is ONE
   * mutable allowance row per payer (`payer_capacity_payer_id_uq`) that `upsertCapacity`
   * collapses every buy into, so two identical purchases and one leave identical rows. There
   * is nothing for a natural key to be a key OF.
   *
   * The one candidate, `(payer, tier)`, would block a legitimate action. `maxActiveVacancies`
   * is monotonic (`greatest`), but `expiresAt` is REPLACED on every buy, so re-buying the
   * SAME tier RENEWS the window — and the catalog window is 30 days, which makes that next
   * month's ordinary renewal rather than a theoretical case. Only the caller can say whether
   * two identical requests are one intent or two.
   *
   * WHAT A DUPLICATE COSTS, so the stakes are not understated: the allowance does not move, but
   * `payment.authorized` + `payment.captured` + `capacity.purchased` all fire a second time —
   * and with a coupon it also burns a redemption permanently, because the coupon caps are
   * enforced by COUNTING `coupon.redeemed` rows on the spine.
   *
   * NO DEPLOYMENT-MODE GATE HERE, deliberately unlike `POST /payer/credits`. That route 404s
   * when real payments are live because a free mock grant would sit beside a real paywall.
   * Capacity has no real-payments path at all, so the same gate would DELETE the purchase
   * route rather than guard it — that is GAP-PAY-05 and an open product decision, not
   * something to inherit by analogy.
   */
  @Post()
  @HttpCode(201)
  buyCapacity(
    @Body(new ZodValidationPipe(BuyCapacitySchema)) dto: BuyCapacityDto,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Req() req: Request,
    @Ctx() ctx: RequestContext,
  ) {
    return this.idempotency.runOnce({
      namespace: "payer_idem",
      // Its OWN scope. Sharing `credits_purchase` would put two different purchases in one
      // dedupe bucket, so a client reusing a key across both would be served the wrong result.
      scope: "capacity_purchase",
      // The SESSION payer (XB-A). Scoping the key by it is a safety property, not bookkeeping:
      // without it, one payer could present another's key and be served their stored purchase.
      subject: payer.id,
      subjectLabel: "payer",
      logLabel: "payer",
      idempotencyKey: req.header("idempotency-key"),
      // 409, not an optimistic answer — the same call the credits route makes, for the same
      // reason. A capacity buy cannot invent an allowance, an expiry, or a resumed-plan list it
      // has not computed; a guessed number would have the app render a state that never
      // existed. The caller's correct response is to re-read `GET /payer/capacity`.
      inFlight: (): never => {
        throw new ConflictException(
          "This capacity purchase is already being processed; check your capacity before trying again",
        );
      },
      work: () => this.plans.buyCapacity(payer.id, dto, ctx),
    });
  }
}
