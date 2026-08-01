import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  unlocks,
  unlockRouting,
  payerCredits,
  creditLedger,
  paymentOrders,
  workers,
  type Database,
} from "@badabhai/db";
import { UnlocksRepository, RAZORPAY_PROVIDER } from "./unlocks.repository";

/**
 * STRUCTURAL tests for the Contact Unlock + Reveal repository (ADR-0010 Stream A), the
 * `reach.repository.test.ts` / `admin-actions.repository.test.ts` pattern: capture the
 * Drizzle fluent chain (or the raw `sql` template) and compile it with the real
 * `PgDialect`, then assert on the TEXT and the BOUND PARAMETERS — no live database.
 *
 * This is PURE data-access coverage (TD122): the chokepoint atomicity itself (the
 * advisory lock + one-tx grant/reveal) is proved by `unlocks.service.test.ts`, which
 * mocks this repository outright. What lives here is "does the SQL this repository
 * builds actually say what its comment claims" — the compare-and-set predicates, the
 * PII-free projections, the ON CONFLICT targets/sets.
 */

const dialect = new PgDialect();
const compile = (cond: unknown) => dialect.sqlToQuery(cond as SQL);
const text = (cond: unknown) => compile(cond).sql;
const params = (cond: unknown) => compile(cond).params;

const PAYER_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const WORKER_ID = "bbbbbbbb-0000-4000-8000-000000000002";
const JOB_ID = "cccccccc-0000-4000-8000-000000000003";
const UNLOCK_ID = "dddddddd-0000-4000-8000-000000000004";

interface InsertCall {
  table: unknown;
  values: unknown;
  conflict?: unknown;
}

interface Captured {
  selection?: Record<string, unknown>;
  selectTable?: unknown;
  where?: unknown;
  orderBy?: unknown;
  limit?: number;
  forMode?: string;
  updateTable?: unknown;
  updateSet?: Record<string, unknown>;
  /** Every insert(...).values(...) call, in order — supports methods that insert twice. */
  inserts: InsertCall[];
  /** Convenience accessor for the single-insert methods (the LAST insert captured). */
  insertTable?: unknown;
  insertValues?: unknown;
  conflict?: unknown;
  executed: { sql: string; params: unknown[] }[];
}

/**
 * A capturing mock spanning select/insert/update/execute for BOTH `this.db` and a `tx`
 * handle (they share the same shape here — the repository never branches on which one
 * it received). `rows` is what the terminal `.returning()`/`.limit()`/await resolves to;
 * pass an array of arrays via `sequence` to hand back different rows per call (e.g. two
 * SELECTs, or two inserts, in one method).
 */
function makeDb(opts: { rows?: unknown[]; sequence?: unknown[][] } = {}) {
  const captured: Captured = { inserts: [], executed: [] };
  const seq = opts.sequence ? [...opts.sequence] : undefined;
  const nextRows = () => (seq ? (seq.shift() ?? []) : (opts.rows ?? []));

  const selectChain = () => {
    const node: Record<string, unknown> = {
      from: (t: unknown) => {
        captured.selectTable = t;
        return node;
      },
      where: (c: unknown) => {
        captured.where = c;
        return node;
      },
      orderBy: (o: unknown) => {
        captured.orderBy = o;
        return node;
      },
      limit: (n: number) => {
        captured.limit = n;
        return node;
      },
      for: (mode: string) => {
        captured.forMode = mode;
        return node;
      },
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(nextRows()).then(res, rej),
    };
    return node;
  };

  const insertChain = (table: unknown) => {
    const entry: InsertCall = { table, values: undefined };
    const build = () => ({
      returning: () => Promise.resolve(nextRows()),
      onConflictDoUpdate: (cfg: unknown) => {
        entry.conflict = cfg;
        captured.conflict = cfg;
        return build();
      },
      onConflictDoNothing: (cfg: unknown) => {
        entry.conflict = cfg;
        captured.conflict = cfg;
        return build();
      },
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(undefined).then(res, rej),
    });
    return {
      values: (values: unknown) => {
        entry.values = values;
        captured.inserts.push(entry);
        captured.insertTable = table;
        captured.insertValues = values;
        return build();
      },
    };
  };

  const updateChain = (table: unknown) => ({
    set: (vals: Record<string, unknown>) => {
      captured.updateTable = table;
      captured.updateSet = vals;
      return {
        where: (c: unknown) => {
          captured.where = c;
          return {
            returning: () => Promise.resolve(nextRows()),
          };
        },
      };
    },
  });

  const execute = (stmt: unknown) => {
    const q = compile(stmt);
    captured.executed.push({ sql: q.sql, params: q.params });
    return Promise.resolve(nextRows());
  };

  const handle = {
    select: (selection?: Record<string, unknown>) => {
      captured.selection = selection;
      return selectChain();
    },
    insert: insertChain,
    update: updateChain,
    execute,
  };

  const db = {
    ...handle,
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(handle),
  } as unknown as Database;

  return { db, tx: handle as unknown as Parameters<UnlocksRepository["lockWorker"]>[0], captured };
}

