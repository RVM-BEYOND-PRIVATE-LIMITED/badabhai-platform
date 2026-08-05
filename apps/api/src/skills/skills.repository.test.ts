import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { SkillsRepository } from "./skills.repository";

/**
 * DB-free unit of the raw SQL behind the generalized-profiling RAG retrieval.
 *
 * `nearestDomains` is the whole first stage of the match: it decides which occupations
 * the model is even allowed to choose between, and four independent decisions live ONLY
 * in that one statement —
 *
 *   - `DISTINCT ON (a.job_domain_id)` with the dedupe key LEADING the ORDER BY, so a
 *     domain with forty aliases contributes its best one instead of filling the whole
 *     shortlist with itself and crowding out the alternatives;
 *   - `d.selectable = true`, so an ISCO organising node ("Craft and Related Trades
 *     Workers" — nobody's actual trade) can never be matched to a worker;
 *   - `d.status = 'active'`, so a deprecated row stays resolvable by id but is never
 *     re-matched;
 *   - the JS-side re-sort + `.slice(0, k)`, which is the ONLY thing bounding the result
 *     (there is deliberately no SQL LIMIT — DISTINCT ON must see every alias first).
 *
 * The ai-service cannot compensate for any of them: it only re-checks the model's pick
 * against the shortlist it was handed, so anything wrongly IN that shortlist is a
 * legitimate answer as far as it can tell.
 */
function makeCapturingDb(rows: unknown[] = []) {
  const captured: { sql?: unknown } = {};
  const db = {
    execute: vi.fn((statement: unknown) => {
      captured.sql = statement;
      return Promise.resolve(rows);
    }),
  };
  return { db, captured };
}

const render = (statement: unknown) => new PgDialect().sqlToQuery(statement as never);

const VECTOR = Array.from({ length: 768 }, (_, i) => i / 768);

describe("SkillsRepository.nearestDomains — the retrieval SQL", () => {
  it("dedupes to one row per domain, with the distance choosing which alias survives", async () => {
    const { db, captured } = makeCapturingDb();
    await new SkillsRepository(db as never).nearestDomains(VECTOR, 10);

    const sql = render(captured.sql).sql.replace(/\s+/g, " ").toLowerCase();
    expect(sql).toContain("distinct on (a.job_domain_id)");
    // The DISTINCT ON key must LEAD the ORDER BY — Postgres requires it, and it is what
    // makes "best alias per domain" true rather than "arbitrary alias per domain".
    const orderBy = sql.slice(sql.lastIndexOf("order by"));
    expect(orderBy.indexOf("a.job_domain_id")).toBeGreaterThanOrEqual(0);
    expect(orderBy.indexOf("a.job_domain_id")).toBeLessThan(orderBy.indexOf("<=>"));
  });

  it("searches ONLY selectable, active domains", async () => {
    const { db, captured } = makeCapturingDb();
    await new SkillsRepository(db as never).nearestDomains(VECTOR, 10);

    const sql = render(captured.sql).sql.replace(/\s+/g, " ").toLowerCase();
    expect(sql).toContain("selectable = true");
    expect(sql).toContain("status = 'active'");
    // Un-embedded aliases can never match — a NULL vector would otherwise sort first
    // under some operator classes.
    expect(sql).toContain("embedding is not null");
  });

  it("binds the query vector as a pgvector literal parameter, never inlined", async () => {
    const { db, captured } = makeCapturingDb();
    await new SkillsRepository(db as never).nearestDomains(VECTOR, 10);

    const { sql, params } = render(captured.sql);
    expect(sql).toContain("::vector");
    // The vector travels as a bound param — 768 floats inlined into the statement text
    // would defeat the plan cache and make the log line enormous.
    expect(params).toContain(JSON.stringify(VECTOR));
  });

  it("returns the k HIGHEST-scoring domains, in descending score order", async () => {
    // The SQL orders by DISTANCE within each domain; the cross-domain ranking is done
    // here, because DISTINCT ON forces its own ORDER BY. Without this re-sort the
    // shortlist would be in job_domain_id order, and `.slice` would keep the wrong ten.
    const { db } = makeCapturingDb([
      { job_domain_id: "isco_a", label: "A", score: "0.40" },
      { job_domain_id: "isco_b", label: "B", score: "0.95" },
      { job_domain_id: "isco_c", label: "C", score: "0.72" },
    ]);
    const out = await new SkillsRepository(db as never).nearestDomains(VECTOR, 2);

    expect(out.map((c) => c.job_domain_id)).toEqual(["isco_b", "isco_c"]);
    // Postgres returns numerics as strings over the wire; a string score would sort
    // lexicographically ("0.9" < "0.40" is false, but "0.40" < "0.95" is true only by
    // luck) and would break the ai-service's floor comparison outright.
    expect(out.every((c) => typeof c.score === "number")).toBe(true);
    expect(out[0]!.score).toBeCloseTo(0.95);
  });

  it("carries the human LABEL, because the model cannot choose between opaque ids", async () => {
    const { db } = makeCapturingDb([
      { job_domain_id: "isco_7223", label: "Metal Working Machine Tool Setter", score: "0.8" },
    ]);
    const out = await new SkillsRepository(db as never).nearestDomains(VECTOR, 5);
    expect(out[0]!.label).toBe("Metal Working Machine Tool Setter");
  });
});

describe("SkillsRepository.isSelectableDomain — the last hallucination wall", () => {
  it("requires the domain to be both selectable and active", async () => {
    const { db, captured } = makeCapturingDb([{ "?column?": 1 }]);
    const ok = await new SkillsRepository(db as never).isSelectableDomain("isco_7223");

    expect(ok).toBe(true);
    const sql = render(captured.sql).sql.replace(/\s+/g, " ").toLowerCase();
    expect(sql).toContain("selectable = true");
    expect(sql).toContain("status = 'active'");
    expect(render(captured.sql).params).toContain("isco_7223");
  });

  it("reports false for an id the catalog does not recognise", async () => {
    // `job_domain_id` carries a foreign key, so an unresolvable id would fail the
    // worker_profiles INSERT and take their whole extracted profile with it.
    const { db } = makeCapturingDb([]);
    expect(await new SkillsRepository(db as never).isSelectableDomain("invented")).toBe(false);
  });
});
