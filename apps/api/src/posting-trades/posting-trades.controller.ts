import { Controller, Get, NotFoundException, Param, UseGuards } from "@nestjs/common";
import { PayerAuthGuard } from "../payers/payer-auth.guard";
import {
  PostingTradesService,
  type PostingTradeCatalogueRow,
  type PostingTradeDetail,
  type PostingTradeForm,
} from "./posting-trades.service";

/** A role kind is a lower-case slug; anything else names no trade and is a plain 404. */
const ROLE_KIND_PARAM = /^[a-z0-9_]{1,64}$/;

/**
 * The posting form's trade surface (owner ruling 2026-11-03; 60 trades since CEO pack v2).
 *
 * THREE READS (#3006):
 *   - `GET /payer/posting-trades` — every trade's WHOLE form in one reply, for the installed
 *     company apps. Fixed to the 16 trades it has always returned, whatever the release table
 *     says (`LEGACY_LIST_TRADE_KINDS`: those builds have no update check).
 *   - `GET /payer/posting-trades/catalogue` — the picker's light rows (kind, label, department,
 *     shop-floor or desk) for every trade whose posting switch is on.
 *   - `GET /payer/posting-trades/:roleKind` — one trade's form, with its department; 404 for an
 *     unknown kind or one switched off.
 * payer-web fetches these server-side (the Bearer never reaches the browser) and payer-app
 * through its own authenticated client.
 *
 * READ-ONLY AND NOT PAYER-SCOPED, like `GET /payer/match/skills`: the vocabulary is the same
 * for every company and writes nothing, so there is no tenancy surface here. Behind
 * PayerAuthGuard because the trade catalogue and the supply it implies are commercial data.
 * The posting write path validates a picked trade through `normalizeSelection`, which follows
 * the same switch.
 */
@Controller("payer/posting-trades")
@UseGuards(PayerAuthGuard)
export class PostingTradesController {
  constructor(private readonly trades: PostingTradesService) {}

  @Get()
  async list(): Promise<{ trades: PostingTradeForm[] }> {
    return { trades: await this.trades.listLegacyForms() };
  }

  // Declared before `:roleKind`, so "catalogue" is never read as a role kind.
  @Get("catalogue")
  async catalogue(): Promise<{ trades: PostingTradeCatalogueRow[] }> {
    return { trades: await this.trades.catalogue() };
  }

  @Get(":roleKind")
  async detail(@Param("roleKind") roleKind: string): Promise<PostingTradeDetail> {
    const detail = ROLE_KIND_PARAM.test(roleKind) ? await this.trades.detail(roleKind) : null;
    if (detail === null) throw new NotFoundException("no such posting trade");
    return detail;
  }
}
