import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import {
  PayerAuthGuard,
  CurrentPayer,
  type AuthenticatedPayer,
} from "../payers/payer-auth.guard";
import { assertPayerOwns } from "../payers/payer-scope";
import { PayerDisclosureRateLimit } from "../payers/payer-disclosure-rate-limit.service";
import { UnlockService } from "./unlocks.service";
import {
  RequestUnlockSchema,
  PurchaseCreditsSchema,
  type RequestUnlockDto,
  type PurchaseCreditsDto,
} from "./unlocks.dto";

/**
 * Contact Unlock + Reveal HTTP surface (ADR-0010, Stream A). Thin — all logic + event
 * emission + the fail-closed ordering live in {@link UnlockService} (the chokepoint).
 *
 * GUARD (ALL routes): {@link PayerAuthGuard} (R16 / LC-1, ADR-0019 Phase 1). This is
 * the SELF-SERVE payer disclosure surface: every action is bound to the AUTHENTICATED
 * session payer (`req.payer.id`) — the body/query never carries `payer_id`, and the
 * `/payers/:payerId/credits` path param is asserted to equal the session payer
 * (`assertPayerOwns`, XB-A). This REPLACES the interim `InternalServiceGuard` seam
 * (which trusted a body/param `payer_id` under a shared secret — "payer owns the row"
 * was unenforceable there). One principal per route: the ops `/reach/*` track and the
 * worker track are distinct guards.
 *
 * Layered caps on the disclosure path: the per-PAYER hourly cap (XB-G,
 * {@link PayerDisclosureRateLimit}) throttles a single account's harvest velocity
 * BEFORE the chokepoint; the per-WORKER shared cap (XB-B) lives in the chokepoint.
 *
 * No `@Controller` prefix: the routes span `/unlocks` and `/payers/...`, and the ADR
 * pins those exact paths. Responses are PII-FREE — never a phone / number / deny reason.
 * Mock + staging-only (PAYMENTS_ENABLE_REAL=false); real payments are a human-gated stream.
 */
@Controller()
@UseGuards(PayerAuthGuard)
export class UnlocksController {
  constructor(
    private readonly unlocks: UnlockService,
    private readonly disclosureRate: PayerDisclosureRateLimit,
  ) {}

  /**
   * Request a routed-contact unlock for a candidate profile. Runs F-1 → [4]. The
   * `payer_id` is the SESSION payer — never a body value (XB-A). The per-PAYER hourly
   * cap (XB-G) throttles harvest velocity before the chokepoint. Returns the byte-
   * identical neutral body for EVERY deny branch (no_consent / capped / unknown_worker /
   * already-owned-by-another / insufficient-credits), or the one distinguishable success
   * `{ ok, unlock_id, status, expires_at }`. NEVER a phone or the internal deny reason.
   * HTTP 200 in all cases (status is not an oracle, F-3).
   */
  @Post("unlocks")
  @HttpCode(200)
  async requestUnlock(
    @Body(new ZodValidationPipe(RequestUnlockSchema)) dto: RequestUnlockDto,
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
   * Resolve the routed channel for a granted unlock the caller OWNS (a contact attempt;
   * step [5]). Ownership is enforced AT the chokepoint (`expectedPayerId = payer.id`): a
   * not-owned OR unknown/expired/over-cap/revoked unlock returns the SAME neutral body
   * (NOT a 404, NOT a 403) — so a payer cannot probe other tenants' unlocks (XB-A +
   * no-oracle, F-3). Returns `{ relay_handle, channel, expires_at }` — an opaque, non-
   * reversible, expiring handle, NEVER a phone/number. HTTP 200 in all cases.
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

  /**
   * A single unlock the caller OWNS (PII-free projection). No-oracle: an unknown unlock
   * AND another payer's unlock both return the IDENTICAL neutral 404 — a payer learns
   * nothing about other tenants' unlock ids (XB-A, mirrors the disclosure no-oracle rule).
   */
  @Get("unlocks/:unlockId")
  async getOwn(
    @Param("unlockId", new ParseUUIDPipe()) unlockId: string,
    @CurrentPayer() payer: AuthenticatedPayer,
  ) {
    const unlock = await this.unlocks.getOne(unlockId);
    if (!unlock || unlock.payer_id !== payer.id) {
      throw new NotFoundException(`Unlock ${unlockId} not found`);
    }
    return unlock;
  }

  /** The caller's OWN credit balance (amounts + id only). The `:payerId` param MUST equal the session payer (XB-A). */
  @Get("payers/:payerId/credits")
  ownCredits(
    @Param("payerId", new ParseUUIDPipe()) payerId: string,
    @CurrentPayer() payer: AuthenticatedPayer,
  ) {
    assertPayerOwns(payer.id, payerId); // reject a cross-payer read (403, no-oracle)
    return this.unlocks.getCredits(payer.id);
  }

  /**
   * MOCK credit-pack SELF-purchase (alpha — NO real money). Binds to the SESSION payer:
   * the `:payerId` path param must equal the authenticated payer (`assertPayerOwns`) —
   * THE horizontal-authz blocker (XB-A: payer A can never buy credits against payer B's
   * id). Grants the pack's credits, appends the ledger, emits payment.authorized +
   * payment.captured with real_call:false. A real Razorpay purchase is a LATER human-
   * gated stream (§D5). 404 on an unknown pack_code (NOT the unlock no-oracle path).
   */
  @Post("payers/:payerId/credits")
  @HttpCode(200)
  async purchaseCredits(
    @Param("payerId", new ParseUUIDPipe()) payerId: string,
    @Body(new ZodValidationPipe(PurchaseCreditsSchema)) dto: PurchaseCreditsDto,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ) {
    assertPayerOwns(payer.id, payerId); // cross-payer purchase blocker (XB-A)
    const result = await this.unlocks.purchaseCredits(payer.id, dto.pack_code, ctx);
    if (!result) throw new NotFoundException(`Unknown credit pack ${dto.pack_code}`);
    return result;
  }
}
