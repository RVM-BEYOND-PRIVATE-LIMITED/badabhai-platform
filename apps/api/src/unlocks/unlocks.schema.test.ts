import { describe, it, expect } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { unlocks, payerCredits, creditLedger, unlockRouting } from "@badabhai/db";

/**
 * F-5 / T1 control 3 / T9-a (SCHEMA-LEVEL, BUILD-BLOCKER-adjacent): no unlock-family
 * table may have ANY column that could hold a phone / name / contact / proxy-number
 * string. The only identity reference allowed is `worker_id` (a UUID FK into
 * `workers`, where PII lives). If a future change adds a `phone`/`name`/`contact`
 * column to any of these tables, THIS test fails — making the second-PII-surface
 * mistake (asset A3) a CI failure, not a review miss.
 */

const FORBIDDEN_COLUMN_TOKENS = [
  "phone",
  "name",
  "contact",
  "email",
  "address",
  "number",
  "destination",
  "msisdn",
  "mobile",
];

const TABLES = {
  unlocks,
  payer_credits: payerCredits,
  credit_ledger: creditLedger,
  unlock_routing: unlockRouting,
};

describe("unlock-family schema is PII-FREE (F-5 / T9-a)", () => {
  for (const [tableName, table] of Object.entries(TABLES)) {
    it(`${tableName} has NO phone/name/contact column`, () => {
      const columns = Object.values(getTableColumns(table)).map((c) => c.name.toLowerCase());
      for (const col of columns) {
        for (const token of FORBIDDEN_COLUMN_TOKENS) {
          expect(col, `${tableName}.${col} contains the forbidden token "${token}"`).not.toContain(
            token,
          );
        }
      }
    });
  }

  it("the only identity reference is unlocks.worker_id (a UUID FK into workers)", () => {
    const cols = Object.values(getTableColumns(unlocks)).map((c) => c.name);
    expect(cols).toContain("worker_id");
    // payer_id is opaque "faceless rails" — present but NOT identity into workers.
    expect(cols).toContain("payer_id");
  });

  it("unlock_routing has a relay_handle (non-reversible) but NO phone column", () => {
    const cols = Object.values(getTableColumns(unlockRouting)).map((c) => c.name);
    expect(cols).toContain("relay_handle"); // opaque, non-reversible handle (F-4)
    expect(cols).toContain("routing_token"); // server-internal token (F-4)
    expect(cols).not.toContain("phone");
  });
});