describe("UnlocksRepository.withTransaction — delegates straight to db.transaction", () => {
  it("runs `work` inside the DB's own transaction and returns its result", async () => {
    const { db } = makeDb();
    const result = await new UnlocksRepository(db).withTransaction(async () => "done");
    expect(result).toBe("done");
  });
});

describe("UnlocksRepository.lockWorker — per-worker advisory xact lock", () => {
  it("takes a transaction-scoped advisory lock keyed on the worker id", async () => {
    const { db, tx, captured } = makeDb();
    await new UnlocksRepository(db).lockWorker(tx, WORKER_ID);
    expect(captured.executed).toHaveLength(1);
    const { sql, params: p } = captured.executed[0]!;
    expect(sql).toBe("select pg_advisory_xact_lock(hashtextextended($1, 0))");
    expect(p).toEqual([WORKER_ID]);
  });
});

describe("UnlocksRepository.getWorkerDeletionMarker — tx-scoped, PII-free single-column read", () => {
  it("selects ONLY deletion_scheduled_at from workers, scoped by id", async () => {
    const { db, tx, captured } = makeDb({ rows: [{ deletionScheduledAt: null }] });
    const out = await new UnlocksRepository(db).getWorkerDeletionMarker(tx, WORKER_ID);
    expect(captured.selectTable).toBe(workers);
    expect(Object.keys(captured.selection!)).toEqual(["deletionScheduledAt"]);
    expect(text(captured.where)).toBe('"workers"."id" = $1');
    expect(params(captured.where)).toEqual([WORKER_ID]);
    expect(captured.limit).toBe(1);
    expect(out).toEqual({ deletionScheduledAt: null });
  });

  it("returns undefined when the worker row is gone", async () => {
    const { db, tx } = makeDb({ rows: [] });
    expect(await new UnlocksRepository(db).getWorkerDeletionMarker(tx, WORKER_ID)).toBeUndefined();
  });
});

describe("UnlocksRepository.findByPayerWorker — (payer, worker) lookup", () => {
  it("scopes to BOTH payer_id and worker_id, one row", async () => {
    const { db, tx, captured } = makeDb({ rows: [] });
    await new UnlocksRepository(db).findByPayerWorker(tx, PAYER_ID, WORKER_ID);
    expect(captured.selectTable).toBe(unlocks);
    const { sql, params: p } = compile(captured.where);
    expect(sql).toBe('("unlocks"."payer_id" = $1 and "unlocks"."worker_id" = $2)');
    expect(p).toEqual([PAYER_ID, WORKER_ID]);
    expect(captured.limit).toBe(1);
  });
});

describe("UnlocksRepository.findByIdForUpdate — locked single-row read for reveal", () => {
  it("scopes by id, limits to one, and takes a row lock (FOR UPDATE)", async () => {
    const { db, tx, captured } = makeDb({ rows: [] });
    await new UnlocksRepository(db).findByIdForUpdate(tx, UNLOCK_ID);
    expect(captured.selectTable).toBe(unlocks);
    expect(text(captured.where)).toBe('"unlocks"."id" = $1');
    expect(params(captured.where)).toEqual([UNLOCK_ID]);
    expect(captured.limit).toBe(1);
    expect(captured.forMode).toBe("update");
  });
});

