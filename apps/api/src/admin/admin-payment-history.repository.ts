import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  creditLedger,
  payerCapacity,
  payerCredits,
  payerMembers,
  payerOrgs,
  paymentOrders,
  planQuotaTopups,
  postingBoosts,
  postingPlans,
  type Database,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import type { AdminPaymentHistoryItem } from "./admin-payment-history.dto";

/**
 * SELECT-ONLY data access for the per-company payment history (#2565 B11).
 *
 * Same discipline as the finance repository: explicit column projections, no
 * insert/update/delete anywhere, and NO PII (opaque ids, integer ₹, closed enums,
 * timestamps, opaque provider refs only).
 *
 * ── ORG ROLLUP ────────────────────────────────────────────────────────────────
 * The caller passes ANY payer in the company. Resolution:
 *   1. an org rooted at this payer → that org (the founder case);
 *   2. else the most recently accepted ACTIVE membership of this payer → that org;
 *   3. else the payer alone (solo — pre-org or contactless).
 * Every source predicate then runs over ALL member payer_ids in the org (the
 * anchor + every active member), so a teammate's purchase rolls up to the company.
 *
 * ── PAGING ────────────────────────────────────────────────────────────────────
 * The timeline is a UNION of seven small per-company sources. Per-company money
 * volume is tiny (a company buys plans, not thousands), so each source is read
 * bounded (500 rows, newest first) and the merge + keyset slice happens in JS over
 * the (date DESC, id DESC) total order. The cursor is the same
 * `(createdAt, id)` shape the entity/finance surfaces use.
 */
@Injectable()
export class AdminPaymentHistoryRepository {
  /** Per-source read bound — per-company money volume is tiny; this is a guard, not a page. */
  static readonly SOURCE_LIMIT = 500;

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * The org anchor + every active member payer_id that rolls up to it.
   * Returns `{ anchor, memberPayerIds }` where `memberPayerIds` always includes
   * the anchor. A payer with no org resolves to themselves alone (solo).
   */
  async resolveOrgPayerIds(payerId: string): Promise<{ anchor: string; memberPayerIds: string[] }> {
    // 1) an org this payer roots (the founder case).
    const [ownOrg] = await this.db
      .select({ id: payerOrgs.id, rootPayerId: payerOrgs.rootPayerId })
      .from(payerOrgs)
      .where(eq(payerOrgs.rootPayerId, payerId))
      .limit(1);
    const orgId =
      ownOrg?.id ??
      (
        await this.db
          .select({ orgId: payerMembers.orgId })
          .from(payerMembers)
          .where(and(eq(payerMembers.memberPayerId, payerId), eq(payerMembers.status, "active")))
          .orderBy(desc(payerMembers.acceptedAt))
          .limit(1)
      )[0]?.orgId;
    if (!orgId) return { anchor: payerId, memberPayerIds: [payerId] };

    const [org] = await this.db
      .select({ rootPayerId: payerOrgs.rootPayerId })
      .from(payerOrgs)
      .where(eq(payerOrgs.id, orgId))
      .limit(1);
    const anchor = org?.rootPayerId ?? payerId;
    const members = await this.db
      .select({ memberPayerId: payerMembers.memberPayerId })
      .from(payerMembers)
      .where(and(eq(payerMembers.orgId, orgId), eq(payerMembers.status, "active")));
    const ids = new Set<string>([anchor]);
    for (const m of members) if (m.memberPayerId) ids.add(m.memberPayerId);
    // The anchor may itself have no member row (backfilled solo orgs always have one,
    // but a gap payer repaired by `ensureSoloOrg` races could briefly not) — it is
    // still the tenant key every purchase was stamped with, so it stays in the set.
    return { anchor, memberPayerIds: [...ids] };
  }

