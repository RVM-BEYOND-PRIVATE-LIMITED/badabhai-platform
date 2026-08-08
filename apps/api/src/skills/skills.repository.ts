import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Database, UnresolvedPhraseScope } from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import type { AliasCandidate, DomainCandidate } from "./skills.dto";

/**
 * ANN overfetch bounds and the HNSW search width for `nearestDomains`.
 *
 * These are not taste. Postgres costs an HNSW scan against a sequential scan, and past a
 * threshold it picks the scan — returning identical rows, only slower, with no error.
 * Measured against the seeded catalogue (4,660 searchable aliases, partial index, 18 MB):
 *
 *     LIMIT  50 -> Index Scan  4.1 ms       LIMIT 200 -> Seq Scan  13.3 ms
 *     LIMIT 100 -> Index Scan  4.1 ms       LIMIT 250 -> Seq Scan  13.1 ms
 *     LIMIT 150 -> Seq Scan   13.5 ms       LIMIT 400 -> Seq Scan  12.7 ms
 *
 * and separately, `hnsw.ef_search = 800` loses the index at EVERY limit including 50 — so
 * widening the search for recall is not free.
 *
 * The threshold MOVES with the corpus: a bigger table makes the sequential alternative
 * dearer and lets the index win at higher limits. So these are constants to re-measure
 * after the Phase 2 alias backfill, not constants to trust — which is why
 * `skills.repository.e2e` asserts the EXPLAIN plan rather than the numbers.
 *
 * ── THE OVERFETCH'S REAL BOUND, AND WHY IT IS NOT YET CALIBRATED ──
 *
 * Dedupe must still yield k DOMAINS. On average that is easy — 1.33 searchable aliases per
 * domain, so 64 candidates gave 62 distinct domains when measured. But that measurement
 * used MOCK embeddings, which are random and therefore do not cluster; real embeddings put
 * a domain's aliases ("Welder, Gas" / "Gas Welder" / "gas welding") close together, so one
 * domain can occupy many of the top-N slots.
 *
 * The worst case is not hypothetical and is worth stating: the alias-per-domain
 * distribution is p50=1, p99=5, **max=51**. If the nearest cluster happens to be that
 * 51-alias domain, 64 candidates can collapse to as few as **2 distinct domains** — below
 * k=8.
 *
 * This is NOT tuned here on purpose. Zero aliases are embedded today, so L3 returns nothing
 * either way, and there is no real distance distribution to calibrate against. Phase 9 owns
 * threshold calibration against production utterances; the sprint plan says so explicitly.
 * When embeddings land in Phase 2, re-measure BOTH the index cutover above AND the dedupe
 * yield, and if the yield is short, the fix is a second widened ANN pass rather than a
 * bigger single LIMIT — a bigger LIMIT loses the index, which is what this whole rewrite
 * existed to win back.
 */
const ANN_OVERFETCH_MIN = 50;
const ANN_OVERFETCH_MAX = 100;
const HNSW_EF_SEARCH = 200;

/**
 * Data access for the skill-canonicalization vocabulary (ADR-0030 / FORK-B-1 seam A).
 * Runs on the api's OWNER connection — `skill_alias`/`unresolved_phrase` are RLS-locked
 * and REVOKE'd from the Data-API roles, which is exactly why this lives here and not in
 * the (DB-free) ai-service.
 */
