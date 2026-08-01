import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { matchConfig, type Database, type MatchConfig as MatchConfigRow } from "@badabhai/db";
import { MatchConfigRepository } from "./match-config.repository";

/**
 * STRUCTURAL tests for the single-active-row read (ADR-0036 §8, migration 0057).
 *
 * The service tests stub this repository, so "which row does apps/api actually load?"
 * is a property of the QUERY and of nothing else. It matters more than it looks:
 * `match_config` is history-bearing (revision N-1 rows stay in the table with
 * `is_active = false`), so a predicate that lost its `= true` — or inverted it — would
 * hand the service a SUPERSEDED revision and every threshold in Matching V1 would
 * quietly regress to whatever ops last replaced. The row would still parse, the service
 * would still report `source: "db"`, and nothing anywhere would look broken.
 *
 * Compiled to SQL with the real PgDialect (the reach.repository.test.ts pattern) rather
 * than compared against a hand-built condition object, so the assertion reads as the
 * predicate a DBA would check.
 */

const dialect = new PgDialect();
const compile = (cond: unknown) => dialect.sqlToQuery(cond as SQL);

type Captured = { from?: unknown; where?: unknown; limit?: unknown };

/** Capturing mock of the select().from().where().limit() chain. */
function makeDb(rows: unknown[]) {
  const captured: Captured = {};
  const db = {
    select: () => ({
      from: (table: unknown) => {
        captured.from = table;
        return {
          where: (cond: unknown) => {
            captured.where = cond;
            return {
              // The awaited terminal link.
              limit: (n: number) => {
                captured.limit = n;
                return Promise.resolve(rows);
              },
            };
          },
        };
      },
    }),
  } as unknown as Database;
  return { db, captured };
}

function row(revision: number, config: unknown): MatchConfigRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    config,
    revision,
    isActive: true,
    updatedBy: "44444444-4444-4444-8444-444444444444",
    createdAt: new Date("2026-07-31T00:00:00.000Z"),
    updatedAt: new Date("2026-07-31T00:00:00.000Z"),
  } as unknown as MatchConfigRow;
}

describe("MatchConfigRepository.getActive — the query targets the ACTIVE row", () => {
  it("reads from the real match_config table (not a lookalike)", async () => {
    const { db, captured } = makeDb([]);
    await new MatchConfigRepository(db).getActive();
    expect(captured.from).toBe(matchConfig);
  });

  it("filters on is_active = TRUE — a superseded revision must never be served", async () => {
    const { db, captured } = makeDb([]);
    await new MatchConfigRepository(db).getActive();
    const q = compile(captured.where);
    expect(q.sql).toBe('"match_config"."is_active" = $1');
    // The bound value is what distinguishes "the live config" from "an old one that
    // ops already replaced" — assert the literal, not just the column.
    expect(q.params).toEqual([true]);
  });

  it("takes at most one row (the partial unique index guarantees at most one anyway)", async () => {
    const { db, captured } = makeDb([]);
    await new MatchConfigRepository(db).getActive();
    expect(captured.limit).toBe(1);
  });
});

describe("MatchConfigRepository.getActive — return shape", () => {
  it("returns the row itself, config blob untouched (validation belongs to the service)", async () => {
    const stored = row(9, { tierFloorMonths: 24, engineVersion: "v1.1" });
    const { db } = makeDb([stored]);
    const out = await new MatchConfigRepository(db).getActive();
    expect(out).toBe(stored);
    // The repository is NOT allowed to coerce, default or drop a field: the service
    // needs the raw blob to tell "valid row" from "row that failed Zod".
    expect(out?.config).toEqual({ tierFloorMonths: 24, engineVersion: "v1.1" });
    expect(out?.revision).toBe(9);
  });

  it("returns undefined when D1 has not seeded a row (never a fabricated empty row)", async () => {
    const { db } = makeDb([]);
    // `undefined` is the signal the service turns into `source: "default", revision: 0`.
    // An empty object here would be reported as `source: "db"` — a lie about provenance.
    expect(await new MatchConfigRepository(db).getActive()).toBeUndefined();
  });

  it("returns the FIRST row if the DB ever hands back more than one", async () => {
    const first = row(2, { tierFloorMonths: 36 });
    const { db } = makeDb([first, row(1, { tierFloorMonths: 12 })]);
    expect(await new MatchConfigRepository(db).getActive()).toBe(first);
  });
});
