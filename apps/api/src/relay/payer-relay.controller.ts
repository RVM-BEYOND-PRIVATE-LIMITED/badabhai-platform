import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import {
  PayerAuthGuard,
  CurrentPayer,
  type AuthenticatedPayer,
} from "../payers/payer-auth.guard";
import { RelayService } from "./relay.service";
import {
  PayerRelaySendSchema,
  RelayHandleSchema,
  type PayerRelaySendDto,
  type RelayTemplateWire,
} from "./relay.dto";

/**
 * The payer half of the in-app relay (E0 item 3, `docs/agent/phases/E0_BUILD.md`).
 *
 * Payer-SELF surface under `/payer/*`, gated by {@link PayerAuthGuard} — the same pair
 * `PayerUnlocksController` uses. The payer id comes from the verified session, never the
 * body (XB-A); the ONLY identifier the payer sends is the opaque `relay_handle` they hold,
 * which is exactly what E0_BUILD requires ("THE HANDLE IS THE ONLY THING THE PAYER HOLDS").
 *
 * Every resolution failure serves the ONE neutral body, so this surface cannot be used as
 * a worker-state oracle (F-3). The only distinguishable failure is a 400 for free text
 * before the worker has replied — a fact about the thread the payer owns, not about the
 * worker (see {@link RelayService}).
 */
@Controller("payer")
@UseGuards(PayerAuthGuard)
export class PayerRelayController {
  constructor(private readonly relay: RelayService) {}

  /**
   * The closed opening-template catalogue. The composer MUST render from this — a copy
   * duplicated into a client is the drift the closed set exists to prevent.
   */
  @Get("relay/templates")
  templates(): { templates: readonly RelayTemplateWire[] } {
    return this.relay.listTemplates();
  }

  /**
   * Send a message into the unlock's thread. Opening = a closed template; free text only
   * after the worker has replied (§B ruling).
   */
  @Post("relay/:handle/messages")
  @HttpCode(201)
  send(
    @Param("handle", new ZodValidationPipe(RelayHandleSchema)) handle: string,
    @Body(new ZodValidationPipe(PayerRelaySendSchema)) dto: PayerRelaySendDto,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ) {
    return this.relay.sendFromPayer(payer.id, handle, dto, ctx);
  }
}