describe("UnlocksRepository.countRevealsSince — cap window sum", () => {
  it("scopes to the worker and the grantedAt window, and sums reveal_count", async () => {
    const { db, tx, captured } = makeDb({ rows: [{ total: 3 }] });
    const since = new Date("2026-07-30T00:00:00.000Z");
    const out = await new UnlocksRepository(db).countRevealsSince(tx, WORKER_ID, since);
    expect(captured.selectTable).toBe(unlocks);
    const { sql, params: p } = compile(captured.where);
    expect(sql).toBe('("unlocks"."worker_id" = $1 and "unlocks"."granted_at" >= $2)');
    expect(p).toEqual([WORKER_ID, since.toISOString()]);
    expect(out).toBe(3);
  });

  it("returns 0 when there is no row (never undefined into the cap check)", async () => {
    const { db, tx } = makeDb({ rows: [] });
    expect(await new UnlocksRepository(db).countRevealsSince(tx, WORKER_ID, new Date())).toBe(0);
  });
});

describe("UnlocksRepository.countDistinctPayersSince — weekly-cap distinct payer count", () => {
  it("scopes to worker + window + only granted/revealed statuses", async () => {
    const { db, tx, captured } = makeDb({ rows: [{ count: 2 }] });
    const since = new Date("2026-07-24T00:00:00.000Z");
    const out = await new UnlocksRepository(db).countDistinctPayersSince(tx, WORKER_ID, since);
    const { sql, params: p } = compile(captured.where);
    expect(sql).toContain('"unlocks"."worker_id" = $1');
    expect(sql).toContain('"unlocks"."granted_at" >= $2');
    expect(sql).toContain("in ('granted','revealed')");
    expect(p).toEqual([WORKER_ID, since.toISOString()]);
    expect(out).toBe(2);
  });

  it("returns 0 when there is no row", async () => {
    const { db, tx } = makeDb({ rows: [] });
    expect(await new UnlocksRepository(db).countDistinctPayersSince(tx, WORKER_ID, new Date())).toBe(0);
  });
});

describe("UnlocksRepository.upsertGrant — idempotent GRANT upsert on (payer, worker)", () => {
  const input = {
    payerId: PAYER_ID,
    workerId: WORKER_ID,
    jobId: JOB_ID,
    routingTokenRef: "eeeeeeee-0000-4000-8000-000000000005",
    grantedAt: new Date("2026-07-31T00:00:00.000Z"),
    expiresAt: new Date("2026-08-14T00:00:00.000Z"),
  };

  it("inserts a GRANTED row with the routing ref and no deny reason", async () => {
    const { db, tx, captured } = makeDb({ rows: [{ id: UNLOCK_ID, status: "granted" }] });
    await new UnlocksRepository(db).upsertGrant(tx, input);
    expect(captured.insertTable).toBe(unlocks);
    expect(captured.insertValues).toMatchObject({
      payerId: PAYER_ID,
      workerId: WORKER_ID,
      jobId: JOB_ID,
      status: "granted",
      denyReason: null,
      routingTokenRef: input.routingTokenRef,
    });
  });

  it("the ON CONFLICT target is the (payer_id, worker_id) uniqueness, re-setting the same grant fields", async () => {
    const { db, tx, captured } = makeDb({ rows: [{ id: UNLOCK_ID }] });
    await new UnlocksRepository(db).upsertGrant(tx, input);
    const conflict = captured.conflict as { target: unknown[]; set: Record<string, unknown> };
    expect(conflict.target).toEqual([unlocks.payerId, unlocks.workerId]);
    expect(conflict.set).toMatchObject({
      jobId: JOB_ID,
      status: "granted",
      denyReason: null,
      routingTokenRef: input.routingTokenRef,
    });
  });

  it("throws if the insert/upsert somehow returns no row", async () => {
    const { db, tx } = makeDb({ rows: [] });
    await expect(new UnlocksRepository(db).upsertGrant(tx, input)).rejects.toThrow(
      "Failed to upsert unlock grant",
    );
  });
});

