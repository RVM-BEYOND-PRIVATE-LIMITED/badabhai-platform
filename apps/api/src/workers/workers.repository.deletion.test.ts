import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { workers, type Database } from "@badabhai/db";
import { WorkersRepository } from "./workers.repository";

/**
 * STRUCTURAL tests for the ADR-0031 deletion-lifecycle queries (the reach.repository.test.ts
 * pattern): the service/sweep tests mock this repository, so the load-bearing semantics —
 * the ATOMIC set-if-not-set / clear-if-set transitions and the sweep's due-window re-check —
 * live in the SQL itself. These capture the Drizzle fluent chain and compile the captured
 * predicates, pinning the real conditional UPDATE shapes instead of an in-memory
 * reimplementation of them.
 */

const dialect = new PgDialect();
const q = (cond: unknown) => dialect.sqlToQuery(cond as SQL);

type Captured = {
  updateTable?: unknown;
  set?: Record<string, unknown>;
  selectTable?: unknown;
  selection?: Record<string, unknown>;
  where?: unknown;
  orderBy?: unknown;
  limit?: number;
};

/** Capturing mock for update(...).set(...).where(...).returning(...) chains. */
function makeUpdateDb(rows: unknown[]) {
  const captured: Captured = {};
  const db = {
    update: (table: unknown) => {
      captured.updateTable = table;
      return {
        set: (vals: Record<string, unknown>) => {
          captured.set = vals;
          return {
            where: (cond: unknown) => {
              captured.where = cond;
              return { returning: () => Promise.resolve(rows) };
            },
          };
        },
      };
    },
  } as unknown as Database;
  return { db, captured };
}

