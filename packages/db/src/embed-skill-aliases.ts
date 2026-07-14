/**
 * Skill-alias embedding runner (ADR-0030 / TAX-3 "fork B" — owner-chosen 2026-07-14).
 *
 * Populates `skill_alias.embedding` for rows still NULL by calling the ai-service
 * embed endpoint (`POST /embeddings/skill-alias`) in batches. The DB read/write lives
 * HERE (owner connection) — the ai-service stays DB-free by design; it only ever sees
 * alias TEXT (reference vocabulary), pseudonymized before any embed (SG-2), and returns
 * vectors. MOCK embeddings by default (zero spend); the real provider is §7-gated inside
 * the ai-service (AI_ENABLE_REAL_CALLS + key + `skill_embedding` allowlist — SG-4).
 *
 * GUARDED: refuses NODE_ENV === "production" (mirrors seed-skills.ts — embedding is an
 *   ops action; the prod run is a deliberate, gated step).
 * RESUMABLE / IDEMPOTENT: only `embedding IS NULL` rows are fetched; a completed corpus
 *   re-run is a no-op. BLOCKED rows (pseudonymize fail-closed) are left NULL, excluded
 *   from later fetches THIS RUN (no window-clog / re-count — the TAX-3 F1 semantics),
 *   and reported at the end for a human to inspect.
 *
 *   pnpm db:embed:skills
 *   (DATABASE_URL from env/.env; AI_SERVICE_URL defaults to http://localhost:8000 —
 *    start the ai-service first: cd apps/ai-service && uvicorn app.main:app)
 */
import { config } from "dotenv";
import { isNull, and, eq, notInArray } from "drizzle-orm";

import { createDbClient } from "./client";
import { skillAliases } from "./schema";

config({ path: "../../.env" });

const BATCH_SIZE = 100;

interface EmbedItemResult {
  alias_id: string;
  vector: number[] | null;
  blocked: boolean;
}
interface EmbedResponse {
  results: EmbedItemResult[];
  is_mock: boolean;
  model: string;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("[embed:skills] refusing to embed in production (run is §7-gated ops).");
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[embed:skills] DATABASE_URL is not set");
  const aiBase = process.env.AI_SERVICE_URL ?? "http://localhost:8000";

  const { db, sql } = createDbClient(url, { max: 1 });
  const blocked: string[] = [];
  let embedded = 0;
  let model = "";
  let isMock = true;

  try {
    // Strictly progress-or-stop: each batch either embeds >=1 row (leaves the NULL set)
    // or adds >=1 id to `blocked` (excluded from the next fetch) — always terminates.
    for (;;) {
      const rows = await db
        .select({ id: skillAliases.id, text: skillAliases.text })
        .from(skillAliases)
        .where(
          blocked.length > 0
            ? and(isNull(skillAliases.embedding), notInArray(skillAliases.id, blocked))
            : isNull(skillAliases.embedding),
        )
        .orderBy(skillAliases.id)
        .limit(BATCH_SIZE);
      if (rows.length === 0) break;

      const resp = await fetch(`${aiBase}/embeddings/skill-alias`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          items: rows.map((r) => ({ alias_id: r.id, text: r.text })),
        }),
      });
      if (!resp.ok) {
        throw new Error(`[embed:skills] ai-service HTTP ${resp.status} — aborting (no partial guesswork)`);
      }
      const data = (await resp.json()) as EmbedResponse;
      model = data.model;
      isMock = data.is_mock;

      for (const r of data.results) {
        if (r.blocked || r.vector === null) {
          blocked.push(r.alias_id);
          continue;
        }
        await db
          .update(skillAliases)
          .set({ embedding: r.vector })
          .where(eq(skillAliases.id, r.alias_id));
        embedded += 1;
      }
      if (rows.length < BATCH_SIZE) break;
    }

    console.log(
      `[embed:skills] done — embedded=${embedded} blocked=${blocked.length} model=${model || "(none fetched)"} mock=${isMock}`,
    );
    if (blocked.length > 0) {
      console.log(`[embed:skills] blocked alias ids (left NULL, inspect + fix source text):`);
      for (const id of blocked) console.log(`  - ${id}`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