describe("UnlocksRepository.recordDeny — idempotent DENY upsert that never downgrades a live grant", () => {
  const input = { payerId: PAYER_ID, workerId: WORKER_ID, jobId: JOB_ID, denyReason: "capped" as const };

  it("inserts a DENIED row with the reason", async () => {
    const { db, tx, captured } = makeDb({ rows: [{ id: UNLOCK_ID, status: "denied" }] });
    await new UnlocksRepository(db).recordDeny(tx, input);
    expect(captured.insertTable).toBe(unlocks);
    expect(captured.insertValues).toMatchObject({
      payerId: PAYER_ID,
      workerId: WORKER_ID,
      jobId: JOB_ID,
      status: "denied",
      denyReason: "capped",
    });
  });

  it("the conflict CASE preserves an existing granted/revealed status+reason instead of overwriting it", async () => {
    const { db, tx, captured } = makeDb({ rows: [{ id: UNLOCK_ID }] });
    await new UnlocksRepository(db).recordDeny(tx, input);
    const conflict = captured.conflict as { target: unknown[]; set: Record<string, unknown> };
    expect(conflict.target).toEqual([unlocks.payerId, unlocks.workerId]);
    const statusSql = text(conflict.set.status);
    expect(statusSql).toContain("case when");
    expect(statusSql).toContain("in ('granted','revealed')");
    expect(statusSql).toContain("else 'denied' end");
    const reasonSql = text(conflict.set.denyReason);
    expect(reasonSql).toContain("case when");
    expect(reasonSql).toContain("in ('granted','revealed')");
  });

  it("throws if nothing came back", async () => {
    const { db, tx } = makeDb({ rows: [] });
    await expect(new UnlocksRepository(db).recordDeny(tx, input)).rejects.toThrow(
      "Failed to record unlock deny",
    );
  });
});

describe("UnlocksRepository.incrementReveal — status=revealed + reveal_count + 1", () => {
  it("sets status=revealed and bumps reveal_count via SQL increment, scoped by id", async () => {
    const { db, tx, captured } = makeDb({ rows: [{ revealCount: 4 }] });
    const out = await new UnlocksRepository(db).incrementReveal(tx, UNLOCK_ID);
    expect(captured.updateTable).toBe(unlocks);
    expect(captured.updateSet!.status).toBe("revealed");
    expect(text(captured.updateSet!.revealCount)).toBe('"unlocks"."reveal_count" + 1');
    expect(text(captured.where)).toBe('"unlocks"."id" = $1');
    expect(params(captured.where)).toEqual([UNLOCK_ID]);
    expect(out).toBe(4);
  });

  it("throws when the row is not found (undefined revealCount)", async () => {
    const { db, tx } = makeDb({ rows: [] });
    await expect(new UnlocksRepository(db).incrementReveal(tx, UNLOCK_ID)).rejects.toThrow(
      "Failed to increment reveal_count",
    );
  });
});

describe("UnlocksRepository.createRouting — PII-free routing-token mapping insert", () => {
  it("inserts the routing row with the fields provided — never a phone column", async () => {
    const { db, tx, captured } = makeDb({
      rows: [{ id: "routing-1", unlockId: UNLOCK_ID }],
    });
    const expiresAt = new Date("2026-08-14T00:00:00.000Z");
    await new UnlocksRepository(db).createRouting(tx, {
      unlockId: UNLOCK_ID,
      routingToken: "ffffffff-0000-4000-8000-000000000006",
      channel: "in_app_relay",
      relayHandle: "relay-handle-1",
      expiresAt,
    });
    expect(captured.insertTable).toBe(unlockRouting);
    expect(captured.insertValues).toEqual({
      unlockId: UNLOCK_ID,
      routingToken: "ffffffff-0000-4000-8000-000000000006",
      channel: "in_app_relay",
      relayHandle: "relay-handle-1",
      expiresAt,
    });
  });

  it("throws when no row is returned", async () => {
    const { db, tx } = makeDb({ rows: [] });
    await expect(
      new UnlocksRepository(db).createRouting(tx, {
        unlockId: UNLOCK_ID,
        routingToken: "ffffffff-0000-4000-8000-000000000006",
        channel: "in_app_relay",
        relayHandle: "relay-handle-1",
        expiresAt: new Date(),
      }),
    ).rejects.toThrow("Failed to create unlock routing");
  });
});

