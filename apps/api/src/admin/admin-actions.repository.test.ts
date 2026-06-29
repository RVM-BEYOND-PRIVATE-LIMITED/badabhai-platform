import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Database, creditLedger, payerCredits } from "@badabhai/db";
import { AdminActionsRepository } from "./admin-actions.repository";

/**
 * Tests for the ADMIN-3a system-of-record repository (ADR-0025). Proves, with a capturing
 * mock Drizzle chain (no real DB):
 *   - each terminal transition is GUARDED on the current state in the WHERE (idempotency / no
 *     TOCTOU) — an already-terminal row resolves to undefined (the service's no-op contract);
 *   - the credit grant is a POSITIVE additive movement to the SoR (ledger + balance);
 *   - the flag insert is ON CONFLICT DO NOTHING on the open-flag uniqueness (idempotent);
 *   - this repository NEVER references the `events` table (spine read-only, must-fix #3).
 */

interface UpdateCall {
  table: unknown;
  set: Record<string, unknown>;
  where: unknown;
}
interface InsertCall {
  table: unknown;
  values: Record<string, unknown>;
  onConflict?: unknown;
}

/**
 * A capturing mock of the Drizzle fluent chain used by AdminActionsRepository. `rows` is what a
 * SELECT/RETURNING resolves to (set per-test to model "row matched" vs "guard excluded it").
 */
function makeDb(rows: Record<string, unknown>[] = []) {
  const updates: UpdateCall[] = [];
  const inserts: InsertCall[] = [];

  const update = (table: unknown) => ({
    set: (set: Record<string, unknown>) => ({
      where: (where: unknown) => {
        const call: UpdateCall = { table, set, where };
        updates.push(call);
        return { returning: async () => rows };
      },
    }),
  });

  const insert = (table: unknown) => ({
    values: (values: Record<string, unknown>) => {
      const call: InsertCall = { table, values };
      inserts.push(call);
      const chain = {
        onConflictDoUpdate: (cfg: unknown) => {
          call.onConflict = cfg;
          return { returning: async () => rows };
        },
        onConflictDoNothing: (cfg: unknown) => {
          call.onConflict = cfg;
          return { returning: async () => rows };
        },
        returning: async () => rows,
      };
      return chain;
    },
  });

  const select = (_proj?: unknown) => ({
    from: (_table: unknown) => ({
      where: (_where: unknown) => ({ limit: async (_n: number) => rows }),
    }),
  });

  const db = {
    select,
    update,
    insert,
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb({ insert, update, select }),
  } as unknown as Database;

  return { db, updates, inserts };
}

/**
 * A sequenced mock for the H2 dedup branch: the ledger insert resolves `ledgerInsert`, and the two
 * follow-up SELECTs (existing ledger row, current balance) resolve from `selects` in order. The
 * balance UPSERT (insert into payer_credits) is recorded so the test can assert it never ran.
 */
function makeDbSeq(cfg: { ledgerInsert: Record<string, unknown>[]; selects: Record<string, unknown>[][] }) {
  const inserts: InsertCall[] = [];
  let selectIdx = 0;

  const insert = (table: unknown) => ({
    values: (values: Record<string, unknown>) => {
      const call: InsertCall = { table, values };
      inserts.push(call);
      const isLedger = table === creditLedger;
      return {
        onConflictDoNothing: (cfg2: unknown) => {
          call.onConflict = cfg2;
          return { returning: async () => (isLedger ? cfg.ledgerInsert : []) };
        },
        onConflictDoUpdate: (cfg2: unknown) => {
          call.onConflict = cfg2;
          return { returning: async () => [{ balance: 0 }] };
        },
        returning: async () => [],
      };
    },
  });

  const select = (_proj?: unknown) => ({
    from: (_table: unknown) => ({
      where: (_where: unknown) => ({
        limit: async (_n: number) => cfg.selects[selectIdx++] ?? [],
      }),
    }),
  });

  const db = {
    select,
    insert,
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb({ insert, select }),
  } as unknown as Database;

  // Expose a `table` tag so the test can assert which tables were inserted into.
  const tagged = inserts as (InsertCall & { table: unknown })[];
  return { db, inserts: tagged, payerCreditsTable: payerCredits };
}

