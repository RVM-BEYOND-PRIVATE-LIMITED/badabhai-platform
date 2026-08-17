/**
 * Taxonomy retrieval evaluation harness (Phase 4).
 *
 *   pnpm db:eval:taxonomy --validate-fixture   # OFFLINE. Ground truth vs the corpus.
 *   pnpm db:eval:taxonomy --plan               # DB read-only. What would run, and on what.
 *   pnpm db:eval:taxonomy --run                # The measurement. REFUSES on mock vectors.
 *
 * ---------------------------------------------------------------------------
 * IT NEVER EMBEDS THE CORPUS
 * ---------------------------------------------------------------------------
 * An evaluation that can create the state it measures is not an evaluation. This harness
 * writes NOTHING to `skill`, `skill_alias` or `job_domain_skill` — no mode, no flag. Corpus
 * embedding is `db:embed:skills` and stays there. `--run` embeds the QUERY strings only
 * (they are not persisted), and it reads the corpus vectors that already exist.
 *
 * ---------------------------------------------------------------------------
 * WHY IT REFUSES TO SCORE MOCK VECTORS
 * ---------------------------------------------------------------------------
 * The default embedder is `_mock_embedding` — a sha256 hash, whose own docstring says "NOT
 * semantically meaningful". Two properties make reporting Recall over it actively harmful:
 *
 *   - identical text hashes to an identical vector, so every `exact_alias` case scores a
 *     perfect 1.0 at distance zero, and
 *   - nothing else is near anything, so every paraphrase is noise.
 *
 * The result is a report that reads ~40% Recall@1 and means nothing at all. That number
 * would be quoted. So `--run` classifies the stored vectors first and refuses if any are
 * mock, rather than producing it.
 *
 * DETECTION IS TWO-LAYER, AND THE PRIMARY LAYER IS THE PROVENANCE COLUMN.
 *
 *   1. `skill_alias.embedding_model` / `embedded_at` (migration 0076). `embed-skill-aliases.ts`
 *      now stamps them, as `embed-job-domain-aliases.ts` always has. `--run` requires EVERY
 *      embedded row to carry a non-null model, requires them all to agree, and refuses the
 *      `mock-embedding` sentinel. This is what catches the case a hash cannot: a corpus
 *      embedded across TWO DIFFERENT REAL models, where every vector is "not mock" and the
 *      space is still incoherent.
 *   2. A sha256 recompute of `_mock_embedding(alias.text)`, as corroboration. It proves
 *      mock-ness positively and is what covers rows written before the stamp existed.
 *
 * Layer 2 alone is not sufficient, and its limits are worth stating: it hashes the RAW text
 * while the service hashes the PSEUDONYMIZED text, so an alias the pseudonymizer rewrites
 * would classify NOT_MOCK. That is identity over today's trade vocabulary (verified: 197/197
 * detected) but the suffix list contains words like "Precision", "Tools" and "Engineering"
 * that generated batches will produce. Hence layer 1 is the gate and layer 2 the witness —
 * "not mock" from layer 2 alone is an inference, never proof a real provider was used.
 *
 * ---------------------------------------------------------------------------
 * WHY THE RETRIEVAL SQL IS HERE AND NOT CALLED THROUGH /skills/canonicalize
 * ---------------------------------------------------------------------------
 * `POST /skills/canonicalize` is the production path and would be the right thing to call,
 * but its response contract returns ONE match (`skill_id` + `score`) or `unresolved`.
 * Recall@3, Recall@5 and MRR need the ranked candidate list, which that contract does not
 * expose — and widening it is a change to a shipped AI contract, which this phase may not
 * make. So the harness issues the same scoped ANN query directly.
 *
 * That duplication is a real coupling and is treated as one. `CANONICAL_RETRIEVAL_SQL` is
 * the string `--run` ACTUALLY EXECUTES — not a look-alike constant sitting beside a separate
 * inline query, which is what it was until a reviewer pointed out that a "divergence pin"
 * over an unexecuted string pins nothing. It carries the same load-bearing clauses as
 * `skills.repository.ts` — the `job_domain_skill` join, `status = 'active'`,
 * `embedding IS NOT NULL`, and the bare `ORDER BY <=> ... LIMIT` that is the only shape an
 * HNSW index serves — and the test READS `skills.repository.ts` from disk and requires both
 * to contain each clause, so production moving fails the build rather than silently leaving
 * the harness measuring a different query.
 */
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { config } from "dotenv";
import { sql as dsql } from "drizzle-orm";

