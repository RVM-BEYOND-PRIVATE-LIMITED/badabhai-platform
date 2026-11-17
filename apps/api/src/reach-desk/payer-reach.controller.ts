import {
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { CurrentPayer, PayerAuthGuard, type AuthenticatedPayer } from "../payers/payer-auth.guard";
import { ReachDeskService, type PayerReachCaseView } from "./reach-desk.service";

/**
 * #2750 item 7 — the company's "couldn't reach" button (brief 4C.9, B7-13).
 *
 *   POST /payer/unlocks/:unlockId/couldnt-reach   report it (idempotent: a second report answers
 *                                                 the first case). 409 REPORT_WINDOW_CLOSED after
 *                                                 day `couldntReachWindowDays` (IST) of the open.
 *   GET  /payer/unlocks/:unlockId/couldnt-reach   the case's state (404 when never reported).
 *
 * Both answer the neutral 404 while the credit rules are off for the company, and for an open that
 * is not the company's. The reporter is the session's login; the case is the company's (tenant).
 */
@Controller("payer")
@UseGuards(PayerAuthGuard)
export class PayerReachController {
  constructor(private readonly desk: ReachDeskService) {}

  @Post("unlocks/:unlockId/couldnt-reach")
  @HttpCode(200)
  report(
    @Param("unlockId", new ParseUUIDPipe()) unlockId: string,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ): Promise<PayerReachCaseView> {
    return this.desk.report(payer.id, unlockId, ctx);
  }

  @Get("unlocks/:unlockId/couldnt-reach")
  @Header("Cache-Control", "no-store")
  get(
    @Param("unlockId", new ParseUUIDPipe()) unlockId: string,
    @CurrentPayer() payer: AuthenticatedPayer,
  ): Promise<PayerReachCaseView> {
    return this.desk.getForPayer(payer.id, unlockId);
  }
}
