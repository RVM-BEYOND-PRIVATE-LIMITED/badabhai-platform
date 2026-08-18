/**
 * Fill the offline replay's query-vector gap — the smallest possible provider run.
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 * `replay-path-a.ts` scores only the fixture cases whose query vector is already in the local
 * embed cache. That cache is a partial artifact of a Phase-8 run which exhausted its daily
 * request quota mid-way, so 11 of 127 cases were unscoreable — and all 11 happened to be
 * REVIEWED cases, i.e. 12.5% of the entire scoreable set, including two sitting in domains the
 * TD-01/TD-02 merges touched. A gap that size, concentrated in exactly the graded cases, is not
 * something a replay can report around.
 *
 * This runner embeds ONLY those missing queries, one text per request, and does nothing else.
 *
 * ===========================================================================
 * THE THREE GUARDS
 * ===========================================================================
 * 1. DRY RUN IS THE DEFAULT. `--plan` (implicit) prints the exact texts and the exact request
 *    count and calls nothing. Provider spend requires `--apply`.
 *
 * 2. MOCK DETECTION, AND IT ABORTS. `ai-service` falls back to a deterministic
 *    `_mock_embedding` when no real provider is configured, and a mock vector is
 *    indistinguishable from a real one by inspection — it has the right dimension, the right
 *    magnitude, and produces entirely plausible-looking cosines. Writing one into the cache
 *    would silently corrupt every future replay, and the cache is keyed by model so nothing
 *    downstream would ever notice. Every response is therefore classified against a local
 *    reproduction of that fallback, and the FIRST mock aborts the run before it is cached.
 *
 * 3. NOTHING ELSE IS TOUCHED. No database connection is opened. No alias, embedding, flag,
 *    taxonomy row or fixture is written. The only output is the gitignored vector cache plus a
 *    small committed evidence record.
 *
 * ===========================================================================
 * WHAT IS RECORDED, AND WHAT DELIBERATELY IS NOT
 * ===========================================================================
 * The evidence record carries the query text, the model, the vector's dimension, its L2 norm
 * and a sha256 of its contents — enough to prove a specific vector was obtained and to detect
 * later drift. It does NOT carry the 768 floats: those are derived data regenerable from the
 * provider at any time, they are megabytes of noise in a diff, and committing them invites a
 * reviewer to mistake cached vectors for a measurement. They live in the gitignored cache,
 * exactly where `taxonomy-embed-cache.ts` says derived vectors belong.
 *
 * Usage:
 *   pnpm db:embed:replay-queries              # plan only — no provider call
 *   pnpm db:embed:replay-queries --apply --evidence=<json>
 */
import { config } from "dotenv";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createEmbedCache, DEFAULT_CACHE_DIR } from "./taxonomy-embed-cache";
import { classifyEmbedding } from "./taxonomy-retrieval-eval";
import { EMBEDDING_MODEL } from "./taxonomy-alias-experiment";
import { isScoreable, loadEvalFixture } from "./taxonomy-eval-fixture";
import { argFlag, argValue } from "./match-v1-cli";

config();

const sha = (t: string): string => createHash("sha256").update(t, "utf8").digest("hex");

function cachedHashes(): Set<string> {
  const file = join(DEFAULT_CACHE_DIR, "vectors.json");
  if (!existsSync(file)) return new Set();
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, number[]>;
  const out = new Set<string>();
  for (const k of Object.keys(raw)) {
    if (k.startsWith(`${EMBEDDING_MODEL}:`)) out.add(k.slice(EMBEDDING_MODEL.length + 1));
  }
  return out;
}