import { createDbClient } from "./client";
import { parseEmbedResponse } from "./embed-response";
import {
  fixtureDistribution,
  loadEvalFixture,
  validateEvalFixture,
  type EvalCase,
  type EvalFixture,
} from "./taxonomy-eval-fixture";
import {
  evaluateCase,
  summarizeBy,
  type MetricSummary,
  type RetrievedRow,
  type ScoredCase,
} from "./taxonomy-retrieval-metrics";
import { loadTaxonomyCorpus, TAXONOMY_DATA_DIR } from "./taxonomy-corpus";

config({ path: "../../.env" });

const SCRIPT = "eval:taxonomy";
export const EMBEDDING_DIMENSION = 768;
export const DEFAULT_FIXTURE = join(TAXONOMY_DATA_DIR, "eval", "retrieval-v1.jsonl");
/** Categories excluded from headline Recall/MRR — they measure coverage, not ranking. */
export const COVERAGE_ONLY_CATEGORIES = new Set(["unembedded_shipped"]);
/** Sentinel written to `skill_alias.embedding_model` for a mock vector. */
export const MOCK_MODEL_TAG = "mock-embedding";
/**
 * Alias rows fetched per requested SKILL.
 *
 * `LIMIT k` would cap ALIAS rows; `rankSkills` then collapses a skill's several aliases into
 * one entry, so a top-5 alias fetch routinely yields 3–4 skills. Measured on this corpus,
 * `LIMIT 5` produced a mean of 4.09 distinct skills — i.e. "Recall@5" was really Recall@2–5,
 * varying per query with ALIAS DENSITY rather than retrieval quality, which is exactly what
 * the per-domain breakdown exists to compare. Overfetching decouples the two.
 */
export const ALIAS_OVERFETCH = 8;

/** Thrown when the ai-service hands back a mock QUERY vector; aborts the run, never scores. */
export class MockQueryEmbedding extends Error {
  constructor() {
    super("ai-service returned a mock query embedding");
    this.name = "MockQueryEmbedding";
  }
}

// ===========================================================================
// Mock-embedding detection
// ===========================================================================

/**
 * Reproduce `apps/ai-service/app/ai/embeddings.py::_mock_embedding` exactly.
 *
 * sha256(`${text}:${counter}`) -> 8 big-endian uint32 per digest -> `(n / 2^32) * 2 - 1`,
 * counter incrementing until 768 values exist. Ported rather than imported because the
 * original is Python in another service. The test "MATCHES the Python implementation" pins
 * it against a golden vector taken from a row the real service actually wrote.
 */
export function mockEmbedding(text: string): number[] {
  const out: number[] = [];
  let counter = 0;
  while (out.length < EMBEDDING_DIMENSION) {
    const digest = createHash("sha256").update(`${text}:${counter}`, "utf8").digest();
    for (let i = 0; i + 4 <= digest.length; i += 4) {
      out.push((digest.readUInt32BE(i) / 2 ** 32) * 2 - 1);
    }
    counter += 1;
  }
  return out.slice(0, EMBEDDING_DIMENSION);
}

/** `MOCK` is proof; `NOT_MOCK` is only the absence of that proof. */
export type EmbeddingProvenance = "MOCK" | "NOT_MOCK";

/**
 * Does `stored` reproduce the mock vector for `text`?
 *
 * Tolerance is float32-sized because pgvector stores `real`, so a float64 mock loses
 * precision on the way in. 1e-6 absolute is far tighter than any collision could survive
 * across 768 independent dimensions and far looser than float32 rounding.
 */
