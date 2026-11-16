import { describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Database } from "@badabhai/db";
import type { TenantKey } from "../payers/payer-tenant-scope";
import {
  CandidateSearchRepository,
  candidateSearchStatement,
  type CandidatePoolQuery,
} from "./candidate-search.repository";

/**
 * #2753 item 6 — the search pool's one new predicate, threaded through `SEARCH_EXIT_ENABLED`.
 *
 *  - OFF (no config, or the switch false) the statement is BYTE-IDENTICAL to the one before #2753:
 *    the same text, the same parameters, and `worker_search_exits` never named.
 *  - ON, the statement carries exactly ONE `NOT EXISTS (… worker_search_exits …)`, and removing it
 *    gives back the off statement character for character (so nothing else moved).
 *  - It sits over the WHOLE pool: after the institute-grant branch's OR, so a granted student who
 *    left search is out of that company's pool too.
 *  - It reaches all three readers: the search, the city facet and the admin card read.
 *  - ON with the table MISSING (42P01, 0169 not applied) each reader FAILS OPEN: it re-runs the
 *    switch-off statement byte for byte, and the process logs ONE warning. Any other SQLSTATE, and
 *    a 42P01 with the switch off, still throws.
 *
 * The real search excluding and re-including a worker is the DB gate's
 * (`search-exit/worker-search-exits.db.test.ts`).
 */
const dialect = new PgDialect();
const render = (statement: SQL) => dialect.sqlToQuery(statement);

const PREDICATE =
  "\n      AND NOT EXISTS (SELECT 1 FROM worker_search_exits x WHERE x.worker_id = w.id)";
const TENANT = "11111111-1111-4111-8111-111111111111" as TenantKey;
const WORKER = "22222222-2222-4222-8222-222222222222";

function query(over: Partial<CandidatePoolQuery> = {}): CandidatePoolQuery {
  return {
    skillIds: [],
    relatedSkillIds: [],
    experience: null,
    industryId: null,
    industryExperience: null,
    city: null,
    tierFloorMonths: 36,
    strict: false,
    after: null,
    limit: 21,
    ...over,
  };
}

/** Every shape the search runs: plain, filtered, paged, granted (a tenant) and the card read. */
const SHAPES: [string, CandidatePoolQuery][] = [
  ["the whole pool", query()],
  [
    "every filter, strict, paged",
    query({
      skillIds: ["mskill_cnc_turner"],
      relatedSkillIds: ["mskill_vmc_operator"],
      experience: { min: 12, max: 36 },
      industryId: "ind_industrial_manufacturing",
      industryExperience: { min: 6, max: null },
      city: { matchKeys: ["pune"], unrecognisedKeys: ["poona east"] },
      strict: true,
      after: { workerId: WORKER, served: 20 },
    }),
  ],
  ["a company's search (the grant branch)", query({ tenant: TENANT })],
  ["the admin card read (one worker)", query({ onlyWorkerId: WORKER, limit: 1 })],
];

describe("candidateSearchStatement — the search-exit predicate", () => {
  it.each(SHAPES)("OFF is byte-identical, whatever the switch value (%s)", (_name, q) => {
    const absent = render(candidateSearchStatement(q));
    const off = render(candidateSearchStatement({ ...q, excludeSearchExits: false }));
    expect(off.sql).toBe(absent.sql);
    expect(off.params).toEqual(absent.params);
    expect(absent.sql).not.toContain("worker_search_exits");
  });

  it.each(SHAPES)("ON adds exactly the one predicate and nothing else (%s)", (_name, q) => {
    const off = render(candidateSearchStatement(q));
    const on = render(candidateSearchStatement({ ...q, excludeSearchExits: true }));
    expect(on.sql.split(PREDICATE)).toHaveLength(2);
    expect(on.sql.replace(PREDICATE, "")).toBe(off.sql);
    expect(on.params).toEqual(off.params);
  });

  it("ON sits over the WHOLE pool: after the grant branch, before the one-worker narrowing", () => {
    const on = render(
      candidateSearchStatement(
        query({ tenant: TENANT, onlyWorkerId: WORKER, excludeSearchExits: true }),
      ),
    ).sql;
    const pool = on.slice(on.indexOf("WITH consenting AS ("), on.indexOf("wanted AS ("));
    const grant = pool.indexOf("FROM institute_search_grants ws");
    const exit = pool.indexOf("worker_search_exits");
    const only = pool.indexOf("AND w.id = $");
    expect(grant).toBeGreaterThan(0);
    expect(exit).toBeGreaterThan(grant);
    expect(only).toBeGreaterThan(exit);
    // Top level of the WHERE: the predicate follows the parenthesis that closes the OR of the
    // consent branch and the grant branch, so it ANDs with both.
    expect(pool).toContain(`        )\n      )${PREDICATE}\n      AND w.id = $`);
  });
});

