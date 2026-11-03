import { Controller, Get, UseGuards } from "@nestjs/common";
import { PayerAuthGuard } from "../payers/payer-auth.guard";
import { PostingTradesService, type PostingTradeForm } from "./posting-trades.service";

/**
 * The posting form's trade surface (owner ruling 2026-11-03).
 *
 * ONE READ, BOTH CLIENTS. payer-web fetches this server-side (the Bearer never reaches the
 * browser) and payer-app fetches it through its own authenticated client. The route returns
 * the 16 postable trades, their display-only ladders, and every chip question the vacancy
 * form may ask — each chip marked match-affecting or facet-only.
 *
 * READ-ONLY AND NOT PAYER-SCOPED, like `GET /payer/match/skills`: the vocabulary is the same
 * for every company and writes nothing, so there is no tenancy surface here. It is behind
 * PayerAuthGuard because the trade catalogue and the supply it implies are commercial data.
 */
@Controller("payer/posting-trades")
@UseGuards(PayerAuthGuard)
export class PostingTradesController {
  constructor(private readonly trades: PostingTradesService) {}

  @Get()
  async list(): Promise<{ trades: PostingTradeForm[] }> {
    return { trades: await this.trades.listForms() };
  }
}
