import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { SkillsRepository } from "./skills.repository";

/**
 * DB-free unit of the raw SQL behind the generalized-profiling RAG retrieval.
 *
 * `nearestDomains` is the whole first stage of the match: it decides which occupations
 * the model is even allowed to choose between, and five independent decisions live ONLY
 * in that one statement —
 *
 *   - the ANN stage is a bare `ORDER BY <=> ... LIMIT n`, the ONLY shape an HNSW index can
 *     serve. The previous form led its ORDER BY with the dedupe key (which `DISTINCT ON`
 *     requires) and carried no SQL LIMIT, so it could never use the index it was built
 *     for: EXPLAIN showed a Seq Scan + full sort of all 8,695 aliases on every turn;
 *   - `WHERE a.is_searchable`, which the PARTIAL HNSW index needs in the query before
 *     Postgres will use it — dropping it returns the SAME ROWS via a sequential scan, a
 *     regression with no symptom other than latency;
 *   - `DISTINCT ON (job_domain_id)`, so a domain with forty aliases contributes its best
 *     one instead of filling the whole shortlist with itself and crowding out the
 *     alternatives;
 *   - `d.selectable = true` and `d.status = 'active'`, re-checked against the source of
 *     truth even though `is_searchable` implies both — that flag is a materialized
 *     projection and goes stale between `db:normalize:aliases` runs;
 *   - the SQL `LIMIT k`, which now bounds the result (the JS `.sort().slice()` is gone —
 *     the ORDER BY on distance does that work in the database).
 *
 * The ai-service cannot compensate for any of them: it only re-checks the model's pick
 * against the shortlist it was handed, so anything wrongly IN that shortlist is a
 * legitimate answer as far as it can tell.
 */
function makeCapturingDb(rows: unknown[] = []) {
  const captured: { sql?: unknown; statements: unknown[] } = { statements: [] };
  const exec = vi.fn((statement: unknown) => {
    captured.statements.push(statement);
    // The last statement of the transaction is the retrieval query; `SET LOCAL` precedes it.
    captured.sql = statement;
    return Promise.resolve(rows);
  });
  const db = {
    execute: exec,
    // `nearestDomains` runs inside a transaction so `SET LOCAL hnsw.ef_search` applies.
    transaction: vi.fn((fn: (tx: unknown) => unknown) => Promise.resolve(fn({ execute: exec }))),
  };
  return { db, captured };
}

const render = (statement: unknown) => new PgDialect().sqlToQuery(statement as never);

/**
 * The rendered statement, with `--` comments REMOVED and whitespace collapsed.
 *
 * Stripping the comments is not cosmetic. These statements are heavily commented, and
 * collapsing whitespace first would fold that prose into the asserted string — at which
 * point `toContain("a.is_searchable")` passes on a comment that merely mentions
 * `is_searchable` while the actual predicate is gone. Every structural assertion below
 * would become vacuous in exactly the case it exists to catch.
 */