describe("UnlocksRepository.findCreditsForUpdate — locked balance read", () => {
  it("scopes by payer_id, limits to one, and locks the row", async () => {
    const { db, tx, captured } = makeDb({ rows: [{ balance: 10 }] });
    await new UnlocksRepository(db).findCreditsForUpdate(tx, PAYER_ID);
    expect(captured.selectTable).toBe(payerCredits);
    expect(text(captured.where)).toBe('"payer_credits"."payer_id" = $1');
    expect(params(captured.where)).toEqual([PAYER_ID]);
    expect(captured.limit).toBe(1);
    expect(captured.forMode).toBe("update");
  });
});

describe("UnlocksRepository.getBalance — non-tx ops read", () => {
  it("projects ONLY balance, scoped by payer_id", async () => {
    const { db, captured } = makeDb({ rows: [{ balance: 42 }] });
    const out = await new UnlocksRepository(db).getBalance(PAYER_ID);
    expect(captured.selectTable).toBe(payerCredits);
    expect(Object.keys(captured.selection!)).toEqual(["balance"]);
    expect(text(captured.where)).toBe('"payer_credits"."payer_id" = $1');
    expect(out).toBe(42);
  });

  it("returns 0 when the payer has no balance row", async () => {
    const { db } = makeDb({ rows: [] });
    expect(await new UnlocksRepository(db).getBalance(PAYER_ID)).toBe(0);
  });
});

describe("UnlocksRepository.listCreditLedgerByPayer — self-scoped, PII-free, newest first, bounded", () => {
  it("projects the PII-free amounts/ids columns, scoped by payer, newest first, limited", async () => {
    const { db, captured } = makeDb({ rows: [] });
    await new UnlocksRepository(db).listCreditLedgerByPayer(PAYER_ID, 20);
    expect(captured.selectTable).toBe(creditLedger);
    expect(Object.keys(captured.selection!).sort()).toEqual(
      ["id", "delta", "reason", "unlock_id", "pack_code", "payment_ref", "price_inr", "created_at"].sort(),
    );
    expect(text(captured.where)).toBe('"credit_ledger"."payer_id" = $1');
    expect(params(captured.where)).toEqual([PAYER_ID]);
    expect(text(captured.orderBy)).toBe('"credit_ledger"."created_at" desc');
    expect(captured.limit).toBe(20);
  });
});

describe("UnlocksRepository.tryDebit — atomic conditional debit (never negative)", () => {
  it("decrements balance by the amount ONLY where balance >= amount", async () => {
    const { db, tx, captured } = makeDb({ rows: [{ balance: 4 }] });
    const out = await new UnlocksRepository(db).tryDebit(tx, PAYER_ID, 1);
    expect(captured.updateTable).toBe(payerCredits);
    expect(text(captured.updateSet!.balance)).toBe('"payer_credits"."balance" - $1');
    expect(params(captured.updateSet!.balance)).toEqual([1]);
    const { sql, params: p } = compile(captured.where);
    expect(sql).toBe('("payer_credits"."payer_id" = $1 and "payer_credits"."balance" >= $2)');
    expect(p).toEqual([PAYER_ID, 1]);
    expect(out).toBe(4);
  });

  it("returns undefined when the guard excludes every row (insufficient credits)", async () => {
    const { db, tx } = makeDb({ rows: [] });
    expect(await new UnlocksRepository(db).tryDebit(tx, PAYER_ID, 100)).toBeUndefined();
  });
});

describe("UnlocksRepository.appendLedger — append-only ledger write", () => {
  it("inserts the movement, defaulting the optional refs to null", async () => {
    const { db, tx, captured } = makeDb();
    await new UnlocksRepository(db).appendLedger(tx, {
      payerId: PAYER_ID,
      delta: -1,
      reason: "unlock_debit",
    });
    expect(captured.insertTable).toBe(creditLedger);
    expect(captured.insertValues).toEqual({
      payerId: PAYER_ID,
      delta: -1,
      reason: "unlock_debit",
      unlockId: null,
      packCode: null,
      paymentRef: null,
    });
  });

  it("carries through explicit refs when given", async () => {
    const { db, tx, captured } = makeDb();
    await new UnlocksRepository(db).appendLedger(tx, {
      payerId: PAYER_ID,
      delta: 10,
      reason: "pack_purchase",
      unlockId: UNLOCK_ID,
      packCode: "pack_10",
      paymentRef: "order-1",
    });
    expect(captured.insertValues).toEqual({
      payerId: PAYER_ID,
      delta: 10,
      reason: "pack_purchase",
      unlockId: UNLOCK_ID,
      packCode: "pack_10",
      paymentRef: "order-1",
    });
  });
});

