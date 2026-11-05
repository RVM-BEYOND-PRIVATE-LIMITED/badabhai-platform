import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadServerConfig } from "@badabhai/config";
import { createDbClient, type DbClient } from "@badabhai/db";
import {
  creditLedger,
  jobPostings,
  payerCapacity,
  payerCredits,
  paymentOrders,
  payers,
  postingPlans,
  unlocks,
} from "@badabhai/db";
import { eq } from "drizzle-orm";
import type { RequestContext } from "../common/request-context";
import { AdminPaymentHistoryRepository } from "./admin-payment-history.repository";
import { AdminPaymentHistoryService } from "./admin-payment-history.service";

/**
 * #2565 B11 acceptance — "a company with orders, grants, unlocks and a plan
 * purchase sees all of them in date order with correct ₹", AGAINST A REAL POSTGRES.
 *
 * Seeds one company (one payer): a manual grant, a paid pack order + its ledger
 * purchase row, an unlock spend, and a stamped posting plan — then reads
 * `GET /admin/payers/:id/payment-history` and asserts every row is present in
 * date order, every ₹ is the stamped value (never a guess), every row carries
 * the simulated flag, and the totals add up.
 *
 * Fixtures carry no PII: the payer's contact columns hold `enc:`/`hash:` markers,
 * ids are fresh per run, everything is deleted in afterAll.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api exec vitest run admin-payment-history.db
 */
const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

const TAG = randomUUID().slice(0, 8);
const CTX: RequestContext = { correlationId: randomUUID(), requestId: `b11-db-${TAG}` };
void CTX;

describe.skipIf(!RUN)("admin payment history against a real Postgres (#2565 B11)", () => {
  let client!: DbClient;
  let payerId!: string;
  let postingId!: string;
  const created: { table: "p" | "o" | "l" | "u" | "j" | "pl" | "c" | "pc"; id: string }[] = [];

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL);
    const db = client.db;

    const [payer] = await db
      .insert(payers)
      .values({
        role: "employer",
        emailEnc: `enc:b11-${TAG}`,
        emailHash: `hash:b11-${TAG}`,
        orgNameEnc: `enc:company-${TAG}`,
        status: "active",
      })
      .returning({ id: payers.id });
    payerId = payer!.id;

    // Manual grant (no price — renders "not recorded").
    const [grant] = await db
      .insert(creditLedger)
      .values({ payerId, delta: 50, reason: "grant", priceInr: null })
      .returning({ id: creditLedger.id });
    created.push({ table: "l", id: grant!.id });

    // Paid pack order (2026-10-02) + its ledger purchase twin (2026-10-02T00:01).
    const [order] = await db
      .insert(paymentOrders)
      .values({
        payerId,
        packCode: "pack_50",
        amountInr: 2000,
        creditsGranted: 50,
        provider: "razorpay",
        providerOrderId: `order_b11_${TAG}`,
        status: "paid",
        createdAt: new Date("2026-10-02T00:00:00.000Z"),
      })
      .returning({ id: paymentOrders.id });
    created.push({ table: "o", id: order!.id });
    const [purchase] = await db
      .insert(creditLedger)
      .values({
        payerId,
        delta: 50,
        reason: "pack_purchase",
        packCode: "pack_50",
        priceInr: 2000,
        paymentRef: `order_b11_${TAG}`,
        createdAt: new Date("2026-10-02T00:01:00.000Z"),
      })
      .returning({ id: creditLedger.id });
    created.push({ table: "l", id: purchase!.id });

    // One unlock spend (2026-10-03).
    const [unlock] = await db
      .insert(unlocks)
      .values({ payerId, status: "granted", grantedAt: new Date("2026-10-03T00:00:00.000Z") })
      .returning({ id: unlocks.id });
    created.push({ table: "u", id: unlock!.id });
    const [spend] = await db
      .insert(creditLedger)
      .values({
        payerId,
        delta: -1,
        reason: "unlock_debit",
        unlockId: unlock!.id,
        createdAt: new Date("2026-10-03T00:01:00.000Z"),
      })
      .returning({ id: creditLedger.id });
    created.push({ table: "l", id: spend!.id });

    await db.insert(payerCredits).values({ payerId, balance: 99 }).onConflictDoNothing();

    // A stamped posting plan (2026-10-04) on a minimal posting.
    const [posting] = await db
      .insert(jobPostings)
      .values({
        createdBy: payerId,
        payerId,
        orgLabel: `Company ${TAG}`,
        roleTitle: "Driver",
        vacancyBand: "2-5",
        status: "open",
      })
      .returning({ id: jobPostings.id });
    postingId = posting!.id;
    const [plan] = await db
      .insert(postingPlans)
      .values({
        jobPostingId: postingId,
        payerId,
        tier: "standard",
        applicantVisibilityQuota: 10,
        priceInr: 1000,
        status: "active",
        paidAt: new Date("2026-10-04T00:00:00.000Z"),
      })
      .returning({ id: postingPlans.id });
    created.push({ table: "pl", id: plan!.id });
  });

  afterAll(async () => {
    if (!client) return;
    const db = client.db;
    try {
      for (const row of created.reverse()) {
        if (row.table === "l") await db.delete(creditLedger).where(eq(creditLedger.id, row.id));
        else if (row.table === "o") await db.delete(paymentOrders).where(eq(paymentOrders.id, row.id));
        else if (row.table === "u") await db.delete(unlocks).where(eq(unlocks.id, row.id));
        else if (row.table === "pl") await db.delete(postingPlans).where(eq(postingPlans.id, row.id));
      }
      await db.delete(payerCapacity).where(eq(payerCapacity.payerId, payerId));
      await db.delete(payerCredits).where(eq(payerCredits.payerId, payerId));
      if (postingId) await db.delete(jobPostings).where(eq(jobPostings.id, postingId));
      if (payerId) await db.delete(payers).where(eq(payers.id, payerId));
    } finally {
      await client.sql.end({ timeout: 5 });
    }
  });

  it("sees orders, grants, unlocks and the plan in date order with correct ₹", async () => {
    const config = loadServerConfig({ NODE_ENV: "test" });
    const repo = new AdminPaymentHistoryRepository(client.db);
    const svc = new AdminPaymentHistoryService(repo, client.db, config);
    const out = await svc.history(payerId, { limit: 50 });

    // Every source present.
    const types = out.items.map((i) => i.type);
    for (const t of ["payment_order", "credit_purchase", "credit_grant", "credit_spend", "posting_plan"] as const) {
      expect(types, t).toContain(t);
    }
    // Date order, newest first.
    const times = out.items.map((i) => i.date.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    // Stamped rupees, never guesses.
    const byType = (t: string) => out.items.find((i) => i.type === t);
    expect(byType("payment_order")!.amount_inr).toBe(2000);
    expect(byType("credit_purchase")!.amount_inr).toBe(2000);
    expect(byType("posting_plan")!.amount_inr).toBe(1000);
    expect(byType("credit_grant")!.amount_inr).toBeNull();
    // Every row carries the simulated flag (mock mode in test env).
    expect(out.items.length).toBeGreaterThan(0);
    expect(out.items.every((i) => typeof i.simulated === "boolean")).toBe(true);
    // Totals: ledger purchase counted once (twin deduped), plan added, spend used.
    expect(out.totals.inr_spent).toBe(2000 + 1000);
    expect(out.totals.credits_bought).toBe(50);
    expect(out.totals.credits_used).toBe(1);
    expect(out.totals.balance).toBe(99);
  });
});