export function classifyEmbedding(text: string, stored: readonly number[]): EmbeddingProvenance {
  if (stored.length !== EMBEDDING_DIMENSION) return "NOT_MOCK";
  const expected = mockEmbedding(text);
  for (let i = 0; i < EMBEDDING_DIMENSION; i += 1) {
    if (Math.abs((expected[i] as number) - (stored[i] as number)) > 1e-6) return "NOT_MOCK";
  }
  return "MOCK";
}

export interface ProvenanceReport {
  embedded: number;
  mock: number;
  notMock: number;
  /** Alias ids proven mock — named so an operator can act, capped for readability. */
  sampleMockAliasIds: string[];
  /** Distinct non-null `embedding_model` values across embedded rows. */
  models: string[];
  /** Embedded rows with NO model stamp — written before the stamp existed. */
  unstamped: number;
}

/** Why `--run` may not proceed. `null` = it may. */
export function corpusBlockReason(p: ProvenanceReport): string | null {
  if (p.embedded === 0) return "no embedded aliases at all — run db:embed:skills first";
  if (p.mock > 0) return `${p.mock} of ${p.embedded} embedded aliases are PROVEN MOCK (sha256 recompute)`;
  if (p.models.includes(MOCK_MODEL_TAG)) return `embedding_model is '${MOCK_MODEL_TAG}' — the corpus is mock`;
  if (p.unstamped > 0) {
    return (
      `${p.unstamped} embedded alias(es) carry no embedding_model. Provenance is unknown, so a ` +
      `mock or foreign-model vector cannot be ruled out. Re-embed: db:embed:skills --reset-embeddings`
    );
  }
  if (p.models.length > 1) {
    // Every vector is "not mock" and the space is still incoherent — the failure a hash
    // check structurally cannot see.
    return `the corpus mixes ${p.models.length} embedding models (${p.models.join(", ")}) — one vector space per run`;
  }
  return null;
}

/** Classify every embedded alias, by stamp AND by recompute. */
export function classifyAll(
  rows: readonly { id: string; text: string; embedding: number[]; embedding_model?: string | null }[],
): ProvenanceReport {
  const mock: string[] = [];
  let notMock = 0;
  let unstamped = 0;
  const models = new Set<string>();
  for (const r of rows) {
    if (classifyEmbedding(r.text, r.embedding) === "MOCK") mock.push(r.id);
    else notMock += 1;
    const m = r.embedding_model ?? null;
    if (m === null || m.length === 0) unstamped += 1;
    else models.add(m);
  }
  return {
    embedded: rows.length,
    mock: mock.length,
    notMock,
    sampleMockAliasIds: mock.slice(0, 5),
    models: [...models].sort(),
    unstamped,
  };
}

// ===========================================================================
// Retrieval
// ===========================================================================

/**
 * The canonical scoped ANN query — same shape as `SkillsRepository.nearestAliasesByJobDomain`.
 *
 * Pinned by test. If production changes, this must change with it, and the test is what
 * makes that a failure rather than a slow drift into measuring a different system.
 */
export const CANONICAL_RETRIEVAL_SQL = `
  SELECT sa.skill_id AS skill_id, 1 - (sa.embedding <=> $1::vector) AS score
  FROM skill_alias sa
  JOIN job_domain_skill jds ON jds.skill_id = sa.skill_id
  WHERE jds.job_domain_id = $2
    AND jds.status = 'active'
    AND sa.embedding IS NOT NULL
  ORDER BY sa.embedding <=> $1::vector
  LIMIT $3
`;

/** Langfuse availability, reported rather than assumed. */
export type LangfuseStatus = "LANGFUSE_CONFIGURED" | "LANGFUSE_NOT_CONFIGURED";

export function langfuseStatus(env: NodeJS.ProcessEnv = process.env): LangfuseStatus {
  return env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY
    ? "LANGFUSE_CONFIGURED"
    : "LANGFUSE_NOT_CONFIGURED";
}

/**
 * The evaluation record — the shape a Langfuse run/trace would carry.
 *
 * Built and emitted to stdout/JSON regardless of whether Langfuse is reachable. When it is
 * not, `langfuse` reads LANGFUSE_NOT_CONFIGURED and the run still completes: a missing
 * observability backend must not decide whether a measurement happened. Nothing here is
 * fabricated — every cost/token field is either measured or explicitly null.
 */
