/**
 * Prove — not assume — which model produced an unstamped embedding, then stamp only what was
 * proven.
 *
 * ===========================================================================
 * WHY A PLAIN "STAMP BACKFILL" IS THE WRONG SHAPE
 * ===========================================================================
 * `corpusBlockReason` blocks retrieval scoring while any embedded alias carries no
 * `embedding_model`, because *"a mock or foreign-model vector cannot be ruled out."* The
 * tempting fix is an UPDATE that writes the model everyone believes was used. That fix is worse
 * than the problem: it converts *unknown* provenance into *asserted* provenance, the gate stops
 * asking, and the one failure the gate exists to catch — a corpus split across two real models,
 * whose cosines are meaningless while looking entirely normal — becomes permanently invisible.
 *
 * `classifyEmbedding` cannot help here either. Recomputing the deterministic `_mock_embedding`
 * rules out MOCK, and that is genuinely worth having, but two REAL models both produce vectors
 * that are "not mock". Mock-detection is structurally blind to exactly the case that matters.
 *
 * ===========================================================================
 * WHAT ACTUALLY CONSTITUTES PROOF
 * ===========================================================================
 * The embedder is deterministic for a given model, and `taxonomy-embed-cache.ts` records the
 * measured consequence: embedding the text of a stored alias reproduces that alias's stored
 * vector at cosine 1.0000. So if a vector of KNOWN model, for the SAME text, sits at cosine ~1
 * against the unstamped vector, the unstamped vector came from that model. This is a proof, not
 * an inference, and the separation is not marginal — measured on this corpus, unrelated text
 * pairs sit at cosine 0.43–0.78 while same-text/same-model pairs sit at 1.0 to within 2e-8.
 * There is no plausible reading in which those two populations are confused.
 *
 * A reference vector of known model comes from, in precedence order:
 *   1. `--reference-file=<json>` — a dump of stamped rows. Zero provider cost, and the only
 *      option when the reference database is reachable but not from where this runs (a docker
 *      volume with an unknown password, a bastioned host, a colleague's export).
 *   2. REFERENCE_DATABASE_URL — a second database whose rows ARE stamped. Zero provider cost.
 *   3. the local embed cache — keyed by model, so a hit is model-attributed by construction.
 *
 * Produce a reference file with:
 *   psql "$REF" -tAc "COPY (SELECT json_agg(row_to_json(t)) FROM (SELECT text, embedding_model,
 *     embedding::text AS embedding FROM skill_alias WHERE embedding IS NOT NULL
 *     AND embedding_model IS NOT NULL) t) TO STDOUT" > reference.json
 *
 * DELIBERATELY NOT A THIRD SOURCE: the provider itself. Calling it would work, and for a row
 * with no reference it is the only thing that would, but it costs one request per text against
 * a per-day REQUEST quota, and it puts a spend path inside a verification tool. Rows with no
 * reference are reported as NO_REFERENCE and left alone — that is a true statement about the
 * corpus, and re-embedding (`db:embed:skills --reset-embeddings`) is the honest remedy.
 *
 * ===========================================================================
 * WHAT IS AND IS NOT WRITTEN
 * ===========================================================================
 * `--apply` writes `embedding_model` on PROVEN rows only. It never writes on MISMATCH,
 * NO_REFERENCE or MOCK rows, and it never touches `embedding` itself.
 *
 * `embedded_at` is deliberately left NULL. It records WHEN a vector was written, nobody knows
 * when these were, and inventing a timestamp to make a column look populated is the same
 * fabrication this script exists to avoid. A NULL `embedded_at` beside a proven
 * `embedding_model` is the accurate state: we know what produced it, not when.
 *
 * Usage:
 *   pnpm db:verify:embeddings                  # plan — reads only, writes nothing
 *   pnpm db:verify:embeddings --apply          # stamp the PROVEN rows
 *   pnpm db:verify:embeddings --json=<path>    # evidence record
 */
import { config } from "dotenv";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { sql as dsql } from "drizzle-orm";

import { createDbClient } from "./client";
import { DEFAULT_CACHE_DIR } from "./taxonomy-embed-cache";
import { classifyEmbedding } from "./taxonomy-retrieval-eval";
import { hostClass } from "./audit-embedding-provenance";

