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
  // The shipped extract wiring queries ONE anchor domain for every label until
  // per-label domain resolution lands (TAX-6) — score BOTH so the snapshot carries
  // oracle (labeled-domain) AND shipped-path (anchor-domain) truth (#225 review M1).
  const ANCHOR_DOMAIN = "cnc-machining";
  const sql = postgres(url, { max: 1 });
  const out = [];
  let fingerprint: { domain_id: string; embedded: number }[] = [];
  try {
    const top3 = async (v: string, domain: string) => {
      const rows = await sql`
        SELECT skill_id, text, 1 - (embedding <=> ${v}::vector) AS score
        FROM skill_alias
        WHERE domain_id = ${domain} AND embedding IS NOT NULL
        ORDER BY embedding <=> ${v}::vector
        LIMIT 3`;
      return rows.map((r) => ({
        skill_id: r.skill_id as string,
        alias: r.text as string,
        score: Number(r.score),
      }));
    };
    for (const c of input.cases) {
      const v = JSON.stringify(c.vector);
      out.push({
        phrase: c.phrase,
        domain_id: c.domain_id,
        expected: c.expected,
        tier: c.tier,
        requires_wedge: c.requires_wedge,
        candidates: await top3(v, c.domain_id),
        candidates_anchor: await top3(v, ANCHOR_DOMAIN),
      });
    }
    // Corpus fingerprint: per-domain embedded-alias counts — makes sweep-vs-corpus
    // drift VISIBLE at review time (a re-embed/ratification changes these numbers).
    const fp = await sql`
      SELECT domain_id, count(*)::int AS embedded FROM skill_alias
      WHERE embedding IS NOT NULL GROUP BY domain_id ORDER BY domain_id`;
    fingerprint = fp.map((r) => ({ domain_id: r.domain_id as string, embedded: Number(r.embedded) }));
  } finally {
    await sql.end();
  }
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        model: input.model,
        scored_at: new Date().toISOString(),
        anchor_domain: ANCHOR_DOMAIN,
        corpus_fingerprint: fingerprint,
        cases: out,
      },
      null,
      1,
    ),
  );
  console.log(`[score-wedge] scored ${out.length} phrases (model=${input.model}) -> ${outPath}`);
}

main(process.argv[2]!, process.argv[3]!).catch((err) => {
  console.error(err);
  process.exit(1);
});
