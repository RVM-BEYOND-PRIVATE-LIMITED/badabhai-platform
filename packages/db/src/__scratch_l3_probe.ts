/** Read-only proof that the L3 pgvector path works, WITHOUT spending provider quota.
 *  Uses an ALREADY-STORED alias embedding as the query vector, then runs the exact SQL
 *  `SkillsRepository.nearestDomains` runs, plus an EXPLAIN to confirm HNSW index usage. */
import { config } from "dotenv";
import { sql as dsql } from "drizzle-orm";

import { createDbClient } from "./client";

config({ path: "../../.env" });

const HNSW_EF_SEARCH = 200;

async function main(): Promise<void> {
  const { db, sql } = createDbClient(process.env.DATABASE_URL as string, { max: 1 });
  try {
    const seeds = (await db.execute(dsql`
      SELECT a.id, a.text, a.job_domain_id, d.label_en
      FROM job_domain_alias a
      JOIN job_domain d ON d.job_domain_id = a.job_domain_id
      WHERE a.is_searchable AND a.embedding IS NOT NULL
      ORDER BY a.id
      LIMIT 4`)) as unknown as Array<Record<string, string>>;

    for (const seed of seeds) {
      console.log(`\n${"=".repeat(78)}`);
      console.log(`query = stored embedding of alias "${seed.text}"  (${seed.label_en})`);

      const rows = (await db.transaction(async (tx) => {
        await tx.execute(dsql`SET LOCAL hnsw.ef_search = ${dsql.raw(String(HNSW_EF_SEARCH))}`);
        return tx.execute(dsql`
          WITH q AS (SELECT embedding AS v FROM job_domain_alias WHERE id = ${seed.id}),
          ann AS (
            SELECT a.job_domain_id, a.embedding <=> (SELECT v FROM q) AS dist
            FROM job_domain_alias a
            WHERE a.is_searchable
            ORDER BY a.embedding <=> (SELECT v FROM q)
            LIMIT 100
          ), best AS (
            SELECT DISTINCT ON (job_domain_id) job_domain_id, dist FROM ann
            ORDER BY job_domain_id, dist
          )
          SELECT b.job_domain_id, d.label_en AS label, 1 - b.dist AS score
          FROM best b JOIN job_domain d ON d.job_domain_id = b.job_domain_id
          WHERE d.selectable = true AND d.status = 'active'
          ORDER BY b.dist LIMIT 5`);
      })) as unknown as Array<Record<string, string>>;

      for (const r of rows) {
        console.log(`   ${Number(r.score).toFixed(4)}  ${r.label}`);
      }
    }

    // Does the partial HNSW index actually get used, or does PG fall back to a seq scan?
    console.log(`\n${"=".repeat(78)}\nEXPLAIN of the ANN leg (LIMIT 100, WHERE is_searchable):`);
    const plan = (await db.transaction(async (tx) => {
      await tx.execute(dsql`SET LOCAL hnsw.ef_search = ${dsql.raw(String(HNSW_EF_SEARCH))}`);
      return tx.execute(dsql`
        EXPLAIN (ANALYZE, BUFFERS)
        WITH q AS (SELECT embedding AS v FROM job_domain_alias WHERE id = ${seeds[0]?.id})
        SELECT a.job_domain_id, a.embedding <=> (SELECT v FROM q) AS dist
        FROM job_domain_alias a
        WHERE a.is_searchable
        ORDER BY a.embedding <=> (SELECT v FROM q)
        LIMIT 100`);
    })) as unknown as Array<Record<string, string>>;
    for (const p of plan) console.log("   " + Object.values(p)[0]);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