config();

const SCRIPT = "verify:embeddings";

/** The one vocabulary this script verifies. Named for the evidence record; the queries below
 *  spell it out literally rather than interpolating, so no table name is ever built at runtime. */
const TABLE = "skill_alias";

/**
 * Cosine at or above which two vectors are the same vector.
 *
 * Not a tuned knob. Measured on this corpus: same-text/same-model pairs land in
 * [0.999999978, 1.000000023] (float noise around exactly 1), unrelated pairs in [0.434, 0.783].
 * Anything between 0.79 and 0.9999 would be a result nobody has ever seen here, and the right
 * response to it is to refuse and report, which is what MISMATCH does.
 */
export const PROVEN_COSINE_FLOOR = 0.99999;

export type Verdict = "PROVEN" | "MISMATCH" | "NO_REFERENCE" | "MOCK";

export interface RowVerdict {
  id: string;
  verdict: Verdict;
  /** The model proven, when the verdict is PROVEN. */
  model: string | null;
  /** Cosine against the reference, when one existed. */
  cosine: number | null;
  /** Where the reference came from — so the evidence names its own basis. */
  source: string | null;
}

export interface ReferenceVector {
  vector: number[];
  model: string;
  source: string;
}

/** Both corpora are L2-normalized, so this is also the cosine. Kept explicit anyway. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/**
 * The whole decision for one row. Pure, so the rules are testable without a database or a
 * provider — which matters more here than usual, because the failure mode of getting this
 * wrong is a stamp that lies.
 */
export function verifyRow(
  row: { id: string; text: string; embedding: readonly number[] },
  reference: ReferenceVector | undefined,
): RowVerdict {
  // Checked FIRST and independently of the reference. A mock vector must never be stamped with
  // a real model name even if some reference happens to agree with it — two mock vectors of the
  // same text are identical, so a mock reference would "prove" a mock row at cosine 1.
  if (classifyEmbedding(row.text, row.embedding) === "MOCK") {
    return { id: row.id, verdict: "MOCK", model: null, cosine: null, source: null };
  }
  if (reference === undefined) {
    return { id: row.id, verdict: "NO_REFERENCE", model: null, cosine: null, source: null };
  }
  const c = cosine(row.embedding, reference.vector);
  if (c >= PROVEN_COSINE_FLOOR) {
    return { id: row.id, verdict: "PROVEN", model: reference.model, cosine: c, source: reference.source };
  }
  return { id: row.id, verdict: "MISMATCH", model: null, cosine: c, source: reference.source };
}

/** Counts by verdict, plus the distinct models proven. */
export function summarize(verdicts: readonly RowVerdict[]): {
  proven: number;
  mismatch: number;
  noReference: number;
  mock: number;
  models: string[];
  minProvenCosine: number | null;
} {
  const models = new Set<string>();
  let min: number | null = null;
  let proven = 0;
  let mismatch = 0;
  let noReference = 0;
  let mock = 0;
  for (const v of verdicts) {
    if (v.verdict === "PROVEN") {
      proven += 1;
      if (v.model !== null) models.add(v.model);
      if (v.cosine !== null && (min === null || v.cosine < min)) min = v.cosine;
    } else if (v.verdict === "MISMATCH") mismatch += 1;
    else if (v.verdict === "NO_REFERENCE") noReference += 1;
    else mock += 1;
  }
  return { proven, mismatch, noReference, mock, models: [...models].sort(), minProvenCosine: min };
}

/**
 * Stamping is refused wholesale — not row by row — when the proven rows disagree about the
 * model. Writing two model names into one vocabulary would record the mixed-space problem
 * accurately and then let `corpusBlockReason`'s "mixes N models" branch block everything, which
 * is correct but is a decision a human should make deliberately rather than discover afterwards.
 */
