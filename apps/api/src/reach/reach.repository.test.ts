import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { workers, type Database } from "@badabhai/db";
import { ReachRepository } from "./reach.repository";

/**
 * STRUCTURAL tests for the worker-pool read (ADR-0011 D8 + ADR-0031 ruling (b)).
 *
 * The service tests mock this repository, so the ADR-0031 payer-surface freeze —
 * "a pending-deletion worker's profile row is excluded from the pool, and thus from
 * every ranked list built on it" — lives in the QUERY itself. These tests capture the
 * Drizzle fluent chain (the admin.repository.test.ts pattern) and compile the captured
 * conditions to SQL, proving the pool read is `worker_profiles INNER JOIN workers` with
 * the single MEMBERSHIP predicate `deletion_scheduled_at IS NULL` — an ELIGIBILITY
 * exclusion (same class as a hard-deleted worker), never a relevance WHERE (D8
 * sort-never-block still holds inside the eligible pool).
 */

const dialect = new PgDialect();
const compile = (cond: unknown): string => dialect.sqlToQuery(cond as SQL).sql;

type Captured = {
  selection?: Record<string, unknown>;
  joinTable?: unknown;
  joinOn?: unknown;
  where?: unknown;
};

/** Capturing mock of the listSignalRows chain: select(cols).from().innerJoin().where(). */
function makeDb(rows: unknown[]) {
  const captured: Captured = {};
  const db = {
    select: (selection: Record<string, unknown>) => {
      captured.selection = selection;
      return {
        from: () => ({
          innerJoin: (table: unknown, on: unknown) => {
            captured.joinTable = table;
            captured.joinOn = on;
            return {
              // The awaited terminal link — resolves the (already-DB-filtered) rows.
              where: (cond: unknown) => {
                captured.where = cond;
                return Promise.resolve(rows);
              },
            };
          },
        }),
      };
    },
  } as unknown as Database;
  return { db, captured };
}

function signalRow(n: number): Record<string, unknown> {
  return {
    workerId: `33333333-3333-4333-8333-${n.toString(16).padStart(12, "0")}`,
    canonicalRoleId: "vmc_operator",
    canonicalTradeId: "cnc_vmc",
    experience: { total_years: 5 },
    salaryExpectation: { amount_min: 22000, period: "monthly" },
    locationPreference: { preferred_cities: ["pune"] },
    availability: { status: "immediate" },
    updatedAt: new Date("2026-06-10T00:00:00.000Z"),
  };
}

describe("ReachRepository.listSignalRows — ADR-0031 pending-deletion pool exclusion", () => {
  it("INNER JOINs the workers table on worker_profiles.worker_id = workers.id", async () => {
    const { db, captured } = makeDb([]);
    await new ReachRepository(db).listSignalRows();
    // The join target is the REAL workers table object (not a lookalike) …
    expect(captured.joinTable).toBe(workers);
    // … keyed on the profile→worker identity join.
    expect(compile(captured.joinOn)).toBe('"worker_profiles"."worker_id" = "workers"."id"');
  });

  it("filters on workers.deletion_scheduled_at IS NULL — a pending-deletion worker is NOT a pool member", async () => {
    const { db, captured } = makeDb([]);
    await new ReachRepository(db).listSignalRows();
    expect(compile(captured.where)).toBe('"workers"."deletion_scheduled_at" is null');
  });

  it("the exclusion is ELIGIBILITY, not relevance (D8): a bare IS NULL — no bound signal/score values", async () => {
    const { db, captured } = makeDb([]);
    await new ReachRepository(db).listSignalRows();
    // A relevance WHERE would bind values (city/pay/experience …); membership binds none.
    expect(dialect.sqlToQuery(captured.where as SQL).params).toEqual([]);
  });

  it("returns the eligible rows verbatim — count in == count out over the eligible pool", async () => {
    const eligible = [signalRow(1), signalRow(2), signalRow(3)];
    const { db } = makeDb(eligible);
    const out = await new ReachRepository(db).listSignalRows();
    expect(out).toBe(eligible); // no mapping, no client-side re-filtering
    expect(out).toHaveLength(3);
  });

  it("PROJECTION DISCIPLINE (D8): the join changes membership only — the selection stays the signal columns (never embedding/raw_profile/PII)", async () => {
    const { db, captured } = makeDb([]);
    await new ReachRepository(db).listSignalRows();
    expect(Object.keys(captured.selection!).sort()).toEqual(
      [
        "workerId",
        "canonicalRoleId",
        "canonicalTradeId",
        "experience",
        "salaryExpectation",
        "locationPreference",
        "availability",
        // `skills` joined the signal projection with ADR-0033 (canonical closed-set
        // ids, not free text) BEFORE this branch landed — it is a legitimate signal
        // column, not something this join widened. The banned-column loop below is
        // what actually guards the PII boundary.
        "skills",
        "updatedAt",
      ].sort(),
    );
    // The joined workers table must not leak columns into the projection.
    for (const banned of ["embedding", "rawProfile", "phoneE164", "phoneHash", "fullName", "deletionScheduledAt"]) {
      expect(captured.selection).not.toHaveProperty(banned);
    }
  });
});
