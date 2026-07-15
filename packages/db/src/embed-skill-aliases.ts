/**
 * Skill-alias embedding runner (ADR-0030 / TAX-3 "fork B" — owner-chosen 2026-07-14).
 *
 * Populates `skill_alias.embedding` for rows still NULL by calling the ai-service
 * embed endpoint (`POST /embeddings/skill-alias`) in batches. The DB read/write lives
 * HERE (owner connection) — the ai-service stays DB-free by design; it only ever sees
 * alias TEXT (reference vocabulary), pseudonymized before any embed (SG-2), and returns
 * vectors. MOCK embeddings by default (zero spend); the real provider is §7-gated inside
 * the ai-service (AI_ENABLE_REAL_CALLS + key + `skill_embedding` allowlist — SG-4), and
 * the endpoint enforces a per-request INR ceiling on the real path (TD64 interim guard) —
 * on `budget_stopped` this runner STOPS and a later run resumes the NULL rows.
 *
 * GUARDED: refuses NODE_ENV === "production" (mirrors seed-skills.ts — embedding is an
 *   ops action; the prod run is a deliberate, gated step).
 * RESUMABLE / IDEMPOTENT: only `embedding IS NULL` rows are fetched; a completed corpus
 *   re-run is a no-op. BLOCKED rows (pseudonymize fail-closed) are left NULL, excluded
 *   from later fetches THIS RUN (no window-clog / re-count — the TAX-3 F1 semantics),
 *   and reported at the end for a human to inspect. Per-item provider ERRORS are omitted
 *   from the response (stay NULL, retried next run); a batch that makes NO progress at
 *   all aborts hard rather than looping.
 *
 *   pnpm db:embed:skills                      # backfill NULL rows
 *   pnpm db:embed:skills --reset-embeddings    # NULL ALL vectors (mixed-space recovery)
 *   (DATABASE_URL from env/.env; AI_SERVICE_URL defaults to http://localhost:8000 —
 *    start the ai-service first: cd apps/ai-service && uvicorn app.main:app.
 *    EMBED_BATCH_SIZE overrides the 100-row batch — use a SMALLER batch, e.g. 20, for
 *    REAL runs so one HTTP request stays well under the 10-minute timeout.)
 */
import { config } from "dotenv";
import { isNull, isNotNull, and, eq, notInArray } from "drizzle-orm";

import { createDbClient } from "./client";
import { parseEmbedResponse } from "./embed-response";
import { skillAliases } from "./schema";

config({ path: "../../.env" });

const BATCH_SIZE = Math.max(1, Math.min(200, Number(process.env.EMBED_BATCH_SIZE) || 100));
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("[embed:skills] refusing to embed in production (run is §7-gated ops).");
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[embed:skills] DATABASE_URL is not set");
  const aiBase = process.env.AI_SERVICE_URL ?? "http://localhost:8000";

  // --reset-embeddings: NULL out ALL skill_alias embeddings and exit. The recovery for a
  // mixed vector space (mock hash vectors are indistinguishable at rest from real ones —
  // no provenance column), run BEFORE a real backfill if a prior mock run persisted
  // vectors (SR-1 step 2). Re-embedding the corpus afterwards is cheap.
  if (process.argv.includes("--reset-embeddings")) {
    const { db, sql } = createDbClient(url, { max: 1 });
    try {
      const reset = await db
        .update(skillAliases)
        .set({ embedding: null })
        .where(isNotNull(skillAliases.embedding))
        .returning({ id: skillAliases.id });
      console.log(`[embed:skills] reset — ${reset.length} embeddings set to NULL; re-run the backfill.`);
    } finally {
      await sql.end();
    }
    return;
  }

  const { db, sql } = createDbClient(url, { max: 1 });
  const blocked: string[] = [];
  let embedded = 0;
  let providerErrors = 0;
  let costInr = 0;
  let model = "";
  let isMock = true;
  let budgetStopped = false;

  try {
    // Strictly progress-or-stop: each batch either embeds >=1 row (leaves the NULL set),
    // adds >=1 id to `blocked` (excluded from the next fetch), or ABORTS — never loops.
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
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!resp.ok) {
        throw new Error(`[embed:skills] ai-service HTTP ${resp.status} — aborting (no partial guesswork)`);
      }
      const data = parseEmbedResponse(await resp.json(), new Set(rows.map((r) => r.id)));
      model = data.model;
      isMock = data.is_mock;
      providerErrors += data.errors;
      costInr += data.estimated_cost_inr;

      let savedThisBatch = 0;
      let blockedThisBatch = 0;
      for (const r of data.results) {
        if (r.blocked || r.vector === null) {
          blocked.push(r.alias_id);
          blockedThisBatch += 1;
          continue;
        }
        await db
          .update(skillAliases)
          .set({ embedding: r.vector })
          .where(eq(skillAliases.id, r.alias_id));
        embedded += 1;
        savedThisBatch += 1;
      }

      if (data.budget_stopped) {
        // The endpoint's per-request INR ceiling fired (TD64 interim guard). Stop the
        // whole run — remaining rows stay NULL; re-run later (or raise the ceiling).
        budgetStopped = true;
        break;
      }
      if (savedThisBatch === 0 && blockedThisBatch === 0) {
        // Nothing embedded, nothing newly excluded (e.g. every item errored on the
        // provider): the next fetch would return the SAME rows — abort, don't loop.
        throw new Error(
          `[embed:skills] batch made no progress (provider errors=${data.errors}) — aborting; rows stay NULL, re-run later`,
        );
      }
      if (rows.length < BATCH_SIZE) break;
    }

    console.log(
      `[embed:skills] done — embedded=${embedded} blocked=${blocked.length} providerErrors=${providerErrors} ` +
        `budgetStopped=${budgetStopped} estCostInr=${costInr.toFixed(6)} model=${model || "(none fetched)"} mock=${isMock}`,
    );
    if (budgetStopped) {
      console.log("[embed:skills] BUDGET STOP — remaining rows left NULL; re-run to resume.");
    }
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
