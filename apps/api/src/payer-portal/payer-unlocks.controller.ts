import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { PayerAuthGuard, CurrentPayer, type AuthenticatedPayer } from "../payers/payer-auth.guard";
import { PayerDisclosureRateLimit } from "../payers/payer-disclosure-rate-limit.service";
import { UnlockService } from "../unlocks/unlocks.service";
import { PayerRequestUnlockSchema, type PayerRequestUnlockDto } from "./payer-unlocks.dto";

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
}
