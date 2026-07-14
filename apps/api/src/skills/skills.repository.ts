import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Database } from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import type { AliasCandidate } from "./skills.dto";

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
