import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "@badabhai/db";
import { RazorpayReconcileRepository } from "./razorpay-reconcile.repository";
import { reconcileWindow } from "./razorpay-reconcile.service";

/**
 * #2773 — the reconciliation's read against real Postgres: which orders it finds by Razorpay
 * order id (any age, any status), which paid orders count as "in the window", the expected
 * amount (paise columns, or the rupee column on a pre-0176 row), and the refund flag. The
 * database is shared, so each assertion reads only this file's rows.
 *
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api exec vitest run razorpay-reconcile.db
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

describe.skipIf(!RUN)("#2773 Razorpay reconciliation read against Postgres", () => {
  let client: DbClient;
  let repo: RazorpayReconcileRepository;
  const NOW = new Date();
  const { from, to } = reconcileWindow(NOW);
  const TAG = randomUUID().slice(0, 8);
  const PAYER = randomUUID();
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
  const rzp = (k: string) => `order_${TAG}_${k}`;
  const ID = {
    paidNew: randomUUID(), // paid, paise columns set, 1 h old
    paidOld: randomUUID(), // paid, pre-0176 (rupees only), 2 h old
    created: randomUUID(), // still `created`, 1 h old
    paidStale: randomUUID(), // paid, 72 h old: outside the window
    refunded: randomUUID(), // paid, refund requested by our refund path
    refundFailed: randomUUID(), // paid, our refund failed
    otherProvider: randomUUID(), // paid, not Razorpay
    tooFresh: randomUUID(), // paid 5 minutes ago: inside the settle grace
  };
  const ALL: string[] = Object.values(ID);

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 2 });
    repo = new RazorpayReconcileRepository(client.db);
    const sql = client.sql;
    const order = (
      id: string,
      key: string,
      status: string,
      createdAt: string,
      opts: { money?: boolean; provider?: string; amountInr?: number } = {},
    ) => {
      const amountInr = opts.amountInr ?? 1179;
      const money = opts.money ?? true;
      return sql`
        INSERT INTO payment_orders (
          id, payer_id, product_kind, pack_code, amount_inr, credits_granted, provider,
          provider_order_id, status, provider_payment_ref,
          taxable_paise, gst_paise, round_off_paise, total_paise, gst_rate_bps, created_at
        ) VALUES (
          ${id}::uuid, ${PAYER}::uuid, 'credit_pack', 'pack_10', ${amountInr}, 10,
          ${opts.provider ?? "razorpay"}, ${rzp(key)}, ${status},
          ${status === "created" ? null : `pay_${TAG}_${key}`},
          ${money ? 99_900 : null}, ${money ? 17_982 : null}, ${money ? 18 : null},
          ${money ? 117_900 : null}, ${money ? 1800 : null}, ${createdAt}::timestamptz
        )`;
    };
    const refund = (orderId: string, status: "requested" | "failed") =>
      sql`INSERT INTO payment_refunds (
            payment_order_id, payer_id, rule, requested_by, amount_paise, credits_removed, status,
            failure_code
          ) VALUES (
            ${orderId}::uuid, ${PAYER}::uuid, 'unused', ${randomUUID()}::uuid, 117900, 10,
            ${status}, ${status === "failed" ? "provider_error" : null}
          )`;

    await order(ID.paidNew, "paidNew", "paid", hoursAgo(1));
    await order(ID.paidOld, "paidOld", "paid", hoursAgo(2), { money: false, amountInr: 500 });
    await order(ID.created, "created", "created", hoursAgo(1));
    await order(ID.paidStale, "paidStale", "paid", hoursAgo(72));
    await order(ID.refunded, "refunded", "paid", hoursAgo(3));
    await order(ID.refundFailed, "refundFailed", "paid", hoursAgo(3));
    await order(ID.otherProvider, "otherProvider", "paid", hoursAgo(1), { provider: "other" });
    await order(ID.tooFresh, "tooFresh", "paid", hoursAgo(5 / 60));
    await refund(ID.refunded, "requested");
    await refund(ID.refundFailed, "failed");
  });

  afterAll(async () => {
    if (!client) return;
    const sql = client.sql;
    await sql`DELETE FROM payment_refunds WHERE payment_order_id = ANY(${ALL}::uuid[])`;
    await sql`DELETE FROM payment_orders WHERE id = ANY(${ALL}::uuid[])`;
    await client.sql.end({ timeout: 5 });
  });

  it("finds our orders by Razorpay order id, whatever their age or status, never another provider's", async () => {
    const snap = await repo.read({
      providerOrderIds: [
        rzp("paidNew"),
        rzp("created"),
        rzp("paidStale"),
        rzp("otherProvider"),
        "order_nobody",
      ],
      from,
      to,
    });
    expect(snap.byProviderOrderId).toEqual([
      {
        orderId: ID.created,
        providerOrderId: rzp("created"),
        status: "created",
        providerPaymentRef: null,
        expectedPaise: 117_900,
        refundRecorded: false,
      },
      {
        orderId: ID.paidNew,
        providerOrderId: rzp("paidNew"),
        status: "paid",
        providerPaymentRef: `pay_${TAG}_paidNew`,
        expectedPaise: 117_900,
        refundRecorded: false,
      },
      {
        orderId: ID.paidStale,
        providerOrderId: rzp("paidStale"),
        status: "paid",
        providerPaymentRef: `pay_${TAG}_paidStale`,
        expectedPaise: 117_900,
        refundRecorded: false,
      },
    ]);
  });

  it("paid in the window: Razorpay orders paid and created in [now − 48 h, now − 30 min)", async () => {
    const snap = await repo.read({ providerOrderIds: [], from, to });
    expect(snap.byProviderOrderId).toEqual([]);
    const mine = new Map(
      snap.paidInWindow.filter((o) => ALL.includes(o.orderId)).map((o) => [o.orderId, o]),
    );
    expect([...mine.keys()].sort()).toEqual(
      [ID.paidNew, ID.paidOld, ID.refunded, ID.refundFailed].sort(),
    );
    // A pre-0176 row is expected at amount_inr × 100.
    expect(mine.get(ID.paidOld)?.expectedPaise).toBe(50_000);
    // Our live refund flags the order; a failed one does not.
    expect(mine.get(ID.refunded)?.refundRecorded).toBe(true);
    expect(mine.get(ID.refundFailed)?.refundRecorded).toBe(false);
  });
});
