import { describe, it, expect } from "vitest";
import { AdminFinanceRepository } from "./admin-finance.repository";
import { captureQueries, expectColumnsAbsent } from "./testing/query-capture";

/**
 * SQL-shape tests for the payer role on finance rows (#2032, #2106).
 *
 * The ledger and order lists — and the summary's top balances (#2106) — expose `payer_role`
 * next to `payer_id` so admin-web can link straight to the Companies or Agencies page. The role
 * comes from ONE LEFT JOIN on the `payers` primary key inside the query — never a per-row
 * lookup — and nothing else on `payers` (its contact columns are ciphertext PII) is projected.
 */

const PAYER = "66666666-6666-4666-8666-666666666666";
const PAYER_PII = ["email_enc", "email_hash", "phone_enc", "phone_hash", "org_name_enc"];

function expectRoleJoin(c: ReturnType<typeof captureQueries>, table: string): void {
  const text = c.sql();
  expect(text).toContain('LEFT JOIN | "payers" | ');
  expect(text).not.toContain("INNER JOIN");
  expect(text).toContain(`"payers"."id" = "${table}"."payer_id"`);
  expect(text).toContain('"payers"."role"');
  expect(text).not.toMatch(/"payers"\."(status|previous_status|created_at|updated_at)"/);
  expectColumnsAbsent(c, PAYER_PII);
}

describe("admin finance ledger rows carry the payer's role (#2032)", () => {
  const ROW = {
    id: "77777777-7777-4777-8777-777777777777",
    payerId: PAYER,
    payerRole: "agent",
    delta: 10,
    reason: "purchase",
    unlockId: null,
    packCode: "starter",
    priceInr: 499,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
  };

  it("joins payers on its PK and maps role → payer_role", async () => {
    const c = captureQueries([ROW]);
    const out = await new AdminFinanceRepository(c.db).listLedger({}, null, 10);
    expectRoleJoin(c, "credit_ledger");
    expect(out[0]).toMatchObject({ payer_id: PAYER, payer_role: "agent" });
  });

  it("an orphaned opaque payer_id still lists, with payer_role null", async () => {
    const c = captureQueries([{ ...ROW, payerRole: null }]);
    const out = await new AdminFinanceRepository(c.db).listLedger({ payerId: PAYER }, null, 10);
    expect(out[0]).toMatchObject({ payer_id: PAYER, payer_role: null });
  });
});

describe("admin finance payment orders carry the payer's role (#2032)", () => {
  const ROW = {
    id: "88888888-8888-4888-8888-888888888888",
    payerId: PAYER,
    payerRole: "employer",
    packCode: "starter",
    amountInr: 499,
    creditsGranted: 10,
    provider: "mock",
    status: "paid",
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    updatedAt: new Date("2026-10-01T00:00:00.000Z"),
  };

  it("joins payers on its PK and maps role → payer_role", async () => {
    const c = captureQueries([ROW]);
    const out = await new AdminFinanceRepository(c.db).listOrders({}, null, 10);
    expectRoleJoin(c, "payment_orders");
    expect(out[0]).toMatchObject({ payer_id: PAYER, payer_role: "employer" });
  });

  it("an orphaned opaque payer_id still lists, with payer_role null", async () => {
    const c = captureQueries([{ ...ROW, payerRole: null }]);
    const out = await new AdminFinanceRepository(c.db).listOrders({}, null, 10);
    expect(out[0]).toMatchObject({ payer_id: PAYER, payer_role: null });
  });
});

describe("admin finance top balances carry the payer's role (#2106)", () => {
  const ROW = { payerId: PAYER, payerRole: "agent", balance: 500 };

  it("joins payers on its PK and maps role → payer_role", async () => {
    const c = captureQueries([ROW]);
    const out = await new AdminFinanceRepository(c.db).topBalances(10);
    expectRoleJoin(c, "payer_credits");
    expect(out).toStrictEqual([{ payer_id: PAYER, payer_role: "agent", balance: 500 }]);
  });

  it("still ranks by the balance row, not by anything on payers", async () => {
    const c = captureQueries([ROW]);
    await new AdminFinanceRepository(c.db).topBalances(10);
    expect(c.sql()).toContain('"payer_credits"."balance" desc');
    expect(c.sql()).not.toMatch(/"payers"\."[a-z_]+" (asc|desc)/);
  });

  it("an orphaned opaque payer_id still lists, with payer_role null", async () => {
    const c = captureQueries([{ ...ROW, payerRole: null }]);
    const out = await new AdminFinanceRepository(c.db).topBalances(10);
    expect(out).toStrictEqual([{ payer_id: PAYER, payer_role: null, balance: 500 }]);
  });
});