/** Capturing mock for select(...).from(...).where(...).orderBy(...).limit(...) chains. */
function makeSelectDb(rows: unknown[]) {
  const captured: Captured = {};
  const db = {
    select: (selection: Record<string, unknown>) => {
      captured.selection = selection;
      return {
        from: (table: unknown) => {
          captured.selectTable = table;
          return {
            where: (cond: unknown) => {
              captured.where = cond;
              return {
                orderBy: (order: unknown) => {
                  captured.orderBy = order;
                  return { limit: (n: number) => ((captured.limit = n), Promise.resolve(rows)) };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as Database;
  return { db, captured };
}

/** Capturing mock for the select(...).from(...).where(...).limit(...) chain (no orderBy) —
 * the shape findSelfView uses for a single-row lookup by id. */
function makeSelfViewDb(rows: unknown[]) {
  const captured: Captured = {};
  const db = {
    select: (selection: Record<string, unknown>) => {
      captured.selection = selection;
      return {
        from: (table: unknown) => {
          captured.selectTable = table;
          return {
            where: (cond: unknown) => {
              captured.where = cond;
              return { limit: (n: number) => ((captured.limit = n), Promise.resolve(rows)) };
            },
          };
        },
      };
    },
  } as unknown as Database;
  return { db, captured };
}

const WORKER_ID = "33333333-3333-4333-8333-000000000001";
const NOW = new Date("2026-07-21T10:00:00.000Z");
const DUE = new Date("2026-07-28T10:00:00.000Z");

describe("WorkersRepository — ADR-0031 deletion-lifecycle SQL shapes", () => {
  it("scheduleDeletion is ATOMIC set-if-not-set: WHERE id = ? AND deletion_scheduled_at IS NULL", async () => {
    const { db, captured } = makeUpdateDb([{ id: WORKER_ID }]);
    await new WorkersRepository(db).scheduleDeletion(WORKER_ID, DUE);
    expect(captured.updateTable).toBe(workers);
    const { sql, params } = q(captured.where);
    expect(sql).toBe('("workers"."id" = $1 and "workers"."deletion_scheduled_at" is null)');
    expect(params).toEqual([WORKER_ID]);
    // Sets the due time (and touches updated_at) — nothing else.
    expect(captured.set!.deletionScheduledAt).toBe(DUE);
    expect(Object.keys(captured.set!).sort()).toEqual(["deletionScheduledAt", "updatedAt"]);
  });

  it("cancelDeletion is ATOMIC clear-if-set: WHERE id = ? AND deletion_scheduled_at IS NOT NULL", async () => {
    const { db, captured } = makeUpdateDb([{ id: WORKER_ID }]);
    await new WorkersRepository(db).cancelDeletion(WORKER_ID);
    const { sql, params } = q(captured.where);
    expect(sql).toBe('("workers"."id" = $1 and "workers"."deletion_scheduled_at" is not null)');
    expect(params).toEqual([WORKER_ID]);
    expect(captured.set!.deletionScheduledAt).toBeNull();
  });

  it("schedule/cancel report ownership of the transition: row back = owned, undefined = lost/no-op", async () => {
    const owned = await new WorkersRepository(makeUpdateDb([{ id: WORKER_ID }]).db).scheduleDeletion(WORKER_ID, DUE);
    expect(owned).toEqual({ id: WORKER_ID });
    const lost = await new WorkersRepository(makeUpdateDb([]).db).cancelDeletion(WORKER_ID);
    expect(lost).toBeUndefined();
  });

  it("findDueDeletions selects ONLY ids of overdue pending rows, oldest first, bounded", async () => {
    const { db, captured } = makeSelectDb([{ id: WORKER_ID }]);
    const ids = await new WorkersRepository(db).findDueDeletions(NOW, 100);
    expect(captured.selectTable).toBe(workers);
    // Projection: the id only — the sweep never reads PII columns.
    expect(Object.keys(captured.selection!)).toEqual(["id"]);
    const { sql, params } = q(captured.where);
    expect(sql).toBe(
      '("workers"."deletion_scheduled_at" is not null and "workers"."deletion_scheduled_at" <= $1)',
    );
    expect(params).toEqual([NOW.toISOString()]); // drizzle serializes Date params to ISO
    expect(q(captured.orderBy).sql).toBe('"workers"."deletion_scheduled_at" asc');
    expect(captured.limit).toBe(100);
    expect(ids).toEqual([WORKER_ID]);
  });

  it("claimDueDeletion re-checks STILL-due atomically: WHERE id = ? AND pending AND <= now (the cancel-vs-sweep guard)", async () => {
    const { db, captured } = makeUpdateDb([{ id: WORKER_ID }]);
    const claimed = await new WorkersRepository(db).claimDueDeletion(WORKER_ID, NOW);
    expect(claimed).toBe(true);
    const { sql, params } = q(captured.where);
    expect(sql).toBe(
      '("workers"."id" = $1 and "workers"."deletion_scheduled_at" is not null and "workers"."deletion_scheduled_at" <= $2)',
    );
    expect(params).toEqual([WORKER_ID, NOW.toISOString()]);
    // The claim NEVER consumes the marker (only updated_at is bumped) — a failed execute()
    // stays due and is re-swept next tick (best-effort-complete). Single-sweeper semantics
    // are guaranteed by the BullMQ job scheduler (one repeatable job cluster-wide).
    expect(Object.keys(captured.set!)).toEqual(["updatedAt"]);
  });

  it("a cancelled row does NOT claim: conditional UPDATE matches nothing → false", async () => {
    const { db } = makeUpdateDb([]);
    const claimed = await new WorkersRepository(db).claimDueDeletion(WORKER_ID, NOW);
    expect(claimed).toBe(false);
  });

  it("findSelfView projects ONLY status + the marker — GET /auth/me can never fetch a PII column", async () => {
    const { db, captured } = makeSelfViewDb([{ status: "active", deletionScheduledAt: DUE }]);
    const row = await new WorkersRepository(db).findSelfView(WORKER_ID);

    expect(captured.selectTable).toBe(workers);
    // The load-bearing assertion: an EXPLICIT projection, NOT select() (SELECT *). The
    // PII columns (phone_e164 ciphertext, phone_hash, full_name) are not in the result set
    // at all, so /auth/me cannot leak one even by accident.
    expect(Object.keys(captured.selection!).sort()).toEqual(["deletionScheduledAt", "status"]);
    const { sql, params } = q(captured.where);
    expect(sql).toBe('"workers"."id" = $1');
    expect(params).toEqual([WORKER_ID]);
    expect(captured.limit).toBe(1);
    expect(row).toEqual({ status: "active", deletionScheduledAt: DUE });
  });

  it("findSelfView returns undefined when no worker matches (erased mid-session)", async () => {
    const { db } = makeSelfViewDb([]);
    expect(await new WorkersRepository(db).findSelfView(WORKER_ID)).toBeUndefined();
  });
});