describe("UnlocksRepository.creditPack / creditPackWithinTx — upsert balance + append ledger", () => {
  it("creditPack opens its OWN transaction and delegates to creditPackWithinTx", async () => {
    const { db } = makeDb({ rows: [{ balance: 10 }] });
    const balance = await new UnlocksRepository(db).creditPack({
      payerId: PAYER_ID,
      credits: 10,
      reason: "pack_purchase",
      packCode: "pack_10",
      paymentRef: "order-1",
      priceInr: 499,
    });
    expect(balance).toBe(10);
  });

  it("upserts payer_credits with a GREATEST-free additive balance bump on conflict", async () => {
    const { db, tx, captured } = makeDb({ sequence: [[{ balance: 10 }], []] });
    await new UnlocksRepository(db).creditPackWithinTx(tx, {
      payerId: PAYER_ID,
      credits: 10,
      reason: "pack_purchase",
      packCode: "pack_10",
      paymentRef: "order-1",
    });
    const balanceInsert = captured.inserts.find((i) => i.table === payerCredits)!;
    expect(balanceInsert.values).toEqual({ payerId: PAYER_ID, balance: 10 });
    const conflict = balanceInsert.conflict as { target: unknown; set: Record<string, unknown> };
    expect(conflict.target).toBe(payerCredits.payerId);
    expect(text(conflict.set.balance)).toBe('"payer_credits"."balance" + $1');
    expect(params(conflict.set.balance)).toEqual([10]);
  });

  it("also appends the ledger movement in the SAME tx, with priceInr/idempotencyKey defaulted to null", async () => {
    const { db, tx, captured } = makeDb({ sequence: [[{ balance: 10 }], []] });
    await new UnlocksRepository(db).creditPackWithinTx(tx, {
      payerId: PAYER_ID,
      credits: 10,
      reason: "pack_purchase",
      packCode: "pack_10",
      paymentRef: "order-1",
    });
    const ledgerInsert = captured.inserts.find((i) => i.table === creditLedger)!;
    expect(ledgerInsert.values).toEqual({
      payerId: PAYER_ID,
      delta: 10,
      reason: "pack_purchase",
      packCode: "pack_10",
      paymentRef: "order-1",
      priceInr: null,
      idempotencyKey: null,
    });
  });

  it("stamps priceInr and idempotencyKey through when provided", async () => {
    const { db, tx, captured } = makeDb({ sequence: [[{ balance: 10 }], []] });
    await new UnlocksRepository(db).creditPackWithinTx(tx, {
      payerId: PAYER_ID,
      credits: 10,
      reason: "pack_purchase",
      packCode: "pack_10",
      paymentRef: "order-1",
      priceInr: 499,
      idempotencyKey: "order-1:paid",
    });
    const ledgerInsert = captured.inserts.find((i) => i.table === creditLedger)!;
    expect(ledgerInsert.values).toMatchObject({ priceInr: 499, idempotencyKey: "order-1:paid" });
  });

  it("throws when the balance upsert returns no row", async () => {
    const { db, tx } = makeDb({ rows: [] });
    await expect(
      new UnlocksRepository(db).creditPackWithinTx(tx, {
        payerId: PAYER_ID,
        credits: 10,
        reason: "pack_purchase",
        packCode: "pack_10",
        paymentRef: "order-1",
      }),
    ).rejects.toThrow("Failed to credit pack");
  });
});