function sqlText(statement: unknown): string {
  return render(statement)
    .sql.split("\n")
    .map((line) => {
      const comment = line.indexOf("--");
      return comment === -1 ? line : line.slice(0, comment);
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

const VECTOR = Array.from({ length: 768 }, (_, i) => i / 768);

describe("SkillsRepository.nearestDomains — the retrieval SQL", () => {
  it("stages the ANN as a bare ORDER BY <=> ... LIMIT, the only shape HNSW serves", async () => {
    const { db, captured } = makeCapturingDb();
    await new SkillsRepository(db as never).nearestDomains(VECTOR, 10);

    const sql = sqlText(captured.sql);
    const ann = sql.slice(sql.indexOf("with ann as"), sql.indexOf(", best as"));

    // Inside the ANN CTE the distance must be the FIRST thing ordered on. Anything ahead
    // of it (as `DISTINCT ON` used to force) makes the index unusable.
    const annOrderBy = ann.slice(ann.indexOf("order by"));
    expect(annOrderBy).toContain("<=>");
    expect(annOrderBy.indexOf("<=>")).toBeLessThan(
      annOrderBy.indexOf("job_domain_id") === -1 ? Infinity : annOrderBy.indexOf("job_domain_id"),
    );
    // And it must be bounded, or HNSW has nothing to stop at.
    expect(ann).toContain("limit");
  });

  it("carries `is_searchable`, without which the PARTIAL index is silently unusable", async () => {
    // This is the assertion with the least obvious failure mode in the file. Postgres only
    // uses a partial index when the query repeats its predicate; drop this WHERE and the
    // query still returns the correct rows, just via a full scan. Nothing else catches it.
    const { db, captured } = makeCapturingDb();
    await new SkillsRepository(db as never).nearestDomains(VECTOR, 10);

    const sql = sqlText(captured.sql);
    expect(sql).toContain("a.is_searchable");
  });

  it("widens hnsw.ef_search inside a transaction, so it cannot leak across the pool", async () => {
    const { db, captured } = makeCapturingDb();
    await new SkillsRepository(db as never).nearestDomains(VECTOR, 10);

    expect(db.transaction).toHaveBeenCalledTimes(1);
    const setLocal = sqlText(captured.statements[0]);
    // `SET LOCAL`, never a bare `SET`: this connection is pooled and the next borrower
    // must not inherit a wider search.
    expect(setLocal).toContain("set local hnsw.ef_search");

    // The VALUE, not just the statement. ef_search must be >= the ANN LIMIT or pgvector
    // cannot return that many candidates, and it must stay inside the measured envelope
    // (800 loses the index at EVERY limit, including 50). Asserting only the statement let
    // a mutation to ef_search = 1 pass — the setting is what decides whether the index is
    // usable at all, so pin the range.
    const ef = Number(/hnsw\.ef_search = ([0-9]+)/.exec(setLocal)?.[1]);
    expect(Number.isFinite(ef)).toBe(true);
    expect(ef).toBeGreaterThanOrEqual(100); // >= ANN_OVERFETCH_MAX
    expect(ef).toBeLessThanOrEqual(400); // 800 measured to disable the index entirely
  });

  it("dedupes to one row per domain, with the distance choosing which alias survives", async () => {
    const { db, captured } = makeCapturingDb();
    await new SkillsRepository(db as never).nearestDomains(VECTOR, 10);

    const sql = sqlText(captured.sql);
    expect(sql).toContain("distinct on (job_domain_id)");
    // Within the dedupe CTE the key still has to lead — Postgres requires it, and it is
    // what makes "best alias per domain" true rather than "arbitrary alias per domain".
    const best = sql.slice(sql.indexOf(", best as"), sql.indexOf("select b.job_domain_id"));
    const bestOrderBy = best.slice(best.indexOf("order by"));
    expect(bestOrderBy.indexOf("job_domain_id")).toBeLessThan(bestOrderBy.indexOf("dist"));
  });

  it("re-checks selectable + active against the catalogue, not just the cached flag", async () => {
    const { db, captured } = makeCapturingDb();
    await new SkillsRepository(db as never).nearestDomains(VECTOR, 10);

    const sql = sqlText(captured.sql);
    // `is_searchable` already implies both, but it is a materialized projection refreshed
    // by `db:normalize:aliases`. Between runs it can be stale, and a stale flag must never
    // be able to put a worker in a deprecated domain.
    expect(sql).toContain("selectable = true");
    expect(sql).toContain("status = 'active'");
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

  it("bounds the result with a SQL LIMIT k, and overfetches within the measured envelope", async () => {
    const { db, captured } = makeCapturingDb();
    await new SkillsRepository(db as never).nearestDomains(VECTOR, 8);

    const { params } = render(captured.sql);
    // k reaches SQL rather than a JS `.slice` — the old form had NO SQL limit at all.
    expect(params).toContain(8);
    // Overfetch = clamp(k*8, 50, 100). 100 is the largest LIMIT measured to still use the
    // index; above it the planner switches to a sequential scan and returns the same rows
    // more slowly. A change here MUST be re-measured, not reasoned about.
    expect(params).toContain(64);
  });

  it("clamps the overfetch at both ends", async () => {
    const small = makeCapturingDb();
    await new SkillsRepository(small.db as never).nearestDomains(VECTOR, 1);
    expect(render(small.captured.sql).params).toContain(50);

    const large = makeCapturingDb();
    await new SkillsRepository(large.db as never).nearestDomains(VECTOR, 50);
    expect(render(large.captured.sql).params).toContain(100);
  });

  it("ranks the final result by DISTANCE, not by the dedupe key", async () => {
    // THE most important property in the statement, and it was untested: deleting the outer
    // `ORDER BY b.dist` left every assertion green while the shortlist came back in
    // job_domain_id order — so `LIMIT k` would keep the WRONG k domains, silently, forever.
    // The dedupe CTE has its own mandatory `ORDER BY job_domain_id, dist`, so it is not
    // enough that an ORDER BY exists somewhere; the FINAL one must lead with the distance.
    const { db, captured } = makeCapturingDb();
    await new SkillsRepository(db as never).nearestDomains(VECTOR, 10);

    const sql = sqlText(captured.sql);
    const final = sql.slice(sql.indexOf("select b.job_domain_id"));
    const orderBy = final.slice(final.indexOf("order by"));
    expect(orderBy, "the final SELECT has no ORDER BY").toContain("order by");
    expect(orderBy.indexOf("dist")).toBeGreaterThanOrEqual(0);
    // ...and nothing may be ranked ahead of the distance.
    expect(orderBy.indexOf("dist")).toBeLessThan(
      orderBy.indexOf("job_domain_id") === -1 ? Infinity : orderBy.indexOf("job_domain_id"),
    );
  });

  it("returns SIMILARITY, not the raw cosine distance", async () => {
    // pgvector's `<=>` is cosine DISTANCE (lower is better); every consumer of this
    // shortlist compares against a similarity FLOOR (higher is better). Shipping the raw
    // distance inverts every one of those comparisons — and mutation-testing showed all
    // twelve tests stayed green when `1 - b.dist` became `b.dist`, so the conversion needs
    // its own assertion rather than being implied by the numeric-score check below.
    const { db, captured } = makeCapturingDb();
    await new SkillsRepository(db as never).nearestDomains(VECTOR, 10);

    expect(sqlText(captured.sql)).toContain("1 - b.dist as score");
  });

  it("returns rows in the order SQL produced, with numeric scores", async () => {
    // The ORDER BY on distance now happens in the database, so this must NOT re-sort —
    // a JS re-sort would silently mask a broken SQL ordering.
    const { db } = makeCapturingDb([
      { job_domain_id: "isco_b", label: "B", score: "0.95" },
      { job_domain_id: "isco_c", label: "C", score: "0.72" },
    ]);
    const out = await new SkillsRepository(db as never).nearestDomains(VECTOR, 2);

    expect(out.map((c) => c.job_domain_id)).toEqual(["isco_b", "isco_c"]);
    // Postgres returns numerics as strings over the wire; a string score would break the
    // ai-service's floor comparison outright.
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

/**
 * PHASE 1.5 CANONICALIZER CUTOVER — the two alias-search scopes.
 *
 * Same DB-free discipline as the block above, and for a sharper reason: migration 0076
 * made `skill_alias.domain_id` NULLABLE legacy metadata, so the shipped
 * `WHERE domain_id = $1` pre-filter is now BLIND to every skill the canonical taxonomy
 * bootstrap mints. Nothing errors when that happens — the query returns fewer rows, the
 * floor gate sees no candidate, and the phrase lands in the growth queue as UNRESOLVED.
 * A silent recall hole, indistinguishable from a genuinely unknown phrase.
 *
 * So the predicates ARE the behaviour, and each one below is asserted on its own:
 *
 *   - the canonical statement joins `job_domain_skill` and constrains NOTHING on
 *     `skill_alias.domain_id` — that absence is what makes a NULL-legacy-domain skill
 *     reachable, and it is the entire point of the cutover;
 *   - the join is INNER, so an alias with no taxonomy edge is not a candidate;
 *   - `jds.status = 'active'`, so a deprecated/provisional edge is not a candidate;
 *   - the domain travels as a BOUND PARAMETER, so scoping to B cannot return A's skills;
 *   - the legacy statement is pinned CHARACTER FOR CHARACTER, because "unchanged" is the
 *     backward-compatibility promise and a reformat is the easiest way to break the
 *     `skill_alias_domain_id_idx` pre-filter without noticing.
 */
describe("SkillsRepository.nearestAliases — legacy vs canonical scope", () => {
  const LEGACY = { kind: "legacy", domainId: "cnc-machining" } as const;
  const CANONICAL = { kind: "canonical", jobDomainId: "jd_nco_7223_0100" } as const;

  it("CANONICAL: resolves candidates through job_domain_skill, not skill_alias.domain_id", async () => {
    const { db, captured } = makeCapturingDb();
    await new SkillsRepository(db as never).nearestAliases(CANONICAL, VECTOR, 5);

    const sql = sqlText(captured.sql);
    expect(sql).toContain("from skill_alias sa");
    expect(sql).toContain("join job_domain_skill jds on jds.skill_id = sa.skill_id");
    expect(sql).toContain("where jds.job_domain_id = $2");
  });

  it("CANONICAL: places NO predicate on skill_alias.domain_id — the NULL-legacy-domain fix", async () => {
    // THE assertion this whole phase exists for. A canonical skill has
    // `skill_alias.domain_id IS NULL`, so ANY surviving `sa.domain_id = ...` /
    // `sa.domain_id IS NOT NULL` filter would exclude exactly the rows the join was added
    // to reach — and would do it silently, since a filtered-out candidate is
    // indistinguishable from a phrase the vocabulary genuinely does not know.
    const { db, captured } = makeCapturingDb();
    await new SkillsRepository(db as never).nearestAliases(CANONICAL, VECTOR, 5);

    const sql = sqlText(captured.sql);
    expect(sql).not.toContain("sa.domain_id");
    // ...and the only `domain_id` mentioned anywhere is the CANONICAL one on the join
    // table. `jds.job_domain_id` is a different column in a different id space.
    expect(sql.replace(/jds\.job_domain_id/g, "")).not.toContain("domain_id");
  });

  it("CANONICAL: an alias with no job_domain_skill row is not a candidate (INNER join)", async () => {
    // A LEFT JOIN would readmit every alias in the table with a NULL `jds` side, which —
    // combined with the `status` predicate below being NULL-false — would look correct in
    // most tests while quietly widening the search to the entire vocabulary on any planner
    // rewrite. Pin the join kind.
    const { db, captured } = makeCapturingDb();
    await new SkillsRepository(db as never).nearestAliases(CANONICAL, VECTOR, 5);

    const sql = sqlText(captured.sql);
    expect(sql).not.toContain("left join");
    expect(sql).not.toContain("full join");
    expect(sql).toContain("join job_domain_skill");
  });

  it("CANONICAL: only ACTIVE taxonomy edges count — deprecated/provisional are excluded", async () => {
    // `job_domain_skill.status` is one of active|provisional|deprecated. Dropping this
    // predicate would put a retired skill back on a worker's profile with nothing at the
    // read end able to tell it from a live one.
    const { db, captured } = makeCapturingDb();
    await new SkillsRepository(db as never).nearestAliases(CANONICAL, VECTOR, 5);

    expect(sqlText(captured.sql)).toContain("jds.status = 'active'");
  });

  it("CANONICAL: keeps the bare `ORDER BY <=> ... LIMIT` shape HNSW serves", async () => {
    // The join must not push anything ahead of the distance in the ORDER BY. If it did,
    // `skill_alias_embedding_hnsw` becomes unusable and the query degrades to a sequential
    // scan returning the SAME rows — the exact no-symptom regression `nearestDomains`
    // documents at length.
    const { db, captured } = makeCapturingDb();
    await new SkillsRepository(db as never).nearestAliases(CANONICAL, VECTOR, 5);

    const sql = sqlText(captured.sql);
    const orderBy = sql.slice(sql.indexOf("order by"));
    expect(orderBy).toContain("sa.embedding <=>");
    expect(orderBy).toContain("limit");
    expect(orderBy.indexOf("<=>")).toBeLessThan(orderBy.indexOf("limit"));
    // Un-embedded aliases can never match — a NULL embedding has no distance.
    expect(sql).toContain("sa.embedding is not null");
  });

  it("CANONICAL: the domain is a BOUND parameter — scoping to B cannot return A's skills", async () => {
    const a = makeCapturingDb();
    await new SkillsRepository(a.db as never).nearestAliases(
      { kind: "canonical", jobDomainId: "jd_domain_a" },
      VECTOR,
      5,
    );
    const b = makeCapturingDb();
    await new SkillsRepository(b.db as never).nearestAliases(
      { kind: "canonical", jobDomainId: "jd_domain_b" },
      VECTOR,
      5,
    );

    // Domain isolation IS this parameter. A skill reachable only from domain A is not in
    // the result set of the B statement, because the equality never matches its edge row.
    expect(render(b.captured.sql).params).toContain("jd_domain_b");
    expect(render(b.captured.sql).params).not.toContain("jd_domain_a");
    expect(render(a.captured.sql).params).toContain("jd_domain_a");
    expect(render(a.captured.sql).params).not.toContain("jd_domain_b");
    // Both render the SAME statement text — one plan, one prepared statement.
    expect(sqlText(a.captured.sql)).toBe(sqlText(b.captured.sql));
  });

  it("CANONICAL: binds the vector as a pgvector literal and returns numeric similarity", async () => {
    const { db, captured } = makeCapturingDb([
      { skill_id: "skill_cnc_turning", score: "0.91" },
      { skill_id: "skill_fanuc", score: "0.77" },
    ]);
    const out = await new SkillsRepository(db as never).nearestAliases(CANONICAL, VECTOR, 2);

    const { sql, params } = render(captured.sql);
    expect(sql).toContain("::vector");
    expect(params).toContain(JSON.stringify(VECTOR));
    expect(params).toContain(2); // k reaches SQL, never a JS slice
    // `1 - (<=>)` is similarity, not distance — every consumer compares against a FLOOR.
    expect(sqlText(captured.sql)).toContain("1 - (sa.embedding <=>");
    // Order is SQL's; scores arrive as strings over the wire and must be numbers here.
    expect(out).toEqual([
      { skill_id: "skill_cnc_turning", score: 0.91 },
      { skill_id: "skill_fanuc", score: 0.77 },
    ]);
  });

  it("LEGACY: runs the shipped statement CHARACTER FOR CHARACTER (backward-compat pin)", async () => {
    // Not a structural assertion — a literal one. Every pre-cutover caller sends only
    // `domain_id`, and "byte-identical behaviour" is the promise made to them. A reformat
    // that dropped or renamed the `domain_id` predicate would lose
    // `skill_alias_domain_id_idx` and silently widen the search across trades.
    const { db, captured } = makeCapturingDb();
    await new SkillsRepository(db as never).nearestAliases(LEGACY, VECTOR, 5);

    const { sql, params } = render(captured.sql);
    expect(sql.split("\n").map((l) => l.trim()).filter(Boolean)).toEqual([
      "SELECT skill_id, 1 - (embedding <=> $1::vector) AS score",
      "FROM skill_alias",
      "WHERE domain_id = $2 AND embedding IS NOT NULL",
      "ORDER BY embedding <=> $3::vector",
      "LIMIT $4",
    ]);
    // The vector is bound TWICE ($1 in the projection, $3 in the ORDER BY) — drizzle does
    // not dedupe identical parameters. Pinned as-is: this is the shipped statement.
    expect(params).toEqual([JSON.stringify(VECTOR), "cnc-machining", JSON.stringify(VECTOR), 5]);
    // The legacy path must NOT have acquired the canonical join.
    expect(sql).not.toContain("job_domain_skill");
  });

  it("LEGACY: maps rows exactly as it always has (string score -> number)", async () => {
    const { db } = makeCapturingDb([{ skill_id: "skill_vmc_operator", score: "0.93" }]);
    const out = await new SkillsRepository(db as never).nearestAliases(LEGACY, VECTOR, 5);
    expect(out).toEqual([{ skill_id: "skill_vmc_operator", score: 0.93 }]);
  });

  it("neither scope runs inside a transaction — no ef_search widening, no pool leak", async () => {
    // `nearestDomains` needs one for `SET LOCAL`; these two are single statements. Asserted
    // so a future copy-paste of the domain query's transaction wrapper is a visible change
    // rather than an accidental one.
    const legacy = makeCapturingDb();
    await new SkillsRepository(legacy.db as never).nearestAliases(LEGACY, VECTOR, 5);
    expect(legacy.db.transaction).not.toHaveBeenCalled();

    const canonical = makeCapturingDb();
    await new SkillsRepository(canonical.db as never).nearestAliases(CANONICAL, VECTOR, 5);
    expect(canonical.db.transaction).not.toHaveBeenCalled();
  });
});

describe("SkillsRepository.isSelectableDomain — the last hallucination wall", () => {
  it("requires the domain to be both selectable and active", async () => {
    const { db, captured } = makeCapturingDb([{ "?column?": 1 }]);
    const ok = await new SkillsRepository(db as never).isSelectableDomain("isco_7223");

    expect(ok).toBe(true);
    const sql = sqlText(captured.sql);
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
