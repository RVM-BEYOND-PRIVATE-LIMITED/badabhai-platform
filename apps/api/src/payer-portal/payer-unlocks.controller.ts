import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { PayerAuthGuard, CurrentPayer, type AuthenticatedPayer } from "../payers/payer-auth.guard";
import { PayerDisclosureRateLimit } from "../payers/payer-disclosure-rate-limit.service";
import { UnlockService } from "../unlocks/unlocks.service";
import {
  CreateCreditOrderSchema,
  type CreateCreditOrderDto,
  VerifyCreditPaymentSchema,
  type VerifyCreditPaymentDto,
} from "../unlocks/razorpay-webhook.dto";
import {
  PayerBuyPackSchema,
  type PayerBuyPackDto,
  PayerRequestUnlockSchema,
  type PayerRequestUnlockDto,
  PayerLedgerQuerySchema,
  type PayerLedgerQueryDto,
} from "./payer-unlocks.dto";

/**
 * Payer-SELF disclosure surface (ADR-0019 Phase 1 — closes R16 / LC-1 / TD33).
 *
 * A NEW route group under `/payer/*`, gated by {@link PayerAuthGuard}, DISTINCT from the
 * ops `/unlocks*` routes (InternalServiceGuard) which stay for ops-run support — one
 * principal per route, never conflated. Every action is bound to the caller's OWN
 * `payer_id` **derived from the verified session** (`req.payer.id`); the body never
 * carries `payer_id` (XB-A). It REUSES the {@link UnlockService} chokepoint unchanged —
 * fail-closed ordering, no-oracle neutral bodies, PII-free `unlock.*`/`payment.*` events.
 *
 * SECURITY GATE: this opens an external untrusted boundary — a `bb-security-review` PASS
 * (XB-A…XB-H) is required before merge. Mock + staging-only (PAYMENTS_ENABLE_REAL=false).
 */
@Controller("payer")
@UseGuards(PayerAuthGuard)
export class PayerUnlocksController {
  constructor(
    private readonly unlocks: UnlockService,
    private readonly disclosureRate: PayerDisclosureRateLimit,
  ) {}

  /**
   * Request a routed-contact unlock for a candidate. The `payer_id` is the SESSION
   * payer — never a body value (XB-A). A per-PAYER hourly cap (XB-G) throttles this
   * payer's harvest velocity BEFORE the chokepoint, complementing the payer-independent
   * per-worker cap (XB-B). Returns the same one-distinguishable-success / byte-identical-
   * neutral body as the ops path (no-oracle, F-3).
   */
  @Post("unlocks")
  @HttpCode(200)
  async requestUnlock(
    @Body(new ZodValidationPipe(PayerRequestUnlockSchema)) dto: PayerRequestUnlockDto,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ) {
    await this.disclosureRate.assertWithinHourlyCap(payer.id); // XB-G (real identity)
    return this.unlocks.requestUnlock(
      { payerId: payer.id, workerId: dto.worker_id, jobId: dto.job_id },
      ctx,
    );
  }

  /**
   * Reveal a granted unlock the caller OWNS. Ownership is enforced at the chokepoint
   * (`expectedPayerId = payer.id`): a not-owned or unknown unlock returns the IDENTICAL
   * neutral body — never a 403 — so a payer cannot probe other tenants' unlocks (XB-A
   * + no-oracle). The per-PAYER disclosure cap (XB-G) also covers the reveal action.
   * HTTP 200 in all cases.
   */
  @Post("unlocks/:unlockId/reveal")
  @HttpCode(200)
  async reveal(
    @Param("unlockId", new ParseUUIDPipe()) unlockId: string,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ) {
    await this.disclosureRate.assertWithinHourlyCap(payer.id); // XB-G (real identity)
    return this.unlocks.reveal(unlockId, ctx, payer.id);
  }

  /** List the caller's OWN unlocks (scoped to the session `payer_id`; PII-free projection). */
  @Get("unlocks")
  listOwn(@CurrentPayer() payer: AuthenticatedPayer) {
    return this.unlocks.listByPayer(payer.id);
  }

  /** The caller's OWN credit balance (amounts + id only). */
  @Get("credits")
  ownCredits(@CurrentPayer() payer: AuthenticatedPayer) {
    return this.unlocks.getCredits(payer.id);
  }

  /**
   * The caller's OWN credit ledger — the append-only movement history behind the balance
   * (amounts + opaque ids only; PII-free by table design). Scoped to the SESSION `payer_id`
   * (XB-A) — never a body/param value; a payer only ever sees their own rows. Newest first,
   * bounded page size. Read-only: no event.
   */
  @Get("credits/ledger")
  creditsLedger(
    @Query(new ZodValidationPipe(PayerLedgerQuerySchema)) query: PayerLedgerQueryDto,
    @CurrentPayer() payer: AuthenticatedPayer,
  ) {
    return this.unlocks.getCreditLedger(payer.id, query.limit);
  }