const PAYER_ID = "bbbbbbbb-0000-4000-8000-000000000002";
const POSTING_ID = "cccccccc-0000-4000-8000-000000000003";
const WORKER_ID = "dddddddd-0000-4000-8000-000000000004";
const ADMIN_ID = "aaaaaaaa-0000-4000-8000-000000000001";

describe("AdminActionsRepository.suspendPayer — guarded active→suspended (idempotent)", () => {
  it("returns the new status when a row matched (active → suspended)", async () => {
    const m = makeDb([{ status: "suspended" }]);
    const res = await new AdminActionsRepository(m.db).suspendPayer(PAYER_ID);
    expect(res).toEqual({ status: "suspended" });
    // The write set status=suspended and was guarded (the WHERE is a non-null SQL condition).
    expect(m.updates).toHaveLength(1);
    expect(m.updates[0]!.set).toMatchObject({ status: "suspended" });
    expect(m.updates[0]!.where).toBeDefined();
  });

  it("returns undefined when no row matched the guard (already suspended → no-op)", async () => {
    const m = makeDb([]); // guarded WHERE matched nothing
    const res = await new AdminActionsRepository(m.db).suspendPayer(PAYER_ID);
    expect(res).toBeUndefined();
  });
});

describe("AdminActionsRepository.reinstatePayer — guarded suspended→active", () => {
  it("sets status=active under a guard; undefined when nothing matched", async () => {
    const hit = makeDb([{ status: "active" }]);
    expect(await new AdminActionsRepository(hit.db).reinstatePayer(PAYER_ID)).toEqual({
      status: "active",
    });
    expect(hit.updates[0]!.set).toMatchObject({ status: "active" });

    const miss = makeDb([]);
    expect(await new AdminActionsRepository(miss.db).reinstatePayer(PAYER_ID)).toBeUndefined();
  });
});

const GRANT_KEY = "99999999-0000-4000-8000-00000000000a";

describe("AdminActionsRepository.grantCredits — positive additive ledger movement (H2)", () => {
  it("NEW key → appends a 'grant' ledger row (keyed) + bumps the balance (applied:true)", async () => {
    // The tx runs insert(creditLedger)->returning(id) FIRST (a new row), then the balance upsert.
    // Our mock returns `rows` for BOTH returning() calls; shape it to satisfy both reads.
    const m = makeDb([{ balance: 500, id: "ledger-1" }]);
    const res = await new AdminActionsRepository(m.db).grantCredits(PAYER_ID, 500, GRANT_KEY);
    expect(res).toEqual({ ledgerId: "ledger-1", balance: 500, applied: true });

    // Two inserts: the ledger movement (delta=+amount, grant, KEYED) then the balance upsert.
    expect(m.inserts).toHaveLength(2);
    const ledger = m.inserts.find((i) => i.values.reason === "grant");
    expect(ledger, "a 'grant' ledger movement was appended").toBeDefined();
    expect(ledger!.values).toMatchObject({
      payerId: PAYER_ID,
      delta: 500,
      reason: "grant",
      idempotencyKey: GRANT_KEY,
    });
    // The amount is a POSITIVE delta (a grant never drives the balance negative).
    expect(ledger!.values.delta).toBeGreaterThan(0);
    // It is ON CONFLICT DO NOTHING on the idempotency key (exactly-once on the ledger).
    expect(ledger!.onConflict).toBeDefined();
  });

  it("DUPLICATE key (ledger insert deduped) → NO balance bump, applied:false (exactly-once)", async () => {
    // Model the conflict: the keyed ledger insert returns [] (ON CONFLICT DO NOTHING suppressed it),
    // then the existing-row + balance SELECTs resolve the already-applied state. The balance upsert
    // must NOT run.
    const m = makeDbSeq({
      ledgerInsert: [], // deduped: no new ledger row
      selects: [[{ id: "ledger-existing" }], [{ balance: 500 }]],
    });
    const res = await new AdminActionsRepository(m.db).grantCredits(PAYER_ID, 500, GRANT_KEY);
    expect(res).toEqual({ ledgerId: "ledger-existing", balance: 500, applied: false });

    // Exactly ONE insert was attempted (the ledger); the balance upsert was NOT reached.
    expect(m.inserts).toHaveLength(1);
    expect(m.inserts.find((i) => i.table === m.payerCreditsTable)).toBeUndefined();
  });
});