/** A database that records every statement and answers the shape each reader expects. */
function recordingDb() {
  const executed: { sql: string; params: unknown[] }[] = [];
  const db = {
    execute: async (statement: SQL) => {
      const q = render(statement);
      executed.push(q);
      // The counts row the search always returns; the city facet tolerates any rows.
      return [{ total: 0, matched: 0, unrecorded: 0, worker_id: null }];
    },
  };
  return { db: db as unknown as Database, executed };
}

describe("CandidateSearchRepository — the switch reaches the search, the city facet and the card read", () => {
  async function runAll(config?: { SEARCH_EXIT_ENABLED: boolean }) {
    const { db, executed } = recordingDb();
    const repo = new CandidateSearchRepository(db, config);
    await repo.searchPool(query({ tenant: TENANT }));
    await repo.listPoolCities();
    await repo.findCardRow(WORKER);
    return executed;
  }

  it("no config (a hand-built instance) and SEARCH_EXIT_ENABLED=false run today's statements", async () => {
    const none = await runAll();
    const off = await runAll({ SEARCH_EXIT_ENABLED: false });
    expect(none).toHaveLength(3);
    expect(off).toEqual(none);
    for (const q of none) expect(q.sql).not.toContain("worker_search_exits");
    // …and they ARE the exported statement, unchanged: the search and the card read.
    expect(none[0]!.sql).toBe(render(candidateSearchStatement(query({ tenant: TENANT }))).sql);
  });

  it("SEARCH_EXIT_ENABLED=true puts the predicate in all three, once each", async () => {
    const on = await runAll({ SEARCH_EXIT_ENABLED: true });
    const off = await runAll();
    expect(on).toHaveLength(3);
    on.forEach((q, i) => {
      expect(q.sql.split(PREDICATE), `statement ${i}`).toHaveLength(2);
      expect(q.sql.replace(PREDICATE, ""), `statement ${i}`).toBe(off[i]!.sql);
      expect(q.params, `statement ${i}`).toEqual(off[i]!.params);
    });
  });

  it("the switch decides, never the caller: a query asking for the predicate gets none while off", async () => {
    const { db, executed } = recordingDb();
    await new CandidateSearchRepository(db, { SEARCH_EXIT_ENABLED: false }).searchPool(
      query({ excludeSearchExits: true }),
    );
    await new CandidateSearchRepository(db).searchPool(query({ excludeSearchExits: true }));
    for (const q of executed) expect(q.sql).not.toContain("worker_search_exits");
  });
});

/** Postgres's undefined_table, shaped as drizzle wraps it (the SQLSTATE on `cause`). */
function driverError(code: string): Error {
  return Object.assign(new Error("Failed query"), {
    cause: Object.assign(new Error(code), { code }),
  });
}

/**
 * A database where `worker_search_exits` does not exist: any statement naming it fails with
 * `missingCode` (42P01 by default), every other statement answers like the recording database.
 */
