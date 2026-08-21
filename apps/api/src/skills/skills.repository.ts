import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Database, UnresolvedPhraseScope } from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import type { AliasCandidate, AliasSearchScope, DomainCandidate } from "./skills.dto";

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
   *
   * TWO SCOPES, ONE CONTRACT (Phase 1.5 cutover). The `scope` union is the whole safety
   * property: there is no third arm meaning "unscoped", so this method structurally
   * cannot be asked to search the entire vocabulary. A request with no domain is
   * rejected at the DTO boundary and never reaches here.
   */
  async nearestAliases(
    scope: AliasSearchScope,
    vector: number[],
    k: number,
  ): Promise<AliasCandidate[]> {
    // pgvector accepts the '[1,2,3]' literal; JSON.stringify produces exactly that.
    const vec = JSON.stringify(vector);
    const rows =
      scope.kind === "canonical"
        ? await this.canonicalAliasRows(scope.jobDomainId, vec, k)
        : await this.legacyAliasRows(scope.domainId, vec, k);
    return (rows as unknown as Array<{ skill_id: string; score: string | number }>).map(
      (r) => ({ skill_id: r.skill_id, score: Number(r.score) }),
    );
  }

  /**
   * LEGACY / FALLBACK PATH — the shipped `skill_alias.domain_id` pre-filter, byte for
   * byte the statement this repository has always run.
   *
   * Kept otherwise unchanged on purpose. It is what every pre-cutover caller still sends,
   * and the 11 hand-minted slugs remain the only domain the 131 already-embedded aliases
   * carry. It retires when the alias corpus is fully re-domained onto `job_domain_skill`,
   * not before — and until then a regression here is a silent recall loss, not an error.
   *
   * ── IT CARRIES THE SAME SKILL-STATUS FILTER, AND IT HAS TO (Phase 7 Gate A) ──
   *
   * `nearestAliases` dispatches on scope: a `jobDomainId` takes the canonical path, anything
   * else lands HERE. Filtering only the canonical query would therefore leave a second door
   * open — a caller with a legacy `domainId` scope would still reach provisional skills, and
   * the safety property would hold only for callers who happened to have migrated.
   *
   * That is not hypothetical on this data. 33 aliases belonging to PROVISIONAL skills carry
   * a legacy `domain_id`, so this statement can select them. They are unembedded today, so
   * `embedding IS NOT NULL` hides the problem — and hiding it is the danger, because the
   * very next step (embedding the remaining alias backlog) would make all 33 retrievable
   * through this path on the same day the canonical path started refusing them.
   *
   * The join is a PK lookup on `skill_pkey`; the `ORDER BY <distance> LIMIT` shape that the
   * HNSW index serves is untouched.
   */
  private legacyAliasRows(domainId: string, vec: string, k: number) {
    return this.db.execute(sql`
      SELECT sa.skill_id, 1 - (sa.embedding <=> ${vec}::vector) AS score
      FROM skill_alias sa
      JOIN skill s ON s.skill_id = sa.skill_id
      WHERE sa.domain_id = ${domainId}
        AND s.status = 'active'
        AND sa.embedding IS NOT NULL
      ORDER BY sa.embedding <=> ${vec}::vector
      LIMIT ${k}
    `);
  }

  /**
   * CANONICAL PATH — candidates resolved through `job_domain_skill`, the authoritative
   * domain <-> skill relationship as of migration 0076.
   *
   * WHY THIS EXISTS AT ALL. 0076 made `skill.domain_id` / `skill_alias.domain_id`
   * NULLABLE legacy metadata, so a skill minted by the canonical taxonomy bootstrap
   * carries no slug — and `WHERE domain_id = $1` cannot see it. The legacy query is not
   * wrong, it is BLIND to the new rows. The join is how they become reachable, and it is
   * deliberately NOT fixed by backfilling `skill.domain_id`: mapping the 11 slugs onto
   * the 4,071 `jd_*` rows is a re-domain, which SG-5 defines as deprecate-and-recreate.
   *
   * ── WHY THE JOIN IS SAFE FOR THE INDEX ──
   *
   * `skill_alias_embedding_hnsw` is NON-PARTIAL (schema/skill.ts states this explicitly:
   * 0076 left it untuned because a `WHERE is_searchable` predicate would have unindexed
   * all 131 live rows). A non-partial index needs NO predicate repeated in the query to
   * be usable, which is exactly why adding a join here does not cost the index the way
   * dropping `is_searchable` costs `nearestDomains` its partial one.
   *
   * The ANN stage still reads as the one shape HNSW serves — `ORDER BY <distance>` on a
   * bare column reference with a `LIMIT` — because nothing is ordered ahead of the
   * distance and the join contributes no sort key. The planner's expected shape is an
   * index scan on `skill_alias` feeding a nested loop that probes `job_domain_skill` on
   * its PRIMARY KEY `(job_domain_id, skill_id)`: both columns are bound (one from the
   * parameter, one from the outer row), so each probe is an exact PK lookup, not a scan.
   * `jds.status` is read from that same fetched row — no extra access.
   *
   * ── THE HONEST CAVEAT: THIS IS A POST-FILTER, SO RECALL IS NOT GUARANTEED ──
   *
   * The domain test is applied AFTER the vector order, not before it. HNSW walks
   * `ef_search` candidates; if very few of them belong to this `job_domain_id`, the
   * statement can legitimately return fewer than k rows even though qualifying aliases
   * exist further down the list. That is a RECALL bound, never a correctness bug — every
   * row returned is genuinely in the domain, and the caller's floor gate is unaffected.
   *
   * NOT TUNED HERE, on the same reasoning `ANN_OVERFETCH_*` above documents at length:
   * `job_domain_skill` is written by an offline bootstrap and the alias corpus is barely
   * embedded, so there is no real distance distribution to calibrate an overfetch or an
   * `ef_search` against. When Phase 2 lands the embeddings, MEASURE the shortfall before
   * reaching for a knob — and prefer widening `ef_search` inside a transaction (the
   * `nearestDomains` pattern) over inflating `LIMIT`, which is what loses the index.
   *
   * `status = 'active'` is not optional: a deprecated or merely provisional edge is not
   * a recommendation, and letting one through would put a retired skill on a worker's
   * profile with no way to tell it apart from a live one.
   *
   * ── TWO STATUSES, AND BOTH ARE LOAD-BEARING (Phase 7 Gate A) ──
   *
   * `jds.status` is the status of the EDGE — "this skill belongs to this domain". It says
   * nothing about whether the SKILL itself is fit to publish. Those are separate lifecycles
   * and the taxonomy bootstrap moves them independently: it writes edges as `active` while
   * minting the skills they point at as `provisional`, because the domain->skill mapping is
   * machine-derived but the skill is not a recommendation until a human promotes it.
   *
   * The measured consequence of filtering only the edge: on the Phase 3 corpus, all 238
   * edges are `active` and all 98 skills are `provisional`, so every one of those skills
   * was reachable through this query. The Phase 5/6 evaluation scored 100% Recall@1 against
   * them, which is the proof — not a hypothetical. The comment above already stated the
   * intent ("a merely provisional ... is not a recommendation"); only the edge half of it
   * was ever enforced.
   *
   * So the SKILL's own status is now required to be `active` too. The cost is real and
   * intended: until a human promotes them, provisional skills resolve to nothing here
   * rather than resolving to something unpublishable. An empty result is a state the
   * caller already handles (the floor gate produces one routinely); a provisional skill on
   * a worker's profile is not.
   *
   * ── WHAT THE PLANNER ACTUALLY DOES WITH THE EXTRA JOIN (measured, not assumed) ──
   *
   * `EXPLAIN ANALYZE` on the seeded corpus (197 embedded aliases, 146 skills):
   *
   *     Limit -> Sort (Sort Key: sa.embedding <=> $1)
   *           -> Nested Loop
   *                -> Hash Join  (Hash Cond: s.skill_id = jds.skill_id)
   *                     -> Seq Scan on skill s  (Filter: status = ...)
   *
   * So at this size it is a hash join over a sequential scan of `skill`, NOT the PK probe
   * that would be the natural guess — the same small-table effect that keeps the HNSW index
   * unused here (Phase 6 measured that separately and at 9,121 rows). Stated plainly because
   * an earlier draft of this comment asserted the PK-probe shape and the plan disagreed.
   *
   * The invariant that matters survives either way, and the plan above confirms it: the
   * join contributes NOTHING ahead of the distance, so the sort key is still the bare
   * `sa.embedding <=> $1` and the `ORDER BY <=> ... LIMIT` shape HNSW serves is intact. When
   * the corpus is large enough for the planner to prefer the index, `skill_pkey` is there to
   * make the probe cheap; that is an expectation, not a measurement, and is labelled as one.
   */
  private canonicalAliasRows(jobDomainId: string, vec: string, k: number) {
    return this.db.execute(sql`
      SELECT sa.skill_id, 1 - (sa.embedding <=> ${vec}::vector) AS score
      FROM skill_alias sa
      JOIN job_domain_skill jds ON jds.skill_id = sa.skill_id
      JOIN skill s ON s.skill_id = sa.skill_id
      WHERE jds.job_domain_id = ${jobDomainId}
        AND jds.status = 'active'
        AND s.status = 'active'
        AND sa.embedding IS NOT NULL
      ORDER BY sa.embedding <=> ${vec}::vector
      LIMIT ${k}
    `);
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
    // S3-C / D-6 — the Path A counterpart of `domainId`, TRAILING and DEFAULTED so every
    // existing call site keeps its exact previous behaviour without being edited. Mutually
    // exclusive with `domainId` (DB CHECK `unresolved_phrase_one_domain_chk`); the caller
    // is responsible for passing at most one, which `RecordUnresolvedDtoSchema`'s refine
    // already guarantees at the HTTP boundary.
    jobDomainId: string | null = null,
  ): Promise<{ id: string; count: number }> {
    // Belt-and-braces ahead of the DB CHECK: a 23514 surfaces as an opaque 500 several
    // layers from the mistake, whereas this names it at the call site. Cheap, and the
    // repository is the last place that can still see both arguments.
    if (domainId !== null && jobDomainId !== null) {
      throw new Error(
        "recordUnresolved: domainId and jobDomainId are mutually exclusive — a row must " +
          "record which ONE vocabulary the phrase failed to resolve in",
      );
    }
    // `job_domain_id` joined the conflict target in 0078 and MUST be listed here: the
    // ON CONFLICT target has to name the index's exact column set, and omitting it would
    // fail to match `unresolved_phrase_scope_uq` at all (42P10), not silently pick the old
    // one. Two canonical misses of the same phrase in different domains are now distinct
    // rows, which is the entire point of the widening.
    const rows = await this.db.execute(sql`
      INSERT INTO unresolved_phrase (scope, phrase, domain_id, job_domain_id, lang)
      VALUES (${scope}, ${phrase}, ${domainId}, ${jobDomainId}, ${lang})
      ON CONFLICT (scope, phrase, domain_id, job_domain_id, lang)
      DO UPDATE SET count = unresolved_phrase.count + 1, last_seen = now()
      RETURNING id, count
    `);
    const row = (rows as unknown as Array<{ id: string; count: number }>)[0];
    if (!row) throw new Error("unresolved_phrase upsert returned no row");
    return { id: row.id, count: Number(row.count) };
  }
}
