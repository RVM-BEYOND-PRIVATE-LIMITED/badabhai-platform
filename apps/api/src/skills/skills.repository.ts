import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Database } from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import type { AliasCandidate, DomainCandidate } from "./skills.dto";

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
   * retrieval half of the generalized profiling RAG pass.
   *
   * ALIASES ARE THE SEARCH SURFACE, DOMAINS ARE THE ANSWER. A worker says "kharad",
   * "lathe operator" or "turner"; the catalog calls it one thing. So the vectors live on
   * the aliases (many per domain) and the result is DEDUPED to the best-scoring alias
   * per domain — otherwise a domain with forty aliases would fill the whole shortlist
   * with itself and crowd out the alternatives the model needs to choose between.
   *
   * SELECTABLE + ACTIVE ONLY. The catalog is a hierarchy: ISCO major groups exist to
   * organize the tree, not to describe anyone's job ("Craft and Related Trades Workers"
   * is nobody's trade). `selectable` marks the leaves a worker can actually be, and
   * `status` keeps a deprecated row searchable-by-id but never re-matched.
   */
  async nearestDomains(vector: number[], k: number): Promise<DomainCandidate[]> {
    // pgvector accepts the '[1,2,3]' literal; JSON.stringify produces exactly that.
    const vec = JSON.stringify(vector);
    const rows = await this.db.execute(sql`
      SELECT DISTINCT ON (a.job_domain_id)
             a.job_domain_id,
             d.label_en AS label,
             1 - (a.embedding <=> ${vec}::vector) AS score
      FROM job_domain_alias a
      JOIN job_domain d ON d.job_domain_id = a.job_domain_id
      WHERE a.embedding IS NOT NULL
        AND d.selectable = true
        AND d.status = 'active'
      -- DISTINCT ON needs the dedupe key to lead; the distance decides WHICH alias of a
      -- domain survives. The outer ORDER BY then ranks the survivors by score.
      ORDER BY a.job_domain_id, a.embedding <=> ${vec}::vector
    `);
    const deduped = rows as unknown as Array<{
      job_domain_id: string;
      label: string;
      score: string | number;
    }>;
    return deduped
      .map((r) => ({ job_domain_id: r.job_domain_id, label: r.label, score: Number(r.score) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
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
   * (phrase, domain_id, lang) unique key increment `count` + bump `last_seen`
   * (the migration's NULLS NOT DISTINCT makes NULL domain/lang dedupe too).
   * `phrase` is ALREADY pseudonymized (SG-1). Returns the row id + post-upsert count.
   */
  async recordUnresolved(
    phrase: string,
    domainId: string,
    lang: string,
  ): Promise<{ id: string; count: number }> {
    const rows = await this.db.execute(sql`
      INSERT INTO unresolved_phrase (phrase, domain_id, lang)
      VALUES (${phrase}, ${domainId}, ${lang})
      ON CONFLICT (phrase, domain_id, lang)
      DO UPDATE SET count = unresolved_phrase.count + 1, last_seen = now()
      RETURNING id, count
    `);
    const row = (rows as unknown as Array<{ id: string; count: number }>)[0];
    if (!row) throw new Error("unresolved_phrase upsert returned no row");
    return { id: row.id, count: Number(row.count) };
  }
}
