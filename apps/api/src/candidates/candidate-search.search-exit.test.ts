import { describe, expect, it } from "vitest";
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
