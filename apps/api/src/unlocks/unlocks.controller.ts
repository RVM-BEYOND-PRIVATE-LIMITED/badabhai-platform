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
import { InternalServiceGuard } from "../common/guards/internal-service.guard";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { UnlockService } from "./unlocks.service";
import {
  RequestUnlockSchema,
  ListUnlocksQuerySchema,
  PurchaseCreditsSchema,
  type RequestUnlockDto,
  type ListUnlocksQueryDto,
  type PurchaseCreditsDto,
} from "./unlocks.dto";

/**
 * Contact Unlock + Reveal HTTP surface (ADR-0010, Stream A). Thin — all logic + event
 * emission + the fail-closed ordering live in {@link UnlockService} (the chokepoint).
 *
 * GUARD (ALL routes): InternalServiceGuard — the INTERIM payer-auth seam (F-7 launch
 * gate). There is NO per-payer identity here: `payer_id` comes from the request
 * body/param and is trusted ONLY because the caller is the shared-secret holder
 * (backend/ops). "Payer owns the unlock" is UNENFORCEABLE under a shared secret — a
 * real PayerAuthGuard (with a horizontal-authz test) is a HARD LAUNCH GATE before any
 * client-facing payer surface. Do NOT ship a production payer surface on this guard.
 *
 * STATUS (2026-06-29, LC-1 audit + TL decision — safe-interim, full hardening tracked):
 * the CLIENT-facing payer money surface is ALREADY CLOSED — payer-web rides PayerAuthGuard
 * `/payer/*` ({@link import("../payer-portal/payer-unlocks.controller").PayerUnlocksController})
 * EXCLUSIVELY; body `payer_id` is gone there (XB-A) and reveal enforces ownership at the
 * UnlockService chokepoint (not-owned/unknown → identical neutral body, no IDOR/oracle).
 * This `/unlocks*` + `/payers/:id/credits` set is therefore **OPS-ONLY — it MUST NEVER be
 * network-exposed to payers/clients**; an internal-token holder can still act as any payer
 * (the residual, internal-only LC-1/TD33/F-7 surface). Fully retiring the ops WRITE money
 * routes + moving the ops-console credit-grant to the governed AdminAuthGuard
 * `POST /admin/payers/:id/credits` is BLOCKED-BY two unbuilt prerequisites: (1) ops-console
 * admin auth (deferred ADMIN-4..8 / OBS-4 — `apps/web` has only INTERNAL_SERVICE_TOKEN, no
 * admin login), and (2) a headless/dev payer-session mint for `db:verify:demand` (payer OTP
 * is real-only). Tracked: TD33 + TD50. The one-principal-per-route split is pinned by
 * `guard-contract.test.ts` (Unlocks=[InternalServiceGuard]; PayerUnlocks=[PayerAuthGuard]).
 *
 * No `@Controller` prefix: the routes span `/unlocks` and `/payers/...`, and the ADR
 * pins those exact paths. Responses are PII-FREE — never a phone / number / deny reason.
 */
@Controller()
@UseGuards(InternalServiceGuard)
export class UnlocksController {
  constructor(private readonly unlocks: UnlockService) {}

  /**
   * Request a routed-contact unlock for a candidate profile. Runs F-1 → [4]. Returns
   * the byte-identical neutral body for EVERY deny branch (no_consent / capped /
   * unknown_worker / already-owned-by-another / insufficient-credits), or the one
   * distinguishable success `{ ok, unlock_id, status, expires_at }`. NEVER a phone or
   * the internal deny reason. HTTP 200 in all cases (status is not an oracle, F-3).
   */
  @Post("unlocks")
  @HttpCode(200)
  requestUnlock(
    @Body(new ZodValidationPipe(RequestUnlockSchema)) dto: RequestUnlockDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.unlocks.requestUnlock(
      { payerId: dto.payer_id, workerId: dto.worker_id, jobId: dto.job_id },
      ctx,
    );
  }

  /**
   * Resolve the routed channel for a granted unlock (a contact attempt; step [5]).
   * Returns `{ relay_handle, channel, expires_at }` — an opaque, non-reversible,
   * expiring handle, NEVER a phone/number. Returns the SAME neutral body (NOT a 404)
   * for unknown/expired/over-cap/revoked (F-3). HTTP 200 in all cases.
   */
  @Post("unlocks/:unlockId/reveal")
  @HttpCode(200)
  reveal(@Param("unlockId", new ParseUUIDPipe()) unlockId: string, @Ctx() ctx: RequestContext) {
    return this.unlocks.reveal(unlockId, ctx);
  }

  /** Ops: a payer's unlocks (PII-free projection — worker_id only, NO routing token). */
  @Get("unlocks")
  listUnlocks(@Query(new ZodValidationPipe(ListUnlocksQuerySchema)) query: ListUnlocksQueryDto) {
    return this.unlocks.listByPayer(query.payer_id);
  }

  /** Ops: a single unlock (PII-free projection). 404 if unknown (ops route, not a payer oracle). */
  @Get("unlocks/:unlockId")
  async getUnlock(@Param("unlockId", new ParseUUIDPipe()) unlockId: string) {
    const unlock = await this.unlocks.getOne(unlockId);
    if (!unlock) throw new NotFoundException(`Unlock ${unlockId} not found`);
    return unlock;
  }

  /** Ops: a payer's credit balance (amounts + id only). */
  @Get("payers/:payerId/credits")
  getCredits(@Param("payerId", new ParseUUIDPipe()) payerId: string) {
    return this.unlocks.getCredits(payerId);
  }

  /**
   * MOCK credit-pack purchase / ops top-up (alpha — NO real money). Grants the pack's
   * credits, appends the ledger, emits payment.authorized + payment.captured with
   * real_call:false. A real Razorpay purchase is a LATER human-gated stream (§D5).
   * 404 on an unknown pack_code (this is NOT the unlock no-oracle path).
   */
  @Post("payers/:payerId/credits")
  @HttpCode(200)
  async purchaseCredits(
    @Param("payerId", new ParseUUIDPipe()) payerId: string,
    @Body(new ZodValidationPipe(PurchaseCreditsSchema)) dto: PurchaseCreditsDto,
    @Ctx() ctx: RequestContext,
  ) {
    const result = await this.unlocks.purchaseCredits(payerId, dto.pack_code, ctx);
    if (!result) throw new NotFoundException(`Unknown credit pack ${dto.pack_code}`);
    return result;
  }
}
