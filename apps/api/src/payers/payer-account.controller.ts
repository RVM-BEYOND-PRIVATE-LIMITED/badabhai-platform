import { Body, Controller, Get, Header, Patch, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { PayerAuthGuard, CurrentPayer, type AuthenticatedPayer } from "./payer-auth.guard";
import { PayerAccountService } from "./payer-account.service";
import { PayerUpdateSchema, type PayerMeDto, type PayerUpdateDto } from "./payer-account.dto";

/**
 * The FIRST payer-authenticated route group (ADR-0019 LC-1 / TD33, slice 1).
 *
 * Every route here is reachable by EXACTLY ONE principal class — the payer session
 * via {@link PayerAuthGuard} (distinct from the worker session and the ops
 * `InternalServiceGuard`). The authenticated `payerId` is taken ONLY from the guard
 * principal (`@CurrentPayer`); it is NEVER read from the body/param/query, so no
 * payer can reach another payer's account (horizontal-authz, Decision C — proven by
 * `payer-account.controller.test.ts`).
 */
@Controller("payer")
@UseGuards(PayerAuthGuard)
export class PayerAccountController {
  constructor(private readonly account: PayerAccountService) {}

  /**
   * The authenticated payer's OWN account (incl. their own email + masked phone). No other
   * payer is reachable. `no-store` so the response — which carries the payer's own contact —
   * is never written to a shared/proxy cache.
   */
  @Get("me")
  @Header("Cache-Control", "no-store")
  me(@CurrentPayer() payer: AuthenticatedPayer): Promise<PayerMeDto> {
    return this.account.getOwnAccount(payer.id);
  }

  /**
   * Self-edit the authenticated payer's OWN org display name and/or contact phone (PROF-3).
   * Email/role/status are IMMUTABLE — they are not fields on {@link PayerUpdateSchema}, and
   * its `.strict()` rejects them (and a body `payer_id`, and any unknown key) with a 400; an
   * empty body is also a 400 ("nothing to update"). The id is the GUARD principal ONLY (never
   * the body), so no payer can edit another's account. `no-store` for the same reason as `me`
   * — the response carries the payer's own contact. Returns the updated {@link PayerMeDto}.
   */
  @Patch("me")
  @Header("Cache-Control", "no-store")
  updateMe(
    @CurrentPayer() payer: AuthenticatedPayer,
    @Body(new ZodValidationPipe(PayerUpdateSchema)) patch: PayerUpdateDto,
    @Ctx() ctx: RequestContext,
  ): Promise<PayerMeDto> {
    return this.account.updateOwnAccount(payer.id, patch, ctx);
  }
}
