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
 *   pnpm db:embed:skills                      # backfill NULL rows (ENTIRE table)
 *   pnpm db:embed:skills --batch <batch-dir>  # ONLY the skills that batch's gate accepted
 *   pnpm db:embed:skills --batch <dir> --plan # inventory + call/token plan; calls nothing
 *   pnpm db:embed:skills --reset-embeddings    # NULL ALL vectors (mixed-space recovery)
 *
 * SCOPE. Without `--batch` this embeds every `embedding IS NULL` row in `skill_alias` —
 * the shipped catalogue and every batch's rows alike. `--batch` restricts it to the
 * `skill_id`s in that batch's `accepted-skills.jsonl`, which is what keeps a first
 * controlled embedding run inside its own blast radius. It reads the ACCEPTED file only;
 * a blocked batch has no such file and is refused rather than treated as an empty scope.
 *   (DATABASE_URL from env/.env; AI_SERVICE_URL defaults to http://localhost:8000 —
 *    start the ai-service first: cd apps/ai-service && uvicorn app.main:app.
 *    EMBED_BATCH_SIZE overrides the 100-row batch — use a SMALLER batch, e.g. 20, for
 *    REAL runs so one HTTP request stays well under the 10-minute timeout.)
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { config } from "dotenv";
import { isNull, isNotNull, and, eq, inArray, notInArray, type SQL } from "drizzle-orm";

import { createDbClient } from "./client";
import { parseEmbedResponse } from "./embed-response";
import { skillAliases } from "./schema";

config({ path: "../../.env" });

/** TD67: attach the ai-service bearer when the env provides one (required once the
 * service sets AI_INTERNAL_TOKEN; absent = the historical open dev posture). */
const AI_HEADERS: Record<string, string> = { "content-type": "application/json" };
if (process.env.AI_INTERNAL_TOKEN) AI_HEADERS["x-ai-internal-token"] = process.env.AI_INTERNAL_TOKEN;

const BATCH_SIZE = Math.max(1, Math.min(200, Number(process.env.EMBED_BATCH_SIZE) || 100));
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
/** Texts the ai-service packs into ONE provider request (`EMBED_REQUEST_BATCH` there).
 *  Mirrored here only to PLAN the request count; it changes nothing about what is sent. */
const PROVIDER_TEXTS_PER_REQUEST = 100;

/** Read `--flag value` out of argv. */
function arg(argv: readonly string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
}

/**
 * The skill ids a batch's quality gate ACCEPTED — the `--batch` scope.
 *
 * WHY THIS EXISTS. Without a scope the runner embeds every `embedding IS NULL` row in the
 * table, which is the whole vocabulary: a controlled batch's rows AND the shipped catalogue
 * AND every future batch's. "Embed only what this batch produced" was not expressible, so a
 * first controlled embedding run could not be kept to its own blast radius.
 *
 * READS `accepted-skills.jsonl`, NEVER `blocked-skills.jsonl`. A blocked batch has no
 * accepted file, so pointing `--batch` at one is refused rather than silently embedding
 * nothing — the two outcomes look identical in a log and mean opposite things.
 */
export function batchScopeSkillIds(batchDir: string): string[] {
  const path = join(batchDir, "accepted-skills.jsonl");
  if (!existsSync(path)) {
    throw new Error(
      `[embed:skills] ${path} does not exist. --batch scopes a run to the skills a batch's ` +
        `quality gate ACCEPTED; a BLOCKED batch has blocked-skills.jsonl instead and its rows ` +
        `must never be embedded. Point --batch at a batch that passed, or drop the flag to ` +
        `embed every pending alias.`,
    );
  }
  const ids = new Set<string>();
  readFileSync(path, "utf8")
    .split(/\r?\n/)
    .forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) return;
      let parsed: { skill_id?: unknown };
      try {
        parsed = JSON.parse(trimmed) as { skill_id?: unknown };
      } catch {
        throw new Error(`[embed:skills] ${path} line ${i + 1}: not valid JSON`);
      }
      if (typeof parsed.skill_id !== "string" || parsed.skill_id.length === 0) {
        throw new Error(`[embed:skills] ${path} line ${i + 1}: missing skill_id`);
      }
      ids.add(parsed.skill_id);
    });
  if (ids.size === 0) {
    // An empty scope must NOT degrade to "everything". `inArray(x, [])` is a false
    // predicate in some dialects and an error in others; either way, silently embedding
    // the whole table because a file was empty is the failure this refuses.
    throw new Error(`[embed:skills] ${path} declares no skills — refusing an empty --batch scope.`);
  }
  return [...ids].sort();
}