  /** Raw per-source rows for the org, each bounded newest-first. No merge here. */
  async readSources(payerIds: string[]): Promise<AdminPaymentHistoryItem[]> {
    const LIM = AdminPaymentHistoryRepository.SOURCE_LIMIT;
    const [orders, ledger, plans, boosts, capacities, topups] = await Promise.all([
      this.db
        .select({
          id: paymentOrders.id,
          packCode: paymentOrders.packCode,
          amountInr: paymentOrders.amountInr,
          creditsGranted: paymentOrders.creditsGranted,
          provider: paymentOrders.provider,
          providerOrderId: paymentOrders.providerOrderId,
          status: paymentOrders.status,
          createdAt: paymentOrders.createdAt,
        })
        .from(paymentOrders)
        .where(inArray(paymentOrders.payerId, payerIds))
        .orderBy(desc(paymentOrders.createdAt), desc(paymentOrders.id))
        .limit(LIM),
      this.db
        .select({
          id: creditLedger.id,
          delta: creditLedger.delta,
          reason: creditLedger.reason,
          unlockId: creditLedger.unlockId,
          packCode: creditLedger.packCode,
          priceInr: creditLedger.priceInr,
          paymentRef: creditLedger.paymentRef,
          createdAt: creditLedger.createdAt,
        })
        .from(creditLedger)
        .where(inArray(creditLedger.payerId, payerIds))
        .orderBy(desc(creditLedger.createdAt), desc(creditLedger.id))
        .limit(LIM),
      this.db
        .select({
          id: postingPlans.id,
          tier: postingPlans.tier,
          priceInr: postingPlans.priceInr,
          status: postingPlans.status,
          paidAt: postingPlans.paidAt,
          createdAt: postingPlans.createdAt,
        })
        .from(postingPlans)
        .where(inArray(postingPlans.payerId, payerIds))
        .orderBy(desc(postingPlans.createdAt), desc(postingPlans.id))
        .limit(LIM),
      this.db
        .select({
          id: postingBoosts.id,
          tier: postingBoosts.tier,
          priceInr: postingBoosts.priceInr,
          status: postingBoosts.status,
          boostStartsAt: postingBoosts.boostStartsAt,
          createdAt: postingBoosts.createdAt,
        })
        .from(postingBoosts)
        .where(inArray(postingBoosts.payerId, payerIds))
        .orderBy(desc(postingBoosts.createdAt), desc(postingBoosts.id))
        .limit(LIM),
      this.db
        .select({
          id: payerCapacity.id,
          sourceTier: payerCapacity.sourceTier,
          maxActiveVacancies: payerCapacity.maxActiveVacancies,
          priceInr: payerCapacity.priceInr,
          createdAt: payerCapacity.createdAt,
          updatedAt: payerCapacity.updatedAt,
        })
        .from(payerCapacity)
        .where(inArray(payerCapacity.payerId, payerIds))
        .orderBy(desc(payerCapacity.updatedAt), desc(payerCapacity.id))
        .limit(LIM),
      this.db
        .select({
          id: planQuotaTopups.id,
          tier: planQuotaTopups.tier,
          quotaAdded: planQuotaTopups.quotaAdded,
          priceInr: planQuotaTopups.priceInr,
          createdAt: planQuotaTopups.createdAt,
        })
        .from(planQuotaTopups)
        .where(inArray(planQuotaTopups.payerId, payerIds))
        .orderBy(desc(planQuotaTopups.createdAt), desc(planQuotaTopups.id))
        .limit(LIM),
    ]);

    const items: AdminPaymentHistoryItem[] = [];
    for (const o of orders) {
      items.push({
        id: `payment_order:${o.id}`,
        date: o.createdAt,
        type: "payment_order",
        item: o.packCode,
        credits: o.creditsGranted,
        amount_inr: o.amountInr,
        status: o.status,
        // OPAQUE gateway order id (never card/UPI/PII — the ADR-0010 §D5 line). The
        // finance platform view deliberately omits it; the per-company history the
        // issue requires carries it so support can match a row to a gateway record.
        provider_reference: `${o.provider}:${o.providerOrderId}`,
        simulated: false, // stamped by the service from the payments posture
      });
    }
    for (const l of ledger) {
      const type =
        l.reason === "pack_purchase"
          ? "credit_purchase"
          : l.reason === "grant"
            ? "credit_grant"
            : l.reason === "refund"
              ? "credit_refund"
              : "credit_spend";
      items.push({
        id: `${type}:${l.id}`,
        date: l.createdAt,
        type,
        item: l.packCode ?? l.unlockId ?? l.reason,
        credits: l.delta,
        amount_inr: l.priceInr,
        status: l.reason,
        provider_reference: l.paymentRef,
        simulated: false,
      });
    }
    for (const p of plans) {
      items.push({
        id: `posting_plan:${p.id}`,
        date: p.paidAt ?? p.createdAt,
        type: "posting_plan",
        item: p.tier,
        credits: null,
        amount_inr: p.priceInr,
        status: p.status,
        provider_reference: null,
        simulated: false,
      });
    }
    for (const b of boosts) {
      items.push({
        id: `boost:${b.id}`,
        date: b.boostStartsAt ?? b.createdAt,
        type: "boost",
        item: b.tier,
        credits: null,
        amount_inr: b.priceInr,
        status: b.status,
        provider_reference: null,
        simulated: false,
      });
    }
    for (const c of capacities) {
      items.push({
        id: `capacity_purchase:${c.id}`,
        date: c.updatedAt,
        type: "capacity_purchase",
        item: c.sourceTier ?? "capacity",
        credits: null,
        amount_inr: c.priceInr,
        status: `allowance:${c.maxActiveVacancies}`,
        provider_reference: null,
        simulated: false,
      });
    }
    for (const t of topups) {
      items.push({
        id: `quota_topup:${t.id}`,
        date: t.createdAt,
        type: "quota_topup",
        item: t.tier,
        credits: t.quotaAdded,
        amount_inr: t.priceInr,
        status: "applied",
        provider_reference: null,
        simulated: false,
      });
    }
    return items;
  }

  /** Live credit balance summed across the org's wallets. */
  async orgBalance(payerIds: string[]): Promise<number> {
    if (payerIds.length === 0) return 0;
    const rows = await this.db
      .select({ balance: payerCredits.balance })
      .from(payerCredits)
      .where(inArray(payerCredits.payerId, payerIds));
    return rows.reduce((sum, r) => sum + r.balance, 0);
  }
}
