import { Controller, Get, UseGuards } from "@nestjs/common";
import { PayerAuthGuard, CurrentPayer, type AuthenticatedPayer } from "./payer-auth.guard";
import { PayerAccountService } from "./payer-account.service";
import type { PayerMeDto } from "./payer-account.dto";

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

  /** The authenticated payer's OWN account. No other payer is reachable. */
  @Get("me")
  me(@CurrentPayer() payer: AuthenticatedPayer): Promise<PayerMeDto> {
    return this.account.getOwnAccount(payer.id);
  }
}
