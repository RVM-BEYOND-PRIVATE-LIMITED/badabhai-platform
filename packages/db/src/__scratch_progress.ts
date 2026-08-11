import { config } from "dotenv";
import { sql as dsql } from "drizzle-orm";

import { createDbClient } from "./client";

config({ path: "../../.env" });

async function main(): Promise<void> {
  const { db, sql } = createDbClient(process.env.DATABASE_URL as string, { max: 1 });
  try {
    const rows = (await db.execute(dsql`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE embedding IS NOT NULL)::int AS embedded,
             count(*) FILTER (WHERE is_searchable)::int AS searchable,
             count(*) FILTER (WHERE is_searchable AND embedding IS NOT NULL)::int AS searchable_embedded,
             min(embedded_at) AS first_batch,
             max(embedded_at) AS last_batch,
             now() AS now,
             extract(epoch from (now() - min(embedded_at)))::int AS elapsed_s
      FROM job_domain_alias`)) as unknown as Array<Record<string, unknown>>;
    const r = rows[0] as Record<string, unknown>;
    const embedded = Number(r.embedded);
    const elapsed = Number(r.elapsed_s);
    console.log(JSON.stringify(r));
    if (embedded > 0 && elapsed > 0) {
      const rate = embedded / elapsed;
      const remaining = Number(r.total) - embedded;
      console.log(
        `rate = ${rate.toFixed(2)} rows/s | remaining ${remaining} | ETA ~${Math.round(remaining / rate / 60)} min`,
      );
    }
    const models = (await db.execute(dsql`
      SELECT embedding_model, count(*)::int AS n FROM job_domain_alias
      WHERE embedding_model IS NOT NULL GROUP BY embedding_model`)) as unknown as Array<
      Record<string, unknown>
    >;
    for (const m of models) console.log("  " + JSON.stringify(m));
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
