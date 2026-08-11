import { config } from "dotenv";
import { sql as dsql } from "drizzle-orm";

import { createDbClient } from "./client";

config({ path: "../../.env" });

async function main(): Promise<void> {
  const { db, sql } = createDbClient(process.env.DATABASE_URL as string, { max: 1 });
  try {
    const q = async (label: string, query: ReturnType<typeof dsql>) => {
      const rows = (await db.execute(query)) as unknown as Array<Record<string, unknown>>;
      console.log(`--- ${label} ---`);
      if (rows.length === 0) console.log("  (none)");
      for (const r of rows) console.log("  " + JSON.stringify(r));
    };

    await q(
      "alias text length distribution (searchable only)",
      dsql`SELECT min(length(text))::int AS min, max(length(text))::int AS max,
                  round(avg(length(text))::numeric, 1) AS avg,
                  percentile_cont(0.99) WITHIN GROUP (ORDER BY length(text))::int AS p99,
                  count(*) FILTER (WHERE length(text) > 80)::int AS over_80,
                  count(*) FILTER (WHERE length(text) > 120)::int AS over_120
           FROM job_domain_alias WHERE is_searchable`,
    );
    await q(
      "sentence-fragment aliases (start lowercase w/ a conjunction/preposition) — searchable",
      dsql`SELECT count(*)::int AS n FROM job_domain_alias
           WHERE is_searchable
             AND text ~ '^(or|and|to|of|for|with|the|in|on|by|from|etc)\\M'`,
    );
    await q(
      "sample of the longest searchable aliases",
      dsql`SELECT left(text, 110) AS text, length(text)::int AS len, source
           FROM job_domain_alias WHERE is_searchable
           ORDER BY length(text) DESC LIMIT 8`,
    );
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