export interface EvalRunRecord {
  run_id: string;
  fixture_id: string;
  fixture_version: number;
  corpus_batch: string;
  embedding_model: string | null;
  embedding_provenance: ProvenanceReport;
  langfuse: LangfuseStatus;
  /** EXECUTED query count. Differs from `planned_query_count` when embeds failed. */
  query_count: number;
  planned_query_count: number;
  /** Judging depth. Recall@N above this is reported null, not guessed. */
  k: number;
  alias_overfetch: number;
  /** `hnsw.ef_search` in effect. Changes ANN recall, so a metric without it is unreproducible. */
  hnsw_ef_search: string | null;
  /** Share of scored queries whose text IS a committed alias of the expected skill.
   *  Derived from CONTENT, not from the category label — a high value means the headline
   *  Recall has a floor that retrieval did not earn. */
  exact_alias_query_share: number;
  /** Wall clock for the whole loop: N sequential HTTP embeds PLUS N SQL queries. NOT
   *  per-query retrieval latency, and must never be quoted as one. */
  latency_ms: number | null;
  overall: MetricSummary | null;
  by_category: Record<string, MetricSummary>;
  by_domain: Record<string, MetricSummary>;
  /** The unembedded-shipped probe: reachability, not ranking. */
  coverage_probe: { case_id: string; expected_skill_id: string | null; retrieved: boolean }[];
  errors: number;
  budget_stopped: boolean;
  /** Measured, or null. NEVER estimated into this field. */
  actual_cost_inr: number | null;
  actual_tokens: number | null;
  /** The ai-service's OWN estimate, summed. An estimate, never presented as spend. */
  provider_estimated_cost_inr: number;
  /** Provider embed REQUESTS this run issued — one per query, each counting against the
   *  documented per-day request quota that has stalled a corpus embed before. */
  embed_requests: number;
  notes: string[];
}

/** Split cases into the ones that score and the ones that only probe coverage. */
export function partitionCases(fixture: EvalFixture): { scored: EvalCase[]; coverageOnly: EvalCase[] } {
  return {
    scored: fixture.cases.filter((c) => !COVERAGE_ONLY_CATEGORIES.has(c.category)),
    coverageOnly: fixture.cases.filter((c) => COVERAGE_ONLY_CATEGORIES.has(c.category)),
  };
}

/** Turn one case + its retrieved rows into a scored entry for the aggregator. */
export function scoreCase(c: EvalCase, rows: readonly RetrievedRow[], k: number): ScoredCase {
  return {
    positive: c.expected_skill_id !== null,
    outcome: evaluateCase(
      {
        expected_skill_id: c.expected_skill_id,
        acceptable_skill_ids: c.acceptable_skill_ids,
        must_not_return_skill_ids: c.must_not_return_skill_ids,
      },
      rows,
      k,
    ),
  };
}

// ===========================================================================
// CLI
// ===========================================================================

function arg(argv: readonly string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
}

function printSummary(label: string, s: MetricSummary): void {
  const pct = (v: number | null): string => (v === null ? "  n/a" : `${(v * 100).toFixed(1)}%`);
  console.log(
    `  ${label.padEnd(28)} n=${String(s.queries).padStart(3)} scored=${String(s.scored).padStart(3)} ` +
      `R@1=${pct(s.recall_at_1)} R@3=${pct(s.recall_at_3)} R@5=${pct(s.recall_at_5)} ` +
      `MRR=${s.mrr === null ? " n/a" : s.mrr.toFixed(3)} leak=${pct(s.cross_domain_leakage_rate)} ` +
      `empty=${pct(s.no_result_rate)}`,
  );
}