/** The pending-row predicate: NULL embeddings, minus this run's blocked ids, restricted to
 *  the `--batch` scope when one was given. Factored out because it is the one place a bug
 *  would silently widen the blast radius, and that deserves a test rather than a reading. */
export function pendingAliasWhere(blocked: readonly string[], scopeSkillIds: readonly string[] | null): SQL {
  const clauses: SQL[] = [isNull(skillAliases.embedding) as SQL];
  if (blocked.length > 0) clauses.push(notInArray(skillAliases.id, [...blocked]) as SQL);
  if (scopeSkillIds !== null) clauses.push(inArray(skillAliases.skillId, [...scopeSkillIds]) as SQL);
  return (clauses.length === 1 ? clauses[0] : and(...clauses)) as SQL;
}

/** Rough token count for PLANNING only — chars/4, the same heuristic the ai-service's
 *  `estimate_tokens` uses. Never reported as actual provider usage. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

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
    if (process.argv.includes("--batch")) {
      // Refusing beats guessing. --reset-embeddings is a GLOBAL recovery for a mixed vector
      // space; --batch means "only these skills". Honouring one while the operator typed the
      // other would either wipe the whole corpus when they scoped it, or leave the mixed
      // space they were trying to clear. Both are silent, and one is destructive.
      throw new Error(
        `[embed:skills] --reset-embeddings is global and cannot be combined with --batch. ` +
          `Re-run with exactly one of them.`,
      );
    }
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

  // --batch <dir>: restrict this run to the skills that batch's quality gate accepted.
  // Absent = every pending alias in the table, which is the historical behaviour.
  const batchDir = arg(process.argv, "--batch");
  const scopeSkillIds = batchDir === null ? null : batchScopeSkillIds(batchDir);
  if (scopeSkillIds !== null) {
    console.log(`[embed:skills] scope --batch ${batchDir} — ${scopeSkillIds.length} skill id(s)`);
  }

  const { db, sql } = createDbClient(url, { max: 1 });

  // --plan: inventory what WOULD be embedded and exit. No ai-service call, no write. The
  // pre-execution numbers ("how many calls, how many tokens") have to come from the same
  // predicate the run uses, or they describe a different job than the one that executes.
  if (process.argv.includes("--plan")) {
    try {
      const pending = await db
        .select({ id: skillAliases.id, text: skillAliases.text, skillId: skillAliases.skillId })
        .from(skillAliases)
        .where(pendingAliasWhere([], scopeSkillIds));
      const tokens = pending.reduce((n, r) => n + estimateTokens(r.text), 0);
      console.log(`[embed:skills] PLAN — nothing called, nothing written`);
      console.log(`  scope                    = ${batchDir ?? "(entire table)"}`);
      console.log(`  skills in scope          = ${scopeSkillIds?.length ?? "all"}`);
      console.log(`  aliases needing embedding= ${pending.length}`);
      console.log(`  distinct skills covered  = ${new Set(pending.map((r) => r.skillId)).size}`);
      console.log(`  runner batches           = ${Math.ceil(pending.length / BATCH_SIZE)} (EMBED_BATCH_SIZE=${BATCH_SIZE})`);
      console.log(`  provider requests        = ${Math.ceil(pending.length / PROVIDER_TEXTS_PER_REQUEST)} (${PROVIDER_TEXTS_PER_REQUEST} texts each)`);
      console.log(`  estimated tokens         = ${tokens} (chars/4 heuristic — NOT metered usage)`);
      console.log(`  estimated provider cost  = mock path ₹0. On the real path the ai-service`);
      console.log(`                             meters it and returns estimated_cost_inr; this`);
      console.log(`                             layer does not price providers and must not.`);
    } finally {
      await sql.end();
    }
    return;
  }

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
        .where(pendingAliasWhere(blocked, scopeSkillIds))
        .orderBy(skillAliases.id)
        .limit(BATCH_SIZE);
      if (rows.length === 0) break;

      const resp = await fetch(`${aiBase}/embeddings/skill-alias`, {
        method: "POST",
        headers: AI_HEADERS,
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

// Entrypoint guard, same convention as taxonomy-quality-gate.ts / generate-domain-skills.ts.
// Without it, importing this module to test `batchScopeSkillIds` RUNS the embedder — which
// is how the scope predicate ended up untestable in the first place.
if (process.argv[1] && /embed-skill-aliases\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
