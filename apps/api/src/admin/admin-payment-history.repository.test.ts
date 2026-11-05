import { describe, expect, it } from "vitest";
import { AdminPaymentHistoryRepository } from "./admin-payment-history.repository";
import { captureQueries, expectColumnsAbsent } from "./testing/query-capture";

const PAYER = "66666666-6666-4666-8666-666666666666";
const PAYER_PII = ["email_enc", "email_hash", "phone_enc", "phone_hash", "org_name_enc"];

describe("admin payment-history reads are org-scoped and faceless", () => {
  it("resolves an org by its root before reading any money table", async () => {
    const c = captureQueries([{ id: "org-1", rootPayerId: PAYER }]);
    const repo = new AdminPaymentHistoryRepository(c.db);
    // The stub resolves every select with the same rows; the assertions are on the
    // QUERY SHAPE — the org lookup names payer_orgs, and no PII column is projected.
    await repo.resolveOrgPayerIds(PAYER);
    expect(c.sql()).toContain("payer_orgs");
    expectColumnsAbsent(c, PAYER_PII);
  });

  it("every money source filters on the org's payer ids (rollup, not one login)", async () => {
    const c = captureQueries([]);
    const repo = new AdminPaymentHistoryRepository(c.db);
    await repo.readSources([PAYER]);
    const sql = c.sql();
    for (const table of [
      "payment_orders",
      "credit_ledger",
      "posting_plans",
      "posting_boosts",
      "payer_capacity",
      "plan_quota_topups",
    ]) {
      expect(sql, table).toContain(table);
    }
    // The org set reaches the query (inArray on payer_id), and no contact PII does.
    expect(sql).toContain("payer_id");
    expectColumnsAbsent(c, PAYER_PII);
  });

  it("maps ledger reasons to timeline types and keeps provider refs opaque", async () => {
    const rows = {
      orders: [],
      ledger: [
        {
          id: "l1",
          delta: 50,
          reason: "pack_purchase",
          unlockId: null,
          packCode: "pack_50",
          priceInr: 2000,
          paymentRef: "mock-order-1",
          createdAt: new Date("2026-10-01T00:00:00.000Z"),
        },
        {
          id: "l2",
          delta: -1,
          reason: "unlock_debit",
          unlockId: "u1",
          packCode: null,
          priceInr: null,
          paymentRef: null,
          createdAt: new Date("2026-10-02T00:00:00.000Z"),
        },
      ],
    };
    // Drive readSources through a stub that answers per-table: the capture helper
    // resolves every select with the same rows, so assert the MAPPING on the ledger
    // leg by feeding only ledger-shaped rows and checking the type mapping holds
    // for the rows that carry a ledger id.
    const c = captureQueries(rows.ledger);
    const repo = new AdminPaymentHistoryRepository(c.db);
    const items = await repo.readSources([PAYER]);
    const ledgerItems = items.filter((i) => i.id.startsWith("credit_"));
    expect(ledgerItems.map((i) => i.type).sort()).toEqual(["credit_purchase", "credit_spend"]);
    expect(ledgerItems.find((i) => i.type === "credit_purchase")).toMatchObject({
      amount_inr: 2000,
      provider_reference: "mock-order-1",
    });
  });
});
