import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Database, creditLedger, payerCredits } from "@badabhai/db";
import { AdminActionsRepository } from "./admin-actions.repository";

const dialect = new PgDialect();

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

describe("AdminActionsRepository.reinstatePayer — guarded suspended→previous_status", () => {
  it("restores the PREVIOUS status (not a hardcoded active) and clears the column", async () => {
    // ADR-0037. The target status is now computed IN SQL from the row itself
    // (`coalesce(previous_status,'pending')`), so the `set` carries a SQL node rather than
    // a literal — assert on the rendered SQL, which is what actually reaches Postgres.
    const hit = makeDb([{ status: "active" }]);
    expect(await new AdminActionsRepository(hit.db).reinstatePayer(PAYER_ID)).toEqual({
      status: "active",
    });

    const set = hit.updates[0]!.set as Record<string, unknown>;
    const rendered = dialect.sqlToQuery(set.status as SQL);
    expect(rendered.sql).toContain("coalesce");
    expect(rendered.sql).toContain('"previous_status"');
    // The fallback is 'pending' — the LESS privileged state. Defaulting a row suspended
    // before this column existed to 'active' would hand out an activation nobody earned.
    expect(rendered.sql + JSON.stringify(rendered.params)).toContain("pending");
    // Cleared, so previous_status only ever describes the CURRENT suspension.
    expect(set.previousStatus).toBeNull();

    const miss = makeDb([]);
    expect(await new AdminActionsRepository(miss.db).reinstatePayer(PAYER_ID)).toBeUndefined();
  });
});

describe("AdminActionsRepository.suspendPayer — ADR-0037 widened from-state", () => {
  it("accepts BOTH pending and active, and captures the status it moved out of", async () => {
    const m = makeDb([{ status: "suspended", previousStatus: "active" }]);
    await new AdminActionsRepository(m.db).suspendPayer(PAYER_ID);

    // The from-state predicate is an explicit two-value list, NOT `ne('suspended')`.
    // There is no DB CHECK on payers.status, so `ne` would silently accept any future or
    // malformed value; the list fails closed.
    const where = dialect.sqlToQuery(m.updates[0]!.where as SQL);
    expect(where.params).toContain("pending");
    expect(where.params).toContain("active");
    expect(where.params).not.toContain("suspended");

    // previous_status is captured FROM THE ROW inside the same statement — reading the
    // status first and passing it back in would be a TOCTOU.
    const set = m.updates[0]!.set as Record<string, unknown>;
    expect(dialect.sqlToQuery(set.previousStatus as SQL).sql).toContain('"status"');
  });
});

describe("AdminActionsRepository — payer inventory cascade (ADR-0037 Decision 1)", () => {
  it("suspend freezes ONLY the live states, and never the payer's own closes", async () => {
    const m = makeDb([{ id: POSTING_ID }]);
    const res = await new AdminActionsRepository(m.db).suspendPayerInventory(PAYER_ID);
    expect(res).toEqual({ postings: 1, jobs: 1 });

    const postings = dialect.sqlToQuery(m.updates[0]!.where as SQL);
    // Scoped to the OWNING payer — a cascade that missed this would freeze the platform.
    expect(postings.params).toContain(PAYER_ID);
    // The two live states move...
    expect(postings.params).toContain("open");
    expect(postings.params).toContain("paused");
    // ...and `closed` does NOT. It is the payer's OWN decision and it is terminal: sweeping
    // it in would make reinstatement REOPEN jobs the payer had deliberately taken down.
    // `draft` is excluded too — never discoverable, so there is nothing to freeze.
    expect(postings.params).not.toContain("closed");
    expect(postings.params).not.toContain("draft");

    // previous_status is captured FROM THE ROW in the same statement (no cross-row TOCTOU).
    const set = m.updates[0]!.set as Record<string, unknown>;
    expect(dialect.sqlToQuery(set.previousStatus as SQL).sql).toContain('"status"');
    expect(set.status).toBe("suspended");

    // The legacy `jobs` table is swept too — it still backs the worker feed and the agency
    // surface (TD37). Freezing only `job_postings` would leave an agency payer recruiting.
    const legacy = dialect.sqlToQuery(m.updates[1]!.where as SQL);
    expect(legacy.params).toContain(PAYER_ID);
    expect(legacy.params).toContain("open");
  });

  it("reinstate restores the RECORDED status — a paused posting must not come back open", async () => {
    const m = makeDb([{ id: POSTING_ID }]);
    await new AdminActionsRepository(m.db).reinstatePayerInventory(PAYER_ID);

    const set = m.updates[0]!.set as Record<string, unknown>;
    const rendered = dialect.sqlToQuery(set.status as SQL);
    // Restoring to a hardcoded 'open' would silently REPUBLISH a job the payer had paused —
    // the one outcome a reinstatement must never cause.
    expect(rendered.sql).toContain("coalesce");
    expect(rendered.sql).toContain('"previous_status"');
    expect(rendered.sql + JSON.stringify(rendered.params)).toContain("paused");
    expect(rendered.sql).not.toContain("'open'");
    // Cleared, so the column only ever describes the CURRENT suspension (and so the
    // `job_postings_previous_status_chk` CHECK holds on the restored row).
    expect(set.previousStatus).toBeNull();

    // Only `suspended` rows move. A posting force-closed by an admin WHILE the payer was
    // suspended is no longer `suspended`, so it stays closed — that is the "manually
    // closed" carve-out, enforced by the WHERE rather than by a caller remembering it.
    const where = dialect.sqlToQuery(m.updates[0]!.where as SQL);
    expect(where.params).toContain("suspended");
    expect(where.params).toContain(PAYER_ID);
  });

  it("force-close CLEARS previous_status (the admin override the CHECK would otherwise reject)", async () => {
    const m = makeDb([{ id: POSTING_ID }]);
    await new AdminActionsRepository(m.db).forceClosePosting(POSTING_ID, new Date());
    const set = m.updates[0]!.set as Record<string, unknown>;
    expect(set.status).toBe("closed");
    // Required, not cosmetic: `job_postings_previous_status_chk` rejects a non-suspended
    // row that still carries a previous_status, so leaving it set fails the write outright.
    expect(set.previousStatus).toBeNull();
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
