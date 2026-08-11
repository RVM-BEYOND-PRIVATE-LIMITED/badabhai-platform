/**
 * Job-domain alias embedding runner (migration 0066).
 *
 * Populates `job_domain_alias.embedding` for rows still NULL by calling the ai-service
 * embed endpoint in batches. The DB read/write lives HERE (owner connection) — the
 * ai-service stays DB-free by design; it only ever sees alias TEXT (published
 * occupation vocabulary), pseudonymized before any embed, and returns vectors.
 *
 * REUSES `POST /embeddings/skill-alias` DELIBERATELY. That endpoint's contract is
 * generic — `{alias_id, text} -> {alias_id, vector, blocked}` with no DB access and no
 * skill-specific logic — and a `job_domain_alias.id` IS an alias id. Adding a
 * near-identical `/embeddings/batch` would mean a new contract, a new task-type in the
 * real-call allowlist, and a new conftest denylist entry, all to send the same payload
 * to the same model at the same price. Not worth it.
 *
 * MOCK embeddings by default (zero spend); the real provider is gated inside the
 * ai-service (AI_ENABLE_REAL_CALLS + key + the `skill_embedding` allowlist), and the
 * endpoint enforces a per-request INR ceiling — on `budget_stopped` this runner STOPS
 * and a later run resumes the NULL rows.
 *
 * WHAT THIS DOES THAT THE SKILL RUNNER CANNOT. `skill_alias` has no provenance column,
 * so a mock hash vector is indistinguishable at rest from a real one and the only
 * recovery is `--reset-embeddings` (nuke everything, re-embed everything). This table
 * records `embedding_model` + `embedded_at` on every write, which makes
 * `--reset-mock-embeddings` a surgical, cheap recovery instead of a full re-spend.
 *
 * GUARDED: refuses NODE_ENV === "production" (embedding is a gated ops action).
 * RESUMABLE / IDEMPOTENT: only `embedding IS NULL` rows are fetched, so a completed
 *   corpus re-run is a no-op. BLOCKED rows are left NULL, excluded from later fetches
 *   THIS RUN (no window-clog), and reported for a human. A batch that makes NO progress
 *   aborts hard rather than looping.
 *
 *   pnpm db:embed:domains                         # backfill NULL rows
 *   pnpm db:embed:domains --only-selectable       # leaf rows first (what retrieval queries)
 *   pnpm db:embed:domains --reset-mock-embeddings # NULL only the mock vectors
 *   pnpm db:embed:domains --reset-embeddings      # NULL ALL vectors (full recovery)
 *   (DATABASE_URL from env/.env; AI_SERVICE_URL defaults to http://localhost:8000 —
 *    start the ai-service first: cd apps/ai-service && uvicorn app.main:app.
 *    EMBED_BATCH_SIZE overrides the 100-row batch. Prefer a LARGER batch (the 200-row
 *    contract cap) for REAL runs: the ai-service now embeds up to 100 texts per
 *    PROVIDER request, and the provider meters embedding REQUESTS per day, not texts.
 *    The old advice here — "use a smaller batch, e.g. 20" — predates that and is now
 *    backwards: it would spend 5x the request quota for the same corpus. Wall-clock is
 *    no longer the binding constraint either, so the 10-minute request timeout has
 *    ample headroom at 200.)
 */
import { config } from "dotenv";
import { and, eq, inArray, isNull, isNotNull, notInArray, sql as dsql } from "drizzle-orm";

import { createDbClient } from "./client";
import { parseEmbedResponse } from "./embed-response";
import { jobDomainAliases, jobDomains } from "./schema";

config({ path: "../../.env" });

const SCRIPT = "embed:domains";

/** Attach the ai-service bearer when the env provides one (required once the service
 *  sets AI_INTERNAL_TOKEN; absent = the historical open dev posture). */
const AI_HEADERS: Record<string, string> = { "content-type": "application/json" };
if (process.env.AI_INTERNAL_TOKEN) AI_HEADERS["x-ai-internal-token"] = process.env.AI_INTERNAL_TOKEN;

const BATCH_SIZE = Math.max(1, Math.min(200, Number(process.env.EMBED_BATCH_SIZE) || 100));
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
/** Recorded in `embedding_model` when the ai-service reports a mock run, so the
 *  `--reset-mock-embeddings` recovery has something unambiguous to match on. */