describe("UnlocksRepository.createPaymentOrder — persist a freshly-created provider order", () => {
  it("inserts amountInr + creditsGranted stamped together, status='created', default provider", async () => {
    const { db, captured } = makeDb({ rows: [{ id: "order-1" }] });
    await new UnlocksRepository(db).createPaymentOrder({
      payerId: PAYER_ID,
      packCode: "pack_10",
      amountInr: 499,
      creditsGranted: 10,
      providerOrderId: "rzp_order_1",
    });
    expect(captured.insertTable).toBe(paymentOrders);
    expect(captured.insertValues).toEqual({
      payerId: PAYER_ID,
      packCode: "pack_10",
      amountInr: 499,
      creditsGranted: 10,
      provider: RAZORPAY_PROVIDER,
      providerOrderId: "rzp_order_1",
      status: "created",
    });
  });

  it("honours an explicit provider override", async () => {
    const { db, captured } = makeDb({ rows: [{ id: "order-1" }] });
    await new UnlocksRepository(db).createPaymentOrder({
      payerId: PAYER_ID,
      packCode: "pack_10",
      amountInr: 499,
      creditsGranted: 10,
      providerOrderId: "rzp_order_1",
      provider: "other_provider",
    });
    expect((captured.insertValues as Record<string, unknown>).provider).toBe("other_provider");
  });

  it("throws when no row is returned", async () => {
    const { db } = makeDb({ rows: [] });
    await expect(
      new UnlocksRepository(db).createPaymentOrder({
        payerId: PAYER_ID,
        packCode: "pack_10",
        amountInr: 499,
        creditsGranted: 10,
        providerOrderId: "rzp_order_1",
      }),
    ).rejects.toThrow("Failed to persist payment order");
  });
});

describe("UnlocksRepository.findPaymentOrder — lookup by (provider, provider_order_id)", () => {
  it("scopes to both provider and providerOrderId, defaulting provider to razorpay", async () => {
    const { db, captured } = makeDb({ rows: [] });
    await new UnlocksRepository(db).findPaymentOrder("rzp_order_1");
    expect(captured.selectTable).toBe(paymentOrders);
    const { sql, params: p } = compile(captured.where);
    expect(sql).toBe(
      '("payment_orders"."provider" = $1 and "payment_orders"."provider_order_id" = $2)',
    );
    expect(p).toEqual([RAZORPAY_PROVIDER, "rzp_order_1"]);
    expect(captured.limit).toBe(1);
  });

  it("honours an explicit provider argument", async () => {
    const { db, captured } = makeDb({ rows: [] });
    await new UnlocksRepository(db).findPaymentOrder("order_1", "other_provider");
    expect(params(captured.where)).toEqual(["other_provider", "order_1"]);
  });
});

describe("UnlocksRepository.claimPaymentOrderPaidWithinTx — the compare-and-set race closure", () => {
  it("sets status='paid' + the payment ref, guarded on provider/providerOrderId/status<>'paid'", async () => {
    const { db, tx, captured } = makeDb({ rows: [{ id: "order-1", status: "paid" }] });
    const out = await new UnlocksRepository(db).claimPaymentOrderPaidWithinTx(tx, {
      providerOrderId: "rzp_order_1",
      providerPaymentRef: "pay_1",
    });
    expect(captured.updateTable).toBe(paymentOrders);
    expect(captured.updateSet).toMatchObject({ status: "paid", providerPaymentRef: "pay_1" });
    const { sql, params: p } = compile(captured.where);
    expect(sql).toBe(
      '("payment_orders"."provider" = $1 and "payment_orders"."provider_order_id" = $2 and "payment_orders"."status" <> $3)',
    );
    expect(p).toEqual([RAZORPAY_PROVIDER, "rzp_order_1", "paid"]);
    expect(out).toEqual({ id: "order-1", status: "paid" });
  });

  it("honours an explicit provider override", async () => {
    const { db, tx, captured } = makeDb({ rows: [] });
    await new UnlocksRepository(db).claimPaymentOrderPaidWithinTx(tx, {
      providerOrderId: "order_1",
      providerPaymentRef: "pay_1",
      provider: "other_provider",
    });
    expect(params(captured.where)).toEqual(["other_provider", "order_1", "paid"]);
  });

  it("returns undefined when the compare-and-set matched no row (already paid / not found — the race loser)", async () => {
    const { db, tx } = makeDb({ rows: [] });
    expect(
      await new UnlocksRepository(db).claimPaymentOrderPaidWithinTx(tx, {
        providerOrderId: "rzp_order_1",
        providerPaymentRef: "pay_1",
      }),
    ).toBeUndefined();
  });
});

