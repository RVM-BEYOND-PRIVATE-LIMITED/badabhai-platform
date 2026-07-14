/**
 * LIVE step 2 of the TAX-5 floor sweep — score embedded wedge phrases against the
 * REAL `skill_alias` vectors (domain-scoped top-3 per phrase), producing the scores
 * snapshot the offline pytest analysis (tests/wedge_eval/test_wedge.py) consumes.
 *
 *   pnpm --filter @badabhai/db exec tsx src/score-wedge.ts <vectors.json> <scores.json>
 *
 * Read-only against the DB (owner connection — skill_alias is REVOKE'd from Data-API
 * roles). The input comes from apps/ai-service tests/wedge_eval/embed_wedge.py (REAL
 * embeds only — it refuses mock). The output strips the vectors (scores + ids only),
 * so the committed fixture stays small and diff-able.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { config } from "dotenv";
import postgres from "postgres";

config({ path: "../../.env" });

interface CaseIn {
  phrase: string;
  domain_id: string;
  expected: string;
  tier: string;
  requires_wedge: boolean;
  vector: number[];
}

async function main(inPath: string, outPath: string): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[score-wedge] DATABASE_URL is not set");
  const input = JSON.parse(readFileSync(inPath, "utf8")) as { model: string; cases: CaseIn[] };
  const sql = postgres(url, { max: 1 });
  const out = [];
  try {
    for (const c of input.cases) {
      const v = JSON.stringify(c.vector);
      const rows = await sql`
        SELECT skill_id, text, 1 - (embedding <=> ${v}::vector) AS score
        FROM skill_alias
        WHERE domain_id = ${c.domain_id} AND embedding IS NOT NULL
        ORDER BY embedding <=> ${v}::vector
        LIMIT 3`;
      out.push({
        phrase: c.phrase,
        domain_id: c.domain_id,
        expected: c.expected,
        tier: c.tier,
        requires_wedge: c.requires_wedge,
        candidates: rows.map((r) => ({
          skill_id: r.skill_id as string,
          alias: r.text as string,
          score: Number(r.score),
        })),
      });
    }
  } finally {
    await sql.end();
  }
  writeFileSync(
    outPath,
    JSON.stringify({ model: input.model, scored_at: new Date().toISOString(), cases: out }, null, 1),
  );
  console.log(`[score-wedge] scored ${out.length} phrases (model=${input.model}) -> ${outPath}`);
}

main(process.argv[2]!, process.argv[3]!).catch((err) => {
  console.error(err);
  process.exit(1);
});