const MOCK_MODEL_TAG = "mock-embedding";

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error(`[${SCRIPT}] refusing to embed in production (run is gated ops).`);
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);
  const aiBase = process.env.AI_SERVICE_URL ?? "http://localhost:8000";

  const onlySelectable = process.argv.includes("--only-selectable");
  const resetAll = process.argv.includes("--reset-embeddings");
  const resetMock = process.argv.includes("--reset-mock-embeddings");

  if (resetAll || resetMock) {
    const { db, sql } = createDbClient(url, { max: 1 });
    try {
      // The surgical recovery this table can do and `skill_alias` cannot: drop ONLY the
      // vectors a mock run wrote, keeping every real one that was actually paid for.
      const where = resetAll
        ? isNotNull(jobDomainAliases.embedding)
        : and(isNotNull(jobDomainAliases.embedding), eq(jobDomainAliases.embeddingModel, MOCK_MODEL_TAG));
      const reset = await db
        .update(jobDomainAliases)
        .set({ embedding: null, embeddingModel: null, embeddedAt: null })
        .where(where)
        .returning({ id: jobDomainAliases.id });
      console.log(
        `[${SCRIPT}] reset (${resetAll ? "ALL" : "mock only"}) — ${reset.length} embeddings NULLed; re-run the backfill.`,
      );
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
    // Retrieval only ever queries selectable rows, so `--only-selectable` is the way to
    // get a USABLE index for the smallest spend — bucket rows can be embedded later or
    // never. Scoped with a subquery rather than a join so the NULL-only + not-blocked
    // window logic below stays identical on both paths.
    const selectableIds = onlySelectable
      ? (
          await db
            .select({ id: jobDomains.jobDomainId })
            .from(jobDomains)
            .where(and(eq(jobDomains.selectable, true), eq(jobDomains.status, "active")))
        ).map((r) => r.id)
      : null;

    if (selectableIds !== null && selectableIds.length === 0) {
      console.log(`[${SCRIPT}] --only-selectable: no selectable domains — seed the catalog first.`);
      return;
    }

    // Strictly progress-or-stop: each batch either embeds >=1 row (leaves the NULL set),
    // adds >=1 id to `blocked` (excluded from the next fetch), or ABORTS — never loops.
    for (;;) {
      const conditions = [isNull(jobDomainAliases.embedding)];
      if (blocked.length > 0) conditions.push(notInArray(jobDomainAliases.id, blocked));
      if (selectableIds !== null) conditions.push(inArray(jobDomainAliases.jobDomainId, selectableIds));

      const rows = await db
        .select({ id: jobDomainAliases.id, text: jobDomainAliases.text })
        .from(jobDomainAliases)
        .where(and(...conditions))
        .orderBy(jobDomainAliases.id)
        .limit(BATCH_SIZE);
      if (rows.length === 0) break;

      const resp = await fetch(`${aiBase}/embeddings/skill-alias`, {
        method: "POST",
        headers: AI_HEADERS,
        body: JSON.stringify({ items: rows.map((r) => ({ alias_id: r.id, text: r.text })) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!resp.ok) {
        throw new Error(`[${SCRIPT}] ai-service HTTP ${resp.status} — aborting (no partial guesswork)`);
      }
      const data = parseEmbedResponse(await resp.json(), new Set(rows.map((r) => r.id)));
      model = data.model;
      isMock = data.is_mock;
      providerErrors += data.errors;
      costInr += data.estimated_cost_inr;

      // The provenance the skill table lacks. `is_mock` is authoritative over the model
      // string: a mock run may still report a model name, and mislabelling a hash vector
      // as real is exactly the confusion these columns exist to prevent.
      const provenance = data.is_mock ? MOCK_MODEL_TAG : data.model || "unknown";
      const embeddedAt = new Date();

      let savedThisBatch = 0;
      let blockedThisBatch = 0;
      for (const r of data.results) {
        if (r.blocked || r.vector === null) {
          blocked.push(r.alias_id);
          blockedThisBatch += 1;
          continue;
        }
        await db
          .update(jobDomainAliases)
          .set({ embedding: r.vector, embeddingModel: provenance, embeddedAt })
          .where(eq(jobDomainAliases.id, r.alias_id));
        embedded += 1;
        savedThisBatch += 1;
      }

      if (data.budget_stopped) {
        // The endpoint's per-request INR ceiling fired. Stop the whole run — remaining
        // rows stay NULL; re-run later (or raise the ceiling).
        budgetStopped = true;
        break;
      }
      if (savedThisBatch === 0 && blockedThisBatch === 0) {
        // Nothing embedded, nothing newly excluded: the next fetch would return the SAME
        // rows — abort, don't loop.
        throw new Error(
          `[${SCRIPT}] batch made no progress (provider errors=${data.errors}) — aborting; rows stay NULL, re-run later`,
        );
      }
      if (rows.length < BATCH_SIZE) break;
    }

    const remainingRows = await db
      .select({ remaining: dsql<number>`count(*)::int` })
      .from(jobDomainAliases)
      .where(isNull(jobDomainAliases.embedding));
    const remaining = remainingRows[0]?.remaining ?? 0;

    console.log(
      `[${SCRIPT}] done — embedded=${embedded} blocked=${blocked.length} providerErrors=${providerErrors} ` +
        `budgetStopped=${budgetStopped} estCostInr=${costInr.toFixed(6)} model=${model || "(none fetched)"} mock=${isMock}`,
    );
    console.log(`[${SCRIPT}] aliases still NULL across the whole table: ${remaining}`);
    if (budgetStopped) {
      console.log(`[${SCRIPT}] BUDGET STOP — remaining rows left NULL; re-run to resume.`);
    }
    if (blocked.length > 0) {
      console.log(`[${SCRIPT}] blocked alias ids (left NULL, inspect + fix source text):`);
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
