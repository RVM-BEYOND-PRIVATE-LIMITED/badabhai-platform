import { Inject, Injectable } from "@nestjs/common";
import {
  areRealPaymentsEnabled,
  realPaymentsBlockedReason,
  type ServerConfig,
} from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { AdminFinanceRepository } from "./admin-finance.repository";
import { decodeEntityCursor, encodeEntityCursor } from "./admin-entities.cursor";
import { ADMIN_TOP_BALANCES } from "./admin-finance.dto";
import type {
  AdminFinancePage,
  AdminFinanceSummary,
  AdminFinanceSummaryQueryDto,
  AdminLedgerQueryDto,
  AdminLedgerRow,
  AdminOrderRow,
  AdminOrdersQueryDto,
  PaymentsPosture,
} from "./admin-finance.dto";

/**
 * The admin finance read service (BP-2).
 *
 * Owns three things: keyset paging, the window→`since` conversion, and — the one that
 * matters — stamping {@link PaymentsPosture} onto every money-bearing response.
 *
 * NO EVENTS: a read is not a state change (CLAUDE.md §1).
 */
@Injectable()
export class AdminFinanceService {
  constructor(
    private readonly repo: AdminFinanceRepository,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  /**
   * Whether these rupees are real.
   *
   * Derived from the SAME config helper the kill-switch surface uses, so the Finance screen
   * and the kill-switch screen can never disagree about whether payments are live. A second
   * reading of `PAYMENTS_ENABLE_REAL` here would be a second source of truth about money.
   */
  private posture(): PaymentsPosture {
    return {
      mode: areRealPaymentsEnabled(this.config) ? "real" : "mock",
      blocked_reason: realPaymentsBlockedReason(this.config),
    };
  }

  /** Over-fetch by one so `nextCursor` is honest — see the entity service for the why. */
  private page<T extends { id: string; created_at: Date }>(
    rows: T[],
    limit: number,
  ): AdminFinancePage<T> {
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    return {
      items,
      nextCursor:
        hasMore && last
          ? encodeEntityCursor({ createdAt: last.created_at.toISOString(), id: last.id })
          : null,
      payments: this.posture(),
    };
  }

  async summary(dto: AdminFinanceSummaryQueryDto): Promise<AdminFinanceSummary> {
    const since = new Date(Date.now() - dto.windowDays * 24 * 60 * 60 * 1000);

    // Four independent aggregates — run them concurrently rather than making the slowest
    // one the page's latency floor.
    const [outstanding, byReason, byStatus, topBalances] = await Promise.all([
      this.repo.outstandingCredits(),
      this.repo.ledgerByReason(since),
      this.repo.ordersByStatus(since),
      this.repo.topBalances(ADMIN_TOP_BALANCES),
    ]);

    const forStatus = (s: string) => byStatus.find((b) => b.status === s);
    const paid = forStatus("paid");
    const created = forStatus("created");
    const failed = forStatus("failed");

    return {
      payments: this.posture(),
      window_days: dto.windowDays,
      outstanding_credits: outstanding.credits,
      payers_with_balance: outstanding.payers,
      by_reason: byReason,
      paid_orders: {
        count: paid?.count ?? 0,
        credits: paid?.credits ?? 0,
        amount_inr: paid?.amountInr ?? 0,
      },
      // `created` is the abandoned-checkout bucket: an order that exists and never settled.
      // Reported separately rather than folded into "revenue", which it is not.
      unsettled_orders: { count: created?.count ?? 0, amount_inr: created?.amountInr ?? 0 },
      failed_orders: { count: failed?.count ?? 0 },
      top_balances: topBalances,
    };
  }

  async ledger(dto: AdminLedgerQueryDto): Promise<AdminFinancePage<AdminLedgerRow>> {
    const rows = await this.repo.listLedger(
      { payerId: dto.payerId, reason: dto.reason },
      decodeEntityCursor(dto.cursor),
      dto.limit + 1,
    );
    return this.page(rows, dto.limit);
  }

  async orders(dto: AdminOrdersQueryDto): Promise<AdminFinancePage<AdminOrderRow>> {
    const rows = await this.repo.listOrders(
      { payerId: dto.payerId, status: dto.status },
      decodeEntityCursor(dto.cursor),
      dto.limit + 1,
    );
    return this.page(rows, dto.limit);
  }
}