export function applyBlockReason(s: ReturnType<typeof summarize>): string | null {
  if (s.mock > 0) return `${s.mock} row(s) are PROVEN MOCK — stamping them would launder a mock corpus`;
  if (s.mismatch > 0) {
    return (
      `${s.mismatch} row(s) MISMATCH their reference. A same-text reference that does not match ` +
      `means the vector came from somewhere else — re-embed rather than stamp`
    );
  }
  if (s.proven === 0) return "nothing was proven — no reference vectors matched";
  if (s.models.length > 1) return `the proven rows span ${s.models.length} models (${s.models.join(", ")})`;
  return null;
}

const sha = (t: string): string => createHash("sha256").update(t, "utf8").digest("hex");

/** Reference vectors from the local, model-keyed embed cache. */
function referencesFromCache(): Map<string, ReferenceVector> {
  const out = new Map<string, ReferenceVector>();
  const file = join(DEFAULT_CACHE_DIR, "vectors.json");
  if (!existsSync(file)) return out;
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, number[]>;
  for (const [key, vector] of Object.entries(raw)) {
    const i = key.lastIndexOf(":");
    if (i < 0) continue;
    // Keyed `${model}:${sha256(text)}` — the model attribution IS the key, which is why a
    // cache hit is admissible as a reference at all.
    out.set(key.slice(i + 1), { vector, model: key.slice(0, i), source: "embed-cache" });
  }
  return out;
}

/**
 * Reference vectors from a dumped file of stamped rows.
 *
 * Accepts `embedding` as either a JSON array or pgvector's `"[1,2,…]"` text form, because
 * `row_to_json` over an `embedding::text` cast produces the latter and making the operator
 * post-process it would be a footgun for no benefit.
 */
export function referencesFromFile(
  rows: readonly { text: string; embedding_model: string | null; embedding: unknown }[],
): Map<string, ReferenceVector> {
  const out = new Map<string, ReferenceVector>();
  for (const r of rows) {
    if (r.embedding_model === null || r.embedding_model.length === 0) continue;
    const vector =
      typeof r.embedding === "string" ? (JSON.parse(r.embedding) as number[]) : (r.embedding as number[]);
    if (!Array.isArray(vector)) continue;
    out.set(sha(r.text), { vector, model: r.embedding_model, source: "reference-file" });
  }
  return out;
}