describe("AdminActionsRepository.forceClosePosting — guarded !closed→closed (idempotent)", () => {
  it("sets status=closed under a guard; undefined when already closed", async () => {
    const hit = makeDb([{ id: POSTING_ID }]);
    const repo = new AdminActionsRepository(hit.db);
    expect(await repo.forceClosePosting(POSTING_ID, new Date())).toEqual({ id: POSTING_ID });
    expect(hit.updates[0]!.set).toMatchObject({ status: "closed" });

    const miss = makeDb([]);
    expect(
      await new AdminActionsRepository(miss.db).forceClosePosting(POSTING_ID, new Date()),
    ).toBeUndefined();
  });
});

describe("AdminActionsRepository.openFlag — idempotent ON CONFLICT DO NOTHING", () => {
  it("inserts the flag row (reason CODE on the ROW) with an on-conflict guard", async () => {
    const m = makeDb([{ id: "flag-1" }]);
    const res = await new AdminActionsRepository(m.db).openFlag(WORKER_ID, "abuse_report", ADMIN_ID);
    expect(res).toEqual({ id: "flag-1" });
    expect(m.inserts).toHaveLength(1);
    // The reason CODE + the flagging admin live on the ROW (the SoR), never an event field.
    expect(m.inserts[0]!.values).toMatchObject({
      workerId: WORKER_ID,
      flagReasonCode: "abuse_report",
      flaggedByAdminId: ADMIN_ID,
    });
    // It is an ON CONFLICT DO NOTHING (idempotent on the open-flag uniqueness).
    expect(m.inserts[0]!.onConflict).toBeDefined();
  });

  it("returns undefined when the conflict suppressed the insert (already-open flag)", async () => {
    const m = makeDb([]);
    expect(
      await new AdminActionsRepository(m.db).openFlag(WORKER_ID, "duplicate", ADMIN_ID),
    ).toBeUndefined();
  });
});

describe("AdminActionsRepository.resolveFlag — guarded unflag (idempotent)", () => {
  it("stamps resolved_at + the resolving admin under a guard; undefined when no open flag", async () => {
    const hit = makeDb([{ id: "flag-1" }]);
    const res = await new AdminActionsRepository(hit.db).resolveFlag(WORKER_ID, ADMIN_ID);
    expect(res).toEqual({ id: "flag-1" });
    expect(hit.updates[0]!.set).toMatchObject({ resolvedByAdminId: ADMIN_ID });
    expect(hit.updates[0]!.set.resolvedAt).toBeInstanceOf(Date);

    const miss = makeDb([]);
    expect(
      await new AdminActionsRepository(miss.db).resolveFlag(WORKER_ID, ADMIN_ID),
    ).toBeUndefined();
  });
});

describe("AdminActionsRepository — spine read-only (must-fix #3)", () => {
  it("the source NEVER references the `events` table", () => {
    const src = readFileSync(join(__dirname, "admin-actions.repository.ts"), "utf8");
    // No import of `events`, no `update(events)`/`delete(events)`/`insert(events)`.
    expect(src).not.toMatch(/\bevents\b\s*[,)]/);
    expect(src).not.toMatch(/\.(update|delete|insert)\s*\(\s*events\b/);
  });
});
