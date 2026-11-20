import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "@badabhai/db";
import { CreditBalanceAuditRepository } from "./credit-balance-audit.repository";

/**
 * #2774 — the audit's SQL against real Postgres: every wallet class it must find, and the ones it
 * must not. The database is shared, so each assertion reads only this file's wallet keys.
 *
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api exec vitest run credit-balance-audit.db
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

describe.skipIf(!RUN)("#2774 credit balance audit against Postgres", () => {
  let client: DbClient;
  let repo: CreditBalanceAuditRepository;
  const TAG = randomUUID().slice(0, 8);
  const W = {
    clean: randomUUID(), // balance 10 = ledger 10 = lots 10
    ledgerOff: randomUUID(), // balance 10, ledger 7, lots 10
    lotsOff: randomUUID(), // balance 10, ledger 10, lots 4
    empty: randomUUID(), // balance 0, no ledger, no lots: clean
    orphan: randomUUID(), // ledger 5, a lot of 5, no balance row
    zeroLedger: randomUUID(), // ledger +3 −3, no lot, no balance row: not an orphan
  };
  const ALL: string[] = Object.values(W);

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 2 });
    repo = new CreditBalanceAuditRepository(client.db);
    const sql = client.sql;
    const wallet = (id: string, balance: number) =>
      sql`INSERT INTO payer_credits (payer_id, balance) VALUES (${id}::uuid, ${balance})`;
    const line = (id: string, delta: number) =>
      sql`INSERT INTO credit_ledger (payer_id, delta, reason, idempotency_key)
          VALUES (${id}::uuid, ${delta}, 'ops_grant', ${`audit-db-${TAG}-${randomUUID()}`})`;
    const lot = (id: string, granted: number, remaining: number) =>
      sql`INSERT INTO credit_lots (payer_id, source, credits_granted, credits_remaining)
          VALUES (${id}::uuid, 'goodwill', ${granted}, ${remaining})`;

    await wallet(W.clean, 10);
    await line(W.clean, 10);
    await lot(W.clean, 10, 10);

    await wallet(W.ledgerOff, 10);
    await line(W.ledgerOff, 7);
    await lot(W.ledgerOff, 10, 10);

    await wallet(W.lotsOff, 10);
    await line(W.lotsOff, 10);
    await lot(W.lotsOff, 10, 4);

    await wallet(W.empty, 0);

    await line(W.orphan, 5);
    await lot(W.orphan, 5, 5);

    await line(W.zeroLedger, 3);
    await line(W.zeroLedger, -3);
  });

  afterAll(async () => {
    if (!client) return;
    const sql = client.sql;
    await sql`DELETE FROM credit_ledger WHERE payer_id = ANY(${ALL}::uuid[])`;
    await sql`DELETE FROM credit_lots WHERE payer_id = ANY(${ALL}::uuid[])`;
    await sql`DELETE FROM payer_credits WHERE payer_id = ANY(${ALL}::uuid[])`;
    await client.sql.end({ timeout: 5 });
  });

  it("finds the ledger mismatch, the lot mismatch and the orphan, with their sums", async () => {
    const snap = await repo.read();
    const mine = snap.findings.filter((f) => ALL.includes(f.walletKey));
    const byKey = new Map(mine.map((f) => [f.walletKey, f]));
    expect(byKey.get(W.ledgerOff)).toEqual({
      walletKey: W.ledgerOff,
      balance: 10,
      ledgerSum: 7,
      lotsSum: 10,
    });
    expect(byKey.get(W.lotsOff)).toEqual({
      walletKey: W.lotsOff,
      balance: 10,
      ledgerSum: 10,
      lotsSum: 4,
    });
    expect(byKey.get(W.orphan)).toEqual({
      walletKey: W.orphan,
      balance: null,
      ledgerSum: 5,
      lotsSum: 5,
    });
    expect(mine).toHaveLength(3);
  });

  it("a clean wallet, an empty wallet and a zero-sum key with no wallet are not findings", async () => {
    const keys = (await repo.read()).findings.map((f) => f.walletKey);
    for (const k of [W.clean, W.empty, W.zeroLedger]) expect(keys).not.toContain(k);
  });

  it("counts every key it read, including the ones found only on the ledger or lots", async () => {
    const snap = await repo.read();
    // At least this file's six keys; the shared database may hold more.
    expect(snap.walletsChecked).toBeGreaterThanOrEqual(ALL.length);
  });
});