function missingTableDb(missingCode = "42P01", offFails: string | null = null) {
  const executed: { sql: string; params: unknown[] }[] = [];
  const db = {
    execute: async (statement: SQL) => {
      const q = render(statement);
      executed.push(q);
      if (q.sql.includes("worker_search_exits")) throw driverError(missingCode);
      if (offFails !== null) throw driverError(offFails);
      // The city facet's rows; every other reader gets the counts row.
      if (q.sql.includes("SELECT DISTINCT current_city")) return [];
      return [{ total: 0, matched: 0, unrecorded: 0, worker_id: null }];
    },
  };
  return { db: db as unknown as Database, executed };
}

describe("SEARCH_EXIT_ENABLED on before migration 0169 — the readers FAIL OPEN", () => {
  it("search, city facet and card read: on 42P01 each re-runs the switch-off statement byte for byte; ONE warning per process", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const { db, executed } = missingTableDb();
      const repo = new CandidateSearchRepository(db, { SEARCH_EXIT_ENABLED: true });
      await expect(repo.searchPool(query({ tenant: TENANT }))).resolves.toMatchObject({
        counts: { total: 0, matched: 0, unrecorded: 0 },
        rows: [],
      });
      await expect(repo.listPoolCities()).resolves.toEqual([]);
      await expect(repo.findCardRow(WORKER)).resolves.toBeNull();
      // A second round: still answered, still no second warning.
      await repo.searchPool(query());

      // Two statements per read: the switch's (with the predicate), then today's, exactly.
      expect(executed).toHaveLength(8);
      const off = await runAllOff();
      const pairs = [
        [executed[0], executed[1], off[0]],
        [executed[2], executed[3], off[1]],
        [executed[4], executed[5], off[2]],
      ] as const;
      for (const [first, fallback, today] of pairs) {
        expect(first!.sql).toContain("worker_search_exits");
        expect(fallback!.sql).toBe(today!.sql);
        expect(fallback!.params).toEqual(today!.params);
      }
      expect(executed[7]!.sql).toBe(render(candidateSearchStatement(query())).sql);

      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("worker_search_exits");
      expect(lines[0]).toContain("42P01");
      expect(lines[0]).not.toContain(WORKER);
    } finally {
      warn.mockRestore();
    }
  });

  it.each(["42703", "57014", "40P01", "08006"])(
    "any other SQLSTATE (%s) throws, after ONE attempt (no fallback)",
    async (code) => {
      const { db, executed } = missingTableDb(code);
      const repo = new CandidateSearchRepository(db, { SEARCH_EXIT_ENABLED: true });
      await expect(repo.searchPool(query())).rejects.toMatchObject({ cause: { code } });
      await expect(repo.listPoolCities()).rejects.toMatchObject({ cause: { code } });
      expect(executed).toHaveLength(2);
    },
  );

  it("a 42P01 with the switch OFF is not this table's: it throws, with no retry", async () => {
    const { db, executed } = missingTableDb("42P01", "42P01");
    const repo = new CandidateSearchRepository(db, { SEARCH_EXIT_ENABLED: false });
    await expect(repo.searchPool(query())).rejects.toMatchObject({ cause: { code: "42P01" } });
    expect(executed).toHaveLength(1);
  });

  it("a 42P01 the switch-off statement ALSO raises (another table is missing) throws", async () => {
    const { db, executed } = missingTableDb("42P01", "42P01");
    const repo = new CandidateSearchRepository(db, { SEARCH_EXIT_ENABLED: true });
    await expect(repo.listPoolCities()).rejects.toMatchObject({ cause: { code: "42P01" } });
    expect(executed).toHaveLength(2);
    expect(executed[1]!.sql).not.toContain("worker_search_exits");
  });
});

/** Today's three statements (the search with a tenant, the facet, the card read), switch off. */
async function runAllOff() {
  const { db, executed } = recordingDb();
  const repo = new CandidateSearchRepository(db);
  await repo.searchPool(query({ tenant: TENANT }));
  await repo.listPoolCities();
  await repo.findCardRow(WORKER);
  return executed;
}
