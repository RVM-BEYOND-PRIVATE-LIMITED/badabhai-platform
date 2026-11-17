import {
  Body,
  Controller,
  Header,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { IpRateLimit } from "../common/rate-limit/ip-rate-limit.service";
import { RequestIdempotency } from "../common/idempotency/request-idempotency.service";
import { inFlightConflict } from "../common/idempotency/in-flight-conflict";
import { PayerAuthGuard, CurrentPayer, type AuthenticatedPayer } from "../payers/payer-auth.guard";
import { PayerPhoneProofService } from "./payer-phone-proof.service";
import {
  PayerPhoneProofVerifySchema,
  type PayerPhoneProofCodeResponse,
  type PayerPhoneProofVerifiedResponse,
  type PayerPhoneProofVerifyDto,
} from "./payer-phone-proof.dto";

/**
 * #2754 item 3 — the signed-in company PROVES the phone on its account (`payer_phone_proofs`), so
 * that phone signs it in by SMS code. Session and auth exactly as every other `/payer/me` route:
 * `PayerAuthGuard`, and the account is the GUARD principal only (no body, path or query id), so no
 * company can prove a phone for another.
 *
 * Both routes 404 while `PAYER_SMS_OTP_ENABLED` is off (the check runs after the guard, so an
 * unauthenticated caller still gets the guard's 401). Both carry the per-IP hourly cap of the
 * public sign-in routes, because both can send an SMS; the per-number and daily SMS bounds live in
 * `PayerOtpService`. `no-store`: the answers describe the caller's own account.
 */
@Controller("payer")
@UseGuards(PayerAuthGuard)
export class PayerPhoneProofController {
  constructor(
    private readonly proofs: PayerPhoneProofService,
    private readonly ipRateLimit: IpRateLimit,
    private readonly idempotency: RequestIdempotency,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  /** Send a code by SMS to the phone on the caller's account. */
  @Post("me/phone-proof")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async requestProof(
    @CurrentPayer() payer: AuthenticatedPayer,
    @Req() req: Request,
    @Ctx() ctx: RequestContext,
  ): Promise<PayerPhoneProofCodeResponse> {
    this.assertEnabled();
    await this.assertWithinIpCap(req);
    return this.proofs.requestProof(payer.id, ctx);
  }

  /**
   * Verify the code and record the proof. IDEMPOTENT UNDER `Idempotency-Key`, like the other payer
   * writes: a retry after a lost response replays the first answer (the code is single-use, so a
   * re-run would otherwise answer 401 to a company whose phone was in fact proven).
   */
  @Post("me/phone-proof/verify")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async verifyProof(
    @CurrentPayer() payer: AuthenticatedPayer,
    @Body(new ZodValidationPipe(PayerPhoneProofVerifySchema)) dto: PayerPhoneProofVerifyDto,
    @Req() req: Request,
    @Ctx() ctx: RequestContext,
  ): Promise<PayerPhoneProofVerifiedResponse> {
    this.assertEnabled();
    await this.assertWithinIpCap(req);
    return this.idempotency.runOnce({
      namespace: "payer_idem",
      // Its OWN scope: a key reused on another payer write is never served this answer.
      scope: "phone_proof_verify",
      // The SESSION payer: one company can never be served another's stored answer.
      subject: payer.id,
      subjectLabel: "payer",
      logLabel: "payer",
      idempotencyKey: req.header("idempotency-key"),
      inFlight: (): never => {
        throw inFlightConflict(
          "This phone check is already being processed; check your account before trying again",
        );
      },
      work: () => this.proofs.verifyProof(payer.id, dto.code, ctx),
    });
  }

  /** 404 while company SMS sign-in is off, before any counter moves (the service re-checks). */
  private assertEnabled(): void {
    if (!this.config.PAYER_SMS_OTP_ENABLED) throw new NotFoundException("Not found");
  }

  /** The per-IP hourly cap the public sign-in routes use (fails closed on Redis down). */
  private assertWithinIpCap(req: Request): Promise<void> {
    return this.ipRateLimit.assertWithinHourlyIpCap(
      "payer_auth",
      req.ip ?? "unknown",
      this.config.PAYER_AUTH_MAX_PER_IP_PER_HOUR,
    );
  }
}