describe("UnlocksRepository.markPaymentOrderFailed — guarded, never walks back a paid order", () => {
  it("sets status='failed', guarded on provider/providerOrderId/status<>'paid'", async () => {
    const { db, captured } = makeDb({ rows: [{ id: "order-1", status: "failed" }] });
    const out = await new UnlocksRepository(db).markPaymentOrderFailed("rzp_order_1");
    expect(captured.updateTable).toBe(paymentOrders);
    expect(captured.updateSet).toMatchObject({ status: "failed" });
    const { sql, params: p } = compile(captured.where);
    expect(sql).toBe(
      '("payment_orders"."provider" = $1 and "payment_orders"."provider_order_id" = $2 and "payment_orders"."status" <> $3)',
    );
    expect(p).toEqual([RAZORPAY_PROVIDER, "rzp_order_1", "paid"]);
    expect(out).toEqual({ id: "order-1", status: "failed" });
  });

  it("returns undefined when the order is already paid (guard excludes it)", async () => {
    const { db } = makeDb({ rows: [] });
    expect(await new UnlocksRepository(db).markPaymentOrderFailed("rzp_order_1")).toBeUndefined();
  });
});

describe("UnlocksRepository.isPaid — static lifecycle narrowing helper", () => {
  it("is true only for 'paid'", () => {
    expect(UnlocksRepository.isPaid("paid")).toBe(true);
    expect(UnlocksRepository.isPaid("created")).toBe(false);
    expect(UnlocksRepository.isPaid("failed")).toBe(false);
  });
});

describe("UnlocksRepository.listByPayer — PII-free ops list, newest first, capped", () => {
  it("scopes to payer_id, orders newest-first, and bounds the read", async () => {
    const created = new Date("2026-07-31T00:00:00.000Z");
    const row = {
      id: UNLOCK_ID,
      payerId: PAYER_ID,
      workerId: WORKER_ID,
      jobId: JOB_ID,
      status: "granted",
      revealCount: 1,
      grantedAt: created,
      expiresAt: created,
      createdAt: created,
    };
    const { db, captured } = makeDb({ rows: [row] });
    const out = await new UnlocksRepository(db).listByPayer(PAYER_ID);
    expect(captured.selectTable).toBe(unlocks);
    expect(text(captured.where)).toBe('"unlocks"."payer_id" = $1');
    expect(params(captured.where)).toEqual([PAYER_ID]);
    expect(text(captured.orderBy)).toBe('"unlocks"."created_at" desc');
    expect(typeof captured.limit).toBe("number");
    // Projected via `project()` — PII-free shape, snake_case keys.
    expect(out).toEqual([
      {
        unlock_id: UNLOCK_ID,
        payer_id: PAYER_ID,
        worker_id: WORKER_ID,
        job_id: JOB_ID,
        status: "granted",
        reveal_count: 1,
        granted_at: created,
        expires_at: created,
        created_at: created,
      },
    ]);
  });
});

describe("UnlocksRepository.getProjection — single PII-free projection by id", () => {
  it("returns the projected shape when found", async () => {
    const created = new Date("2026-07-31T00:00:00.000Z");
    const row = {
      id: UNLOCK_ID,
      payerId: PAYER_ID,
      workerId: null,
      jobId: null,
      status: "revealed",
      revealCount: 2,
      grantedAt: created,
      expiresAt: created,
      createdAt: created,
    };
    const { db, captured } = makeDb({ rows: [row] });
    const out = await new UnlocksRepository(db).getProjection(UNLOCK_ID);
    expect(captured.selectTable).toBe(unlocks);
    expect(text(captured.where)).toBe('"unlocks"."id" = $1');
    expect(params(captured.where)).toEqual([UNLOCK_ID]);
    expect(captured.limit).toBe(1);
    // `worker_id` NULLABLE post-ADR-0026 (DSAR SET NULL) — must pass through as null, not drop.
    expect(out).toEqual({
      unlock_id: UNLOCK_ID,
      payer_id: PAYER_ID,
      worker_id: null,
      job_id: null,
      status: "revealed",
      reveal_count: 2,
      granted_at: created,
      expires_at: created,
      created_at: created,
    });
  });

  it("returns undefined when no unlock matches the id", async () => {
    const { db } = makeDb({ rows: [] });
    expect(await new UnlocksRepository(db).getProjection(UNLOCK_ID)).toBeUndefined();
  });
});
