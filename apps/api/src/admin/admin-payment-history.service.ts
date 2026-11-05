import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  areRealPaymentsEnabled,
  realPaymentsBlockedReason,
  type ServerConfig,
} from "@badabhai/config";
import { payers } from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import type { Database } from "@badabhai/db";
import { eq } from "drizzle-orm";
import { SERVER_CONFIG } from "../config/config.module";
import { decodeEntityCursor, encodeEntityCursor } from "./admin-entities.cursor";
import { AdminPaymentHistoryRepository } from "./admin-payment-history.repository";
import type {
  AdminPaymentHistory,
  AdminPaymentHistoryItem,
  AdminPaymentHistoryQueryDto,
} from "./admin-payment-history.dto";
import type { PaymentsPosture } from "./admin-finance.dto";

/**
 * The per-company payment-history read service (#2565 B11).
 *
 * Owns three things: org resolution (delegated to the repository), the
 * date-DESC merge + keyset slice, and — the one that matters — stamping the
 * simulated flag + {@link PaymentsPosture} onto every row and the response.
 *
 * NO EVENTS: a read is not a state change (CLAUDE.md §1).
 */
@Injectable()
export class AdminPaymentHistoryService {
  constructor(
    private readonly repo: AdminPaymentHistoryRepository,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  private posture(): PaymentsPosture {
    return {
      mode: areRealPaymentsEnabled(this.config) ? "real" : "mock",
      blocked_reason: realPaymentsBlockedReason(this.config),
    };
  }

  async history(payerId: string, dto: AdminPaymentHistoryQueryDto): Promise<AdminPaymentHistory> {
    // 404 on an unknown payer (no-oracle beyond existence, like the entities detail).
    const [payer] = await this.db.select({ id: payers.id }).from(payers).where(eq(payers.id, payerId)).limit(1);
    if (!payer) throw new NotFoundException("Payer not found");

    const { anchor, memberPayerIds } = await this.repo.resolveOrgPayerIds(payerId);
    const posture = this.posture();
    const simulated = posture.mode === "mock";

    const merged = (await this.repo.readSources(memberPayerIds))
      .map((r) => ({ ...r, simulated }))
      .sort((a, b) => {
        const at = a.date.getTime() - b.date.getTime();
        if (at !== 0) return -at; // newest first
        return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
      });

    // Keyset slice in JS over the total order (per-company volume is tiny; each
    // source read is already bounded — see the repository header).
    const cursor = decodeEntityCursor(dto.cursor);
    const afterCursor = cursor
      ? merged.filter((r) => {
          const at = new Date(cursor.createdAt).getTime();
          const rt = r.date.getTime();
          return rt < at || (rt === at && r.id < cursor.id);
        })
      : merged;
    const slice = afterCursor.slice(0, dto.limit + 1);
    const hasMore = slice.length > dto.limit;
    const items: AdminPaymentHistoryItem[] = (hasMore ? slice.slice(0, dto.limit) : slice).map(
      ({ date, ...rest }) => ({ ...rest, date }),
    );
    const last = items[items.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeEntityCursor({ createdAt: last.date.toISOString(), id: last.id })
        : null;

    // Totals over the WHOLE timeline (not the page): a page's header must not
    // change as the operator pages.
    let inrSpent = 0;
    let creditsBought = 0;
    let creditsUsed = 0;
    for (const r of merged) {
      if (typeof r.amount_inr === "number") {
        // Orders + stamped purchases add; spend rows carry no price (null → skipped).
        if (r.type === "payment_order" || r.type === "credit_purchase" || r.type === "posting_plan" || r.type === "boost" || r.type === "capacity_purchase" || r.type === "quota_topup") {
          inrSpent += r.amount_inr;
        }
      }
      if (typeof r.credits === "number") {
        if (r.type === "credit_purchase") creditsBought += r.credits;
        else if (r.type === "payment_order") creditsBought += r.credits;
        else if (r.type === "credit_spend") creditsUsed += Math.abs(r.credits);
      }
    }
    // Avoid double-counting: a credit-pack purchase appears TWICE (the
    // payment_orders intent row AND the credit_ledger pack_purchase row). The ledger
    // row is the money SoR for credits; the order row is the gateway receipt. For
    // credits_bought / inr_spent the ledger wins where both exist — measured by
    // counting orders only when no ledger purchase exists for the same pack. The
    // simple, reviewable rule: totals count LEDGER purchases (+grants excluded),
    // and count ORDERS only when they have no ledger twin. A twin is an order whose
    // (pack, amount, credits) triple matches a ledger purchase — computed here, not
    // in SQL, so the rule stays visible next to the numbers it governs.
    //
    // IMPLEMENTATION: recompute without the order leg, then add back orders with no
    // ledger twin. (Kept O(n·m) with tiny n — per-company volume, not platform.)
    const ledgerPurchases = merged.filter((r) => r.type === "credit_purchase");
    const orders = merged.filter((r) => r.type === "payment_order");
    const twinKey = (pack: string, amount: number | null, credits: number | null) =>
      `${pack}|${amount ?? "null"}|${credits ?? "null"}`;
    const ledgerKeys = new Set(
      ledgerPurchases.map((r) => twinKey(r.item, r.amount_inr, r.credits)),
    );
    let orderOnlyInr = 0;
    let orderOnlyCredits = 0;
    for (const o of orders) {
      if (!ledgerKeys.has(twinKey(o.item, o.amount_inr, o.credits))) {
        orderOnlyInr += o.amount_inr ?? 0;
        orderOnlyCredits += o.credits ?? 0;
      }
    }
    inrSpent =
      ledgerPurchases.reduce((s, r) => s + (r.amount_inr ?? 0), 0) +
      merged
        .filter((r) => r.type === "posting_plan" || r.type === "boost" || r.type === "capacity_purchase" || r.type === "quota_topup")
        .reduce((s, r) => s + (r.amount_inr ?? 0), 0) +
      orderOnlyInr;
    creditsBought =
      ledgerPurchases.reduce((s, r) => s + (r.credits ?? 0), 0) + orderOnlyCredits;

    const balance = await this.repo.orgBalance(memberPayerIds);

    const payments: PaymentsPosture = posture;
    return {
      payer_id: anchor,
      member_payer_ids: memberPayerIds,
      items,
      nextCursor,
      totals: {
        inr_spent: inrSpent,
        credits_bought: creditsBought,
        credits_used: creditsUsed,
        balance,
      },
      payments,
    };
  }
}