async function main(): Promise<void> {
  const apply = argFlag("apply");
  const evidencePath = argValue("evidence");

  const fixture = loadEvalFixture(
    join(__dirname, "..", "data", "taxonomy", "eval", "retrieval-v2.jsonl"),
  );
  const have = cachedHashes();
  const missing = fixture.cases.filter((c) => !have.has(sha(c.query)));

  console.log(`[embed:replay-queries] model ${EMBEDDING_MODEL}`);
  console.log(`  fixture cases          ${fixture.cases.length}`);
  console.log(`  already cached         ${fixture.cases.length - missing.length}`);
  console.log(`  MISSING                ${missing.length}  (reviewed: ${missing.filter(isScoreable).length})`);
  console.log(`  provider requests      ${missing.length}  (one text per request on this endpoint)`);
  for (const c of missing) {
    console.log(`     ${c.case_id.padEnd(8)} ${isScoreable(c) ? "REVIEWED  " : "mechanical"} ${c.job_domain_id.padEnd(18)} ${JSON.stringify(c.query)}`);
  }
  if (missing.length === 0) {
    console.log("  nothing to do.");
    return;
  }
  if (!apply) {
    console.log("\n  DRY RUN — no provider was called. Re-run with --apply to spend the requests above.");
    return;
  }

  const aiBase = process.env.AI_SERVICE_URL ?? "http://localhost:8000";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env.AI_INTERNAL_TOKEN) headers["x-ai-internal-token"] = process.env.AI_INTERNAL_TOKEN;

  // Same request shape as `taxonomy-alias-experiment.ts` — one text per request on this
  // endpoint, which is why 11 texts cost 11 requests and not one batch.
  const fetchVector = async (text: string): Promise<number[]> => {
    const r = await fetch(`${aiBase}/embeddings/skill-alias`, {
      method: "POST",
      headers,
      body: JSON.stringify({ items: [{ alias_id: "00000000-0000-4000-8000-000000000000", text }] }),
    });
    if (!r.ok) throw new Error(`embed ${r.status}: ${await r.text()}`);
    const j = (await r.json()) as {
      results?: { vector: number[] }[];
      errors?: number;
      is_mock?: boolean;
      budget_stopped?: boolean;
    };
    // The server says so itself — trusted FIRST, and independently re-checked against a local
    // reproduction of the fallback once the vector is in hand. Two different mechanisms,
    // because this is the one failure that is invisible downstream.
    if (j.is_mock === true) throw new Error("ai-service reported is_mock — no real provider configured");
    if (j.budget_stopped === true) throw new Error("the ai-service spend ledger blocked the call");
    const v = j.results?.[0]?.vector;
    if (v === undefined) {
      // A 200 with an empty result set means the provider refused every retry — usually the
      // per-day REQUEST quota, since this endpoint sends one text per request.
      throw new Error(
        `provider returned no vector after ai-service exhausted its retries ` +
          `(errors=${String(j.errors ?? "?")}). Check the ai-service log for 429.`,
      );
    }
    return v;
  };

  const cache = createEmbedCache({ model: EMBEDDING_MODEL, fetchVector });
  const records: {
    case_id: string;
    query: string;
    scoreable: boolean;
    dimension: number;
    l2_norm: number;
    vector_sha256: string;
    provenance: string;
  }[] = [];

  console.log(`\n  calling ${aiBase} — ${missing.length} requests, aborting on the first mock…`);
  for (const c of missing) {
    const vec = await cache.embed(c.query);
    const provenance = classifyEmbedding(c.query, vec);
    if (provenance === "MOCK") {
      // Do NOT flush. A mock in the cache is permanent, invisible, and poisons every replay.
      console.error(
        `\n  ABORT — ${c.case_id} returned a MOCK vector. ai-service has no real embedding ` +
          `provider configured. Nothing was cached; no further requests were made.`,
      );
      process.exit(1);
    }
    const l2 = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
    records.push({
      case_id: c.case_id,
      query: c.query,
      scoreable: isScoreable(c),
      dimension: vec.length,
      l2_norm: Number(l2.toFixed(6)),
      vector_sha256: sha(JSON.stringify(vec)),
      provenance,
    });
    console.log(`     ${c.case_id.padEnd(8)} dim=${vec.length} |v|=${l2.toFixed(4)} ${provenance}`);
  }

  cache.flush();
  const stats = cache.stats();
  console.log(`\n  cache: ${stats.hits} hits, ${stats.misses} provider requests. Flushed.`);

  if (evidencePath !== undefined) {
    if (existsSync(evidencePath)) {
      console.error(`  refusing to overwrite ${evidencePath} — evidence is never replaced.`);
      process.exit(1);
    }
    writeFileSync(
      evidencePath,
      `${JSON.stringify(
        {
          kind: "replay-query-vector-provenance",
          purpose: "close the offline Path-A replay's 12.5% reviewed-case gap",
          embedding_model: EMBEDDING_MODEL,
          endpoint: "/embeddings/skill-alias (one text per request)",
          requests: records.length,
          all_not_mock: records.every((r) => r.provenance === "NOT_MOCK"),
          note: "Vectors themselves are derived data and live in the gitignored embed cache; only their digests are recorded here.",
          records,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    console.log(`  evidence written to ${evidencePath}`);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