/** Reference vectors from a second database whose rows carry a model stamp. */
async function referencesFromDatabase(url: string): Promise<Map<string, ReferenceVector>> {
  const out = new Map<string, ReferenceVector>();
  const { db, sql } = createDbClient(url, { max: 1 });
  try {
    const rows = (await db.execute(
      dsql`SELECT text, embedding::text AS embedding, embedding_model
           FROM skill_alias
           WHERE embedding IS NOT NULL AND embedding_model IS NOT NULL`,
    )) as unknown as { text: string; embedding: string; embedding_model: string }[];
    for (const r of rows) {
      out.set(sha(r.text), {
        vector: JSON.parse(r.embedding) as number[],
        model: r.embedding_model,
        source: "reference-db",
      });
    }
  } finally {
    await sql.end();
  }
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const jsonArg = argv.find((a) => a.startsWith("--json="));

  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);

  // Precedence, lowest first: an explicitly-configured source beats the incidental local cache,
  // because it is the one the operator chose. Later writes win, so build in reverse order.
  const references = referencesFromCache();
  const cacheCount = references.size;
  const refUrl = process.env["REFERENCE_DATABASE_URL"];
  let dbRefCount = 0;
  if (refUrl) {
    const fromDb = await referencesFromDatabase(refUrl);
    dbRefCount = fromDb.size;
    for (const [k, v] of fromDb) references.set(k, v);
  }
  const fileArg = argv.find((a) => a.startsWith("--reference-file="));
  let fileRefCount = 0;
  if (fileArg !== undefined) {
    const path = fileArg.slice("--reference-file=".length);
    if (!existsSync(path)) throw new Error(`[${SCRIPT}] --reference-file not found: ${path}`);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      text: string;
      embedding_model: string | null;
      embedding: unknown;
    }[];
    const fromFile = referencesFromFile(parsed);
    fileRefCount = fromFile.size;
    for (const [k, v] of fromFile) references.set(k, v);
  }

  const { db, sql } = createDbClient(url, { max: 1 });
  try {
    const [where] = (await db.execute(dsql`SELECT current_database() AS db`)) as unknown as { db: string }[];
    console.log(`[${SCRIPT}] ${apply ? "APPLY — will write embedding_model on PROVEN rows only" : "PLAN — nothing will be written"}`);
    console.log(`  target                   = ${hostClass(url)}  db=${where?.db ?? "?"}`);
    console.log(
      `  reference vectors        = ${references.size}  ` +
        `(cache ${cacheCount}, reference-db ${dbRefCount}, reference-file ${fileRefCount})`,
    );

    const rows = (await db.execute(
      dsql`SELECT id::text AS id, text, embedding::text AS embedding
           FROM skill_alias
           WHERE embedding IS NOT NULL AND embedding_model IS NULL`,
    )) as unknown as { id: string; text: string; embedding: string }[];
    console.log(`  embedded, unstamped      = ${rows.length}`);
    if (rows.length === 0) {
      console.log("  nothing to verify.");
      return;
    }

    const verdicts = rows.map((r) =>
      verifyRow(
        { id: r.id, text: r.text, embedding: JSON.parse(r.embedding) as number[] },
        references.get(sha(r.text)),
      ),
    );
    const s = summarize(verdicts);
    console.log(`\n  PROVEN                   = ${s.proven}${s.models.length > 0 ? `  (${s.models.join(", ")})` : ""}`);
    console.log(`  worst proven cosine      = ${s.minProvenCosine === null ? "-" : s.minProvenCosine.toFixed(12)}   (floor ${PROVEN_COSINE_FLOOR})`);
    console.log(`  MISMATCH                 = ${s.mismatch}`);
    console.log(`  NO_REFERENCE             = ${s.noReference}`);
    console.log(`  PROVEN MOCK              = ${s.mock}`);
    for (const v of verdicts.filter((x) => x.verdict === "MISMATCH").slice(0, 10)) {
      console.log(`     MISMATCH ${v.id} cosine=${v.cosine?.toFixed(6) ?? "-"} (${v.source ?? "-"})`);
    }

    const blocked = applyBlockReason(s);
    if (!apply) {
      console.log(`\n  would --apply be allowed? = ${blocked === null ? `YES — it would stamp ${s.proven} row(s)` : `NO — ${blocked}`}`);
    } else if (blocked !== null) {
      console.error(`\n[${SCRIPT}] REFUSING TO STAMP — ${blocked}. Nothing was written.`);
      process.exitCode = 1;
      return;
    } else {
      const model = s.models[0] as string;
      const ids = verdicts.filter((v) => v.verdict === "PROVEN").map((v) => v.id);
      // One statement, one transaction boundary, no per-row partial state. `embedded_at` is
      // left NULL on purpose — see the header.
      await db.execute(
        dsql`UPDATE skill_alias SET embedding_model = ${model}
             WHERE id::text = ANY(${ids}) AND embedding IS NOT NULL AND embedding_model IS NULL`,
      );
      console.log(`\n[${SCRIPT}] stamped ${ids.length} row(s) as ${model}. embedded_at left NULL (unknown, and not invented).`);
    }

    if (jsonArg !== undefined) {
      const path = jsonArg.slice("--json=".length);
      if (existsSync(path)) {
        console.error(`  refusing to overwrite ${path} — evidence is never replaced.`);
        process.exitCode = 1;
        return;
      }
      writeFileSync(
        path,
        `${JSON.stringify(
          {
            kind: "embedding-provenance-verification",
            target: { host_class: hostClass(url), database: where?.db ?? null },
            table: TABLE,
            applied: apply && blocked === null,
            cosine_floor: PROVEN_COSINE_FLOOR,
            summary: s,
            note: "Proof is same-text/known-model cosine, not assumption. Row ids are reference-vocabulary ids, not worker data.",
            verdicts,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      console.log(`  evidence written to ${path}`);
    }
  } finally {
    await sql.end();
  }
}

// GUARDED ENTRYPOINT — this module exports `verifyRow`, `cosine`, `summarize` and friends, so
// it is imported by its own test. Unguarded, that import RUNS the script: in CI it exits 1 on
// the absent DATABASE_URL, and on a laptop whose environment points at production it opens a
// connection to production during a unit-test run. Both of those actually happened.
if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