async function main(): Promise<void> {
  const argv = process.argv;
  const fixturePath = arg(argv, "--fixture") ?? DEFAULT_FIXTURE;
  const kRaw = arg(argv, "--k");
  const k = kRaw === null ? 5 : Number(kRaw);
  if (!Number.isInteger(k) || k < 1) {
    // `--k abc` produced NaN, which reached the SQL as `LIMIT NaN`; `--k` trailing silently
    // fell back to 5. Both make the reported depth a different number from the measured one.
    throw new Error(`[${SCRIPT}] --k must be a positive integer, got ${JSON.stringify(kRaw)}`);
  }
  const fixture = loadEvalFixture(fixturePath);
  const corpus = loadTaxonomyCorpus();

  // Shipped ids: referenced by edges but not authored in the corpus files. Legal targets.
  const authored = new Set(corpus.skills.map((s) => s.skill_id));
  const shipped = new Set(corpus.edges.map((e) => e.skill_id).filter((id) => !authored.has(id)));

  const problems = validateEvalFixture(fixture, corpus, shipped);
  const dist = fixtureDistribution(fixture);

  console.log(`[${SCRIPT}] fixture ${fixture.manifest.fixture_id} v${fixture.manifest.version}`);
  console.log(`  cases                    = ${fixture.cases.length}`);
  console.log(`  corpus_batch             = ${fixture.manifest.corpus_batch}`);
  console.log(`  ground-truth problems    = ${problems.length}`);
  for (const p of problems.slice(0, 25)) console.log(`    ${p.code} [${p.case_id ?? "-"}] ${p.message}`);
  if (problems.length > 25) console.log(`    ... and ${problems.length - 25} more`);
  console.log(`  by category:`);
  for (const [c, n] of Object.entries(dist.byCategory)) console.log(`    ${c.padEnd(26)} ${n}`);
  console.log(`  languages                = ${JSON.stringify(dist.byLang)}`);
  console.log(`  domains covered          = ${Object.keys(dist.byDomain).length}`);
  console.log(`  langfuse                 = ${langfuseStatus()}`);

  if (problems.length > 0) {
    // The instrument is broken. Measuring with it produces a number that gets quoted.
    console.error(`[${SCRIPT}] FIXTURE INVALID — ${problems.length} problem(s). Refusing to evaluate.`);
    process.exitCode = 1;
    return;
  }

  if (argv.includes("--validate-fixture")) {
    console.log(`[${SCRIPT}] fixture VALID — every expected (domain, skill) pair is reachable in the corpus.`);
    return;
  }

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);
  const hasRunFlag = argv.includes("--run");
  const { db, sql } = createDbClient(url, { max: 1 });
  try {
    const embedded = (await db.execute(
      dsql`SELECT id::text AS id, text, embedding::text AS embedding, embedding_model
           FROM skill_alias WHERE embedding IS NOT NULL`,
    )) as unknown as { id: string; text: string; embedding: string; embedding_model: string | null }[];
    const parsed = embedded.map((r) => ({
      id: r.id,
      text: r.text,
      embedding: JSON.parse(r.embedding) as number[],
      embedding_model: r.embedding_model,
    }));
    const provenance = classifyAll(parsed);

    console.log(`[${SCRIPT}] embedding provenance (recomputed, not assumed):`);
    console.log(`  embedded aliases         = ${provenance.embedded}`);
    console.log(`  PROVEN MOCK              = ${provenance.mock}`);
    console.log(`  not mock (inference)     = ${provenance.notMock}`);
    console.log(`  embedding_model(s)       = ${provenance.models.length > 0 ? provenance.models.join(", ") : "(none stamped)"}`);
    console.log(`  unstamped rows           = ${provenance.unstamped}`);

    if (argv.includes("--plan")) {
      const { scored, coverageOnly } = partitionCases(fixture);
      console.log(`[${SCRIPT}] PLAN — nothing embedded, nothing written`);
      console.log(`  scoring queries          = ${scored.length}`);
      console.log(`  coverage-only queries    = ${coverageOnly.length} (${[...COVERAGE_ONLY_CATEGORIES].join(", ")})`);
      console.log(`  top-k                    = ${k}`);
      console.log(`  query embeds required    = ${scored.length + coverageOnly.length} (via the ai-service embed endpoint)`);
      const why = corpusBlockReason(provenance);
      console.log(`  would --run be allowed?  = ${why === null ? "YES" : `NO — ${why}`}`);
      return;
    }

    if (!argv.includes("--run")) {
      console.log(`[${SCRIPT}] no mode given. Use --validate-fixture | --plan | --run`);
      return;
    }

    // ── THE REFUSAL ─────────────────────────────────────────────────────────
    const blocked = corpusBlockReason(provenance);
    if (blocked !== null) {
      console.error(
        `[${SCRIPT}] REFUSING TO REPORT RETRIEVAL QUALITY.
` +
          `  ${blocked}.
` +
          `  Mock vectors are not semantically meaningful: identical text collides at distance 0
` +
          `  (so every exact-alias case scores 1.0) and nothing else is near anything (so every
` +
          `  paraphrase is noise). A mixed vector space is worse still — the distances are not
` +
          `  comparable at all. Either way the number would mean nothing and get quoted anyway.
` +
          (provenance.sampleMockAliasIds.length > 0
            ? `  e.g. alias ids: ${provenance.sampleMockAliasIds.join(", ")}
`
            : "") +
          `  Fix: configure a real embedding provider, then
` +
          `    pnpm db:embed:skills --reset-embeddings
` +
          `    pnpm db:embed:skills --batch <accepted-batch-dir>
` +
          `    pnpm db:eval:taxonomy --run`,
      );
      process.exitCode = 1;
      return;
    }

    const aiBase = process.env.AI_SERVICE_URL ?? "http://localhost:8000";
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (process.env.AI_INTERNAL_TOKEN) headers["x-ai-internal-token"] = process.env.AI_INTERNAL_TOKEN;

    // The fixture gate validated ground truth against the corpus FILES. Retrieval runs
    // against job_domain_skill. If the DB was seeded from an older batch, every case is
    // "VALID" on disk and unpassable in the database — and the shortfall reads as a model
    // failure. So the two are reconciled before any query is scored.
    const liveEdges = (await db.execute(
      dsql`SELECT job_domain_id, skill_id FROM job_domain_skill WHERE status = 'active'`,
    )) as unknown as { job_domain_id: string; skill_id: string }[];
    const liveSet = new Set(liveEdges.map((e) => `${e.job_domain_id} ${e.skill_id}`));
    const unreachable = fixture.cases.filter(
      (c) =>
        c.expected_skill_id !== null &&
        !COVERAGE_ONLY_CATEGORIES.has(c.category) &&
        !liveSet.has(`${c.job_domain_id} ${c.expected_skill_id}`),
    );
    console.log(`  live active edges        = ${liveSet.size}`);
    console.log(`  cases unreachable in DB  = ${unreachable.length}`);
    if (unreachable.length > 0 && hasRunFlag) {
      console.error(
        `[${SCRIPT}] the fixture and the DATABASE disagree. ${unreachable.length} case(s) name a ` +
          `(domain, skill) pair that is not an active edge in job_domain_skill, e.g. ` +
          `${unreachable.slice(0, 3).map((c) => `${c.case_id}:${c.job_domain_id}/${c.expected_skill_id}`).join(", ")}. ` +
          `Those cases are unpassable here, so the metrics would blame the model for a seeding gap. ` +
          `Seed the corpus this fixture was authored against (${fixture.manifest.corpus_batch}).`,
      );
      process.exitCode = 1;
      return;
    }

    const efRows = (await db.execute(dsql`SHOW hnsw.ef_search`)) as unknown as Record<string, string>[];
    const efSearch = efRows[0]?.["hnsw.ef_search"] ?? null;

    // CONTENT-derived, not label-derived. 16 cases outside the *_alias categories used a
    // committed alias verbatim, so the label-based "not stacked with easy cases" check read
    // 39% while the true exact-match share was 55%. An exact alias is distance 0 and rank 1
    // for any deterministic embedder, so that share is a FLOOR under Recall@1 that retrieval
    // did not earn. It belongs in the record next to the number it inflates.
    const aliasTexts = new Map<string, Set<string>>();
    for (const sk of corpus.skills) aliasTexts.set(sk.skill_id, new Set(sk.aliases.map((a) => a.text)));
    const isExactAliasQuery = (c: EvalCase): boolean =>
      c.expected_skill_id !== null && (aliasTexts.get(c.expected_skill_id)?.has(c.query) ?? false);

    const started = Date.now();
    let errors = 0;
    let attempted = 0;
    let budgetStopped = false;
    let estimatedCostInr = 0;
    let model: string | null = null;
    const scoredCases: (ScoredCase & { group: string })[] = [];
    const byDomain: (ScoredCase & { group: string })[] = [];
    const { scored, coverageOnly } = partitionCases(fixture);
    const coverage: { case_id: string; expected_skill_id: string | null; retrieved: boolean }[] = [];

    /** One query -> its ranked skills, or null when the embed failed. */
    const retrieve = async (c: EvalCase): Promise<RetrievedRow[] | null> => {
      attempted += 1;
      // Query embeds are NOT persisted. The alias_id is a synthetic per-case handle the
      // endpoint echoes back; nothing is written to any table.
      const resp = await fetch(`${aiBase}/embeddings/skill-alias`, {
        method: "POST",
        headers,
        body: JSON.stringify({ items: [{ alias_id: EVAL_QUERY_UUID, text: c.query }] }),
      });
      if (!resp.ok) {
        errors += 1;
        return null;
      }
      const data = parseEmbedResponse(await resp.json(), new Set([EVAL_QUERY_UUID]));
      model = data.model;
      estimatedCostInr += data.estimated_cost_inr;
      if (data.is_mock) throw new MockQueryEmbedding();
      if (data.budget_stopped) {
        // HTTP 200 with an empty result set. Scoring this as an ordinary miss would report
        // a retrieval failure for what is actually an exhausted spend ledger.
        budgetStopped = true;
        errors += 1;
        return null;
      }
      const vec = data.results[0]?.vector ?? null;
      if (vec === null) {
        errors += 1;
        return null;
      }
      const q = JSON.stringify(vec);
      // Executes CANONICAL_RETRIEVAL_SQL ITSELF. It used to be a separate inline template
      // that merely resembled the constant, so the "divergence pin" test asserted about a
      // string nothing ran — a change to the executed query would not have failed anything.
      const rows = (await sql.unsafe(CANONICAL_RETRIEVAL_SQL, [q, c.job_domain_id, k * ALIAS_OVERFETCH])) as unknown as RetrievedRow[];
      return rows;
    };

    try {
      for (const c of scored) {
        const rows = await retrieve(c);
        if (rows === null) continue;
        const sc = scoreCase(c, rows, k);
        scoredCases.push({ ...sc, group: c.category });
        byDomain.push({ ...sc, group: c.job_domain_id });
      }
      // The coverage probe is RUN, not merely declared. It answers a different question —
      // "is this shipped skill reachable at all?" — and stays out of Recall/MRR.
      for (const c of coverageOnly) {
        const rows = await retrieve(c);
        coverage.push({
          case_id: c.case_id,
          expected_skill_id: c.expected_skill_id,
          retrieved: rows !== null && rows.some((r) => r.skill_id === c.expected_skill_id),
        });
      }
    } catch (e) {
      if (e instanceof MockQueryEmbedding) {
        console.error(`[${SCRIPT}] the ai-service returned a MOCK query embedding — refusing to score.`);
        process.exitCode = 1;
        return;
      }
      throw e;
    }

    const executed = scoredCases.length;
    const record0ExactShare =
      scored.length === 0 ? 0 : scored.filter(isExactAliasQuery).length / scored.length;
    const cat = summarizeBy(scoredCases, k);
    const dom = summarizeBy(byDomain, k);
    const record: EvalRunRecord = {
      // Unique per run. A constant id collides the moment two runs are stored or uploaded,
      // which is the one thing a run identifier exists to prevent.
      run_id: `eval-${fixture.manifest.fixture_id}-v${fixture.manifest.version}-${new Date().toISOString()}`,
      fixture_id: fixture.manifest.fixture_id,
      fixture_version: fixture.manifest.version,
      corpus_batch: fixture.manifest.corpus_batch,
      embedding_model: model,
      embedding_provenance: provenance,
      langfuse: langfuseStatus(),
      // EXECUTED, not planned. Reporting the planned count while 40 queries failed would
      // describe a run that did not happen.
      query_count: executed,
      planned_query_count: scored.length,
      k,
      alias_overfetch: ALIAS_OVERFETCH,
      hnsw_ef_search: efSearch,
      exact_alias_query_share:
        scored.length === 0
          ? 0
          : Math.round((scored.filter(isExactAliasQuery).length / scored.length) * 10_000) / 10_000,
      latency_ms: Date.now() - started,
      overall: cat.overall,
      by_category: cat.groups,
      by_domain: dom.groups,
      coverage_probe: coverage,
      errors,
      budget_stopped: budgetStopped,
      actual_cost_inr: null,
      actual_tokens: null,
      provider_estimated_cost_inr: estimatedCostInr,
      embed_requests: attempted,
      notes: [
        "actual_cost_inr/actual_tokens are null: this harness does not meter providers. " +
          "provider_estimated_cost_inr is the ai-service's own ESTIMATE summed across query " +
          "embeds — an estimate, never presented as spend.",
        "Each query embed is a separate POST /embeddings/skill-alias, which the ai-service " +
          "traces as task_type=skill_embedding and bills to the shared SpendLedger. Eval " +
          "runs therefore appear alongside corpus embedding in Langfuse and consume the " +
          "provider's per-day REQUEST quota. Attribute accordingly.",
        langfuseStatus() === "LANGFUSE_NOT_CONFIGURED"
          ? "Langfuse keys absent — no traces were emitted. The metrics here are still real."
          : "Langfuse configured; query embeds trace as skill_embedding.",
      ],
    };

    console.log(`[${SCRIPT}] RESULTS  (k=${k}, model=${model ?? "unknown"})`);
    console.log(`  queries executed         = ${executed} / ${scored.length} planned`);
    console.log(`  errors                   = ${errors}${budgetStopped ? "  (BUDGET STOPPED)" : ""}`);
    console.log(
      `  exact-alias query share  = ${(record0ExactShare * 100).toFixed(1)}%  <- a floor under R@1 ` +
        `that retrieval did not earn`,
    );
    printSummary("OVERALL", cat.overall);
    console.log(`  by category:`);
    for (const [g, s] of Object.entries(cat.groups)) {
      printSummary(`  ${g}`, s);
      if (g === "cross_domain_isolation") {
        console.log(
          `      ^ STRUCTURAL: every forbidden id here is out of scope, so the ` +
            `job_domain_skill join makes a leak impossible. This is a regression guard on ` +
            `scoping, NOT a measured leakage rate. Measured leakage lives in lexical_ambiguity.`,
        );
      }
    }
    console.log(`  by domain:`);
    for (const [g, s] of Object.entries(dom.groups)) printSummary(`  ${g}`, s);
    if (coverage.length > 0) {
      const reachable = coverage.filter((c) => c.retrieved).length;
      console.log(`  coverage probe (unembedded shipped): ${reachable}/${coverage.length} reachable`);
      for (const c of coverage) console.log(`    ${c.case_id} ${c.expected_skill_id} -> ${c.retrieved ? "reachable" : "NOT reachable"}`);
    }
    console.log(JSON.stringify(record, null, 2));

    if (errors > 0) {
      // A run that measured a biased surviving subset must not exit 0. Failed queries
      // vanish from numerator AND denominator, so the metrics describe whichever queries
      // happened to succeed — that is a partial result and the exit code has to say so.
      console.error(`[${SCRIPT}] ${errors} query/queries failed — metrics cover the surviving subset only.`);
      process.exitCode = 1;
    }
  } finally {
    await sql.end();
  }
}

/** Synthetic handle for a query embed. A fixed UUID, never written to any table. */
export const EVAL_QUERY_UUID = "00000000-0000-4000-8000-000000000000";

if (process.argv[1] && /taxonomy-retrieval-eval\.ts$/.test(process.argv[1])) {
  if (!existsSync(DEFAULT_FIXTURE) && !process.argv.includes("--fixture")) {
    console.error(`[${SCRIPT}] default fixture missing at ${DEFAULT_FIXTURE}`);
    process.exit(1);
  }
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