@Injectable()
export class SkillsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Domain-scoped nearest-alias search over the HNSW cosine index.
   * `1 - (embedding <=> $q)` = cosine similarity (pgvector `<=>` is cosine DISTANCE).
   * Domain isolation is the WHERE clause; NULL (un-embedded) aliases never match.
   * Returns (skill_id, score) DESC — ids only ever come from this closed set (SG-3).
   */
  async nearestAliases(
    domainId: string,
    vector: number[],
    k: number,
  ): Promise<AliasCandidate[]> {
    // pgvector accepts the '[1,2,3]' literal; JSON.stringify produces exactly that.
    const vec = JSON.stringify(vector);
    const rows = await this.db.execute(sql`
      SELECT skill_id, 1 - (embedding <=> ${vec}::vector) AS score
      FROM skill_alias
      WHERE domain_id = ${domainId} AND embedding IS NOT NULL
      ORDER BY embedding <=> ${vec}::vector
      LIMIT ${k}
    `);
    return (rows as unknown as Array<{ skill_id: string; score: string | number }>).map(
      (r) => ({ skill_id: r.skill_id, score: Number(r.score) }),
    );
  }

  /**
   * Nearest-job-domain search over the `job_domain_alias` HNSW cosine index — the
   * retrieval half of the generalized profiling RAG pass (retrieval layer L3).
   *
   * ALIASES ARE THE SEARCH SURFACE, DOMAINS ARE THE ANSWER. A worker says "kharad",
   * "lathe operator" or "turner"; the catalog calls it one thing. So the vectors live on
   * the aliases (many per domain) and the result is DEDUPED to the best-scoring alias
   * per domain — otherwise a domain with forty aliases would fill the whole shortlist
   * with itself and crowd out the alternatives the model needs to choose between.
   *
   * ── WHY THIS IS AN ANN-FIRST CTE AND NOT ONE `DISTINCT ON` (migration 0067) ──
   *
   * The previous form led its `ORDER BY` with `a.job_domain_id` because `DISTINCT ON`
   * requires that. HNSW can only accelerate `ORDER BY <distance> LIMIT n`, so leading with
   * anything else makes the index unusable — and there was no SQL `LIMIT` at all, because
   * `DISTINCT ON` had to see every alias before the JS side could `.sort().slice(k)`.
   *
   * Measured on the seeded catalogue, that cost a full scan and a full sort of the entire
   * alias table on every profiling turn:
   *
   *     Unique (rows=3885) -> Sort (rows=8695, quicksort 1167kB)
   *                        -> Seq Scan on job_domain_alias (rows=8695)     44.8 ms
   *
   * Staging the ANN separately lets it be a bare `ORDER BY <=> LIMIT`, which is the one
   * shape the index serves; the dedupe then runs over the small candidate set instead of
   * the table.
   *
   * ── `is_searchable` IS LOAD-BEARING, NOT A CONVENIENCE FILTER ──
   *
   * The HNSW index is PARTIAL (`WHERE is_searchable`). Postgres only uses a partial index
   * when the query carries a matching predicate, so dropping that `WHERE` silently returns
   * the SAME ROWS via a sequential scan — a regression with no visible symptom except
   * latency. `skills.repository.test.ts` pins it for that reason.
   *
   * The outer `selectable`/`status` filter is kept even though `is_searchable` already
   * implies both. `is_searchable` is a MATERIALIZED projection refreshed by
   * `pnpm db:normalize:aliases`; if a domain is deprecated and that runner has not re-run,
   * the flag is stale. Re-reading the source of truth costs a PK probe on ≤100 candidate
   * rows and is the same discipline `isSelectableDomain` applies before anything is
   * written to `worker_profiles`. A wrong domain is worse than no domain.
   */
  async nearestDomains(vector: number[], k: number): Promise<DomainCandidate[]> {
    // pgvector accepts the '[1,2,3]' literal; JSON.stringify produces exactly that.
    const vec = JSON.stringify(vector);
    const overfetch = Math.min(Math.max(k * 8, ANN_OVERFETCH_MIN), ANN_OVERFETCH_MAX);

    const rows = await this.db.transaction(async (tx) => {
      // `SET LOCAL` needs a transaction — outside one it warns and does nothing, and a
      // plain `SET` would leak the setting into the next user of this pooled connection.
      // Not a bound parameter: `SET` does not accept them. The value is a module constant,
      // never user input.
      await tx.execute(sql`SET LOCAL hnsw.ef_search = ${sql.raw(String(HNSW_EF_SEARCH))}`);
      return tx.execute(sql`
        WITH ann AS (
          -- The ONLY shape HNSW accelerates: order by the distance, bounded by a LIMIT.
          SELECT a.job_domain_id, a.embedding <=> ${vec}::vector AS dist
          FROM job_domain_alias a
          WHERE a.is_searchable
          ORDER BY a.embedding <=> ${vec}::vector
          LIMIT ${overfetch}
        ), best AS (
          -- Dedupe to the best alias per domain, over the candidate set only.
          SELECT DISTINCT ON (job_domain_id) job_domain_id, dist
          FROM ann
          ORDER BY job_domain_id, dist
        )
        SELECT b.job_domain_id, d.label_en AS label, 1 - b.dist AS score
        FROM best b
        JOIN job_domain d ON d.job_domain_id = b.job_domain_id
        WHERE d.selectable = true AND d.status = 'active'
        ORDER BY b.dist
        LIMIT ${k}
      `);
    });

    return (
      rows as unknown as Array<{ job_domain_id: string; label: string; score: string | number }>
    ).map((r) => ({ job_domain_id: r.job_domain_id, label: r.label, score: Number(r.score) }));
  }

  /**
   * Does this domain exist, and may a worker be assigned to it?
   *
   * The LAST line of the hallucination guard. The ai-service already re-checks the
   * model's pick against the shortlist it was given, but that shortlist travelled over
   * HTTP, so this re-reads the closed set from the source of truth before anything is
   * written to `worker_profiles`. Ids are cheap to verify and expensive to be wrong
   * about — a fabricated one would become a foreign-key violation at best and a
   * mis-classified worker at worst.
   */
  async isSelectableDomain(jobDomainId: string): Promise<boolean> {
    const rows = await this.db.execute(sql`
      SELECT 1 FROM job_domain
      WHERE job_domain_id = ${jobDomainId} AND selectable = true AND status = 'active'
      LIMIT 1
    `);
    return (rows as unknown as unknown[]).length > 0;
  }

  /**
   * Upsert one below-floor miss into the growth queue: new row, or on the
   * (scope, phrase, domain_id, lang) unique key increment `count` + bump `last_seen`
   * (the migration's NULLS NOT DISTINCT makes NULL domain/lang dedupe too).
   * `phrase` is ALREADY pseudonymized (SG-1). Returns the row id + post-upsert count.
   *
   * `scope` DEFAULTS TO 'skill', which is what makes this widening backward compatible:
   * every existing caller keeps its exact previous behaviour without being edited, and
   * every row written before Phase 8 was a skill miss. Occupation retrieval passes
   * 'occupation' explicitly.
   *
   * THE TWO SCOPES MUST NOT SHARE A ROW. "fitter" is legitimately an unresolved skill AND
   * an unresolved occupation, and the follow-up work differs — one becomes a `skill_alias`,
   * the other a `job_domain_alias`. Sharing a row would let resolving one silently close
   * the other, which is why `scope` leads the unique index rather than sitting beside it.
   */
  async recordUnresolved(
    phrase: string,
    // NULLABLE for the occupation scope: an occupation miss is not scoped to a skill
    // domain, and inventing a sentinel string would make one queue row per fake domain.
    // The index's NULLS NOT DISTINCT is what lets NULL still dedupe to a single row.
    domainId: string | null,
    lang: string,
    scope: UnresolvedPhraseScope = "skill",
  ): Promise<{ id: string; count: number }> {
    const rows = await this.db.execute(sql`
      INSERT INTO unresolved_phrase (scope, phrase, domain_id, lang)
      VALUES (${scope}, ${phrase}, ${domainId}, ${lang})
      ON CONFLICT (scope, phrase, domain_id, lang)
      DO UPDATE SET count = unresolved_phrase.count + 1, last_seen = now()
      RETURNING id, count
    `);
    const row = (rows as unknown as Array<{ id: string; count: number }>)[0];
    if (!row) throw new Error("unresolved_phrase upsert returned no row");
    return { id: row.id, count: Number(row.count) };
  }
}