  /**
   * Buy a credit pack for the caller. The `payer_id` is the SESSION payer — never a
   * body value (XB-A); the body carries only the pack CODE. The pack (price + credits)
   * is resolved from config by {@link UnlockService.purchaseCredits}, which mock-
   * purchases (real_call:false) and emits payment.authorized + payment.captured.
   *
   * An UNKNOWN pack returns a real 404 (NestJS NotFoundException) — this is NOT the
   * unlock no-oracle path: a pack code is a public catalog item, not a per-tenant
   * resource, so a 404 leaks nothing about another payer.
   *
   * MUTUAL EXCLUSION WITH THE REAL PATH (GAP-PAY-04). This route grants a pack's credits
   * through `purchasePackMock` with NO money taken (`real_call:false`). It is the correct
   * default while `PAYMENTS_ENABLE_REAL` is off. But the moment real payments are switched
   * on, `POST /payer/credits/order` starts charging through Razorpay while this route would
   * still hand out the SAME credits for free — a paywall bypass sitting beside the paywall.
   * So the two are now mutually exclusive by construction: with real payments live this
   * answers the same NEUTRAL 404 that `/credits/order` gives when they are off. Neither
   * route ever leaks which mode the deployment is in.
   */
  @Post("credits")
  @HttpCode(201)
  async buyPack(
    @Body(new ZodValidationPipe(PayerBuyPackSchema)) dto: PayerBuyPackDto,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ) {
    if (this.unlocks.realPaymentsLive) throw new NotFoundException();
    const result = await this.unlocks.purchaseCredits(payer.id, dto.pack_code, ctx);
    if (!result) throw new NotFoundException(`Unknown credit pack: ${dto.pack_code}`);
    return result;
  }

  /**
   * Create a REAL Razorpay order for a credit pack (real-payments stream).
   *
   * XB-A: the payer is the SESSION payer — never a body value. XT5: the body carries ONLY
   * the pack code. There is no `amount`, no `credits`, no `currency` field anywhere on this
   * route, so a client cannot name its own price; the ₹ comes from the same catalog path
   * (`resolvePack`) the portal advertised (D-6).
   *
   * LAUNCH GATE: with `PAYMENTS_ENABLE_REAL` off (the default) this route answers a NEUTRAL
   * 404 — identical to a route that does not exist. It is not a 501/503, because "real
   * payments exist but are switched off here" is configuration state a caller has no need
   * to learn. The MOCK path (`POST /payer/credits`) is untouched and remains the default.
   *
   * The response carries the `rzp_*` KEY ID, which is public by design (checkout.js needs
   * it in the browser). The key SECRET and the webhook secret never appear in any response.
   */
  @Post("credits/order")
  @HttpCode(201)
  async createOrder(
    @Body(new ZodValidationPipe(CreateCreditOrderSchema)) dto: CreateCreditOrderDto,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ) {
    if (!this.unlocks.realPaymentsLive) throw new NotFoundException();
    const order = await this.unlocks.createCreditOrder(payer.id, dto.pack_code, ctx);
    // Unknown pack → a real 404 (a public catalog item, not a per-tenant resource).
    if (!order) throw new NotFoundException(`Unknown credit pack: ${dto.pack_code}`);
    return {
      order_id: order.providerOrderId,
      key_id: order.keyId,
      amount: order.amountPaise, // paise — what checkout.js expects
      amount_inr: order.amountInr, // whole ₹ — what the UI displays
      currency: order.currency,
      pack_code: order.packCode,
      credits: order.credits,
    };
  }

  /**
   * Verify a browser-returned Razorpay checkout result and credit the pack.
   *
   * THE CLIENT-SIDE FALLBACK, not the source of truth — the webhook is. It exists because a
   * real buyer on a flaky Indian mobile network sees checkout succeed seconds before the
   * webhook reaches us, and must not be told their purchase failed. It settles through the
   * SAME idempotent order row as the webhook, so the two converge and can race safely.
   *
   * XB-A: the payer is the SESSION payer; the order must belong to them. A bad signature, an
   * unknown order, and another tenant's order all return the SAME neutral 404 — this route
   * is not an order-id oracle. HTTP 200 only on a genuinely verified payment.
   */
  @Post("credits/verify")
  @HttpCode(200)
  async verifyPayment(
    @Body(new ZodValidationPipe(VerifyCreditPaymentSchema)) dto: VerifyCreditPaymentDto,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ) {
    if (!this.unlocks.realPaymentsLive) throw new NotFoundException();
    const result = await this.unlocks.verifyCheckoutPayment(
      payer.id,
      {
        orderId: dto.razorpay_order_id,
        paymentId: dto.razorpay_payment_id,
        signature: dto.razorpay_signature,
      },
      ctx,
    );
    // Byte-identical refusal for every failure mode (forged signature / unknown order /
    // someone else's order): the caller learns only "not verified".
    if (!result.verified) throw new NotFoundException();
    return {
      payer_id: result.payer_id,
      balance: result.balance,
      credits: result.credits,
      pack_code: result.pack_code,
    };
  }
}
