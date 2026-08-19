/**
 * Read-only forensic audit of embedding provenance, across BOTH vocabularies.
 *
 * ===========================================================================
 * WHY THIS EXISTS, WHEN `db:eval:taxonomy --plan` ALREADY PRINTS A REPORT
 * ===========================================================================
 * `corpusBlockReason` refuses to score retrieval while any embedded alias carries no
 * `embedding_model`, on the grounds that *"provenance is unknown, so a mock or foreign-model
 * vector cannot be ruled out."* That sentence bundles two failures of very different severity,
 * and the eval harness — correctly, for its own purpose — reports only the aggregate that
 * blocks it. To DECIDE what to do about the block you need the forensics underneath:
 *
 *   - is any vector PROVEN MOCK?          decides "corrupt" vs "merely unlabelled"
 *   - is `embedded_at` set on those rows?  dates the write, which identifies the RUNNER
 *   - is the dimension uniform?            a second, independent smell for a foreign model
 *   - is the L2 norm ~1 across the board?  this corpus is L2-normalized client-side, so a
 *                                          run from a different pipeline shows up here
 *   - is the same true of `job_domain_alias`? one vocabulary healthy and one not is a
 *                                          different story from both being unstamped
 *
 * `embedded_at` is the decisive one. `embedding_model` and `embedded_at` were both added by
 * migration 0076, but `embed-skill-aliases.ts` did not start WRITING either until #900. So
 * `embedding IS NOT NULL AND embedded_at IS NULL` is a signature, not a guess: it means the row
 * was written by a pre-#900 runner. A row with `embedded_at` SET and `embedding_model` NULL
 * would mean something else entirely and would need a different explanation.
 *
 * ===========================================================================
 * WHAT THIS WILL NOT DO
 * ===========================================================================
 * It has no `--apply`, no write path, and opens no provider connection — deliberately, and not
 * as an oversight to be tidied up later. An audit that can also mutate is an audit an operator
 * stops trusting, and the ONE thing this must be is trustworthy against production. The write
 * that this audit's output justifies lives in its own script, behind its own flags.
 *
 * PRIVACY. Only reference vocabulary and row ids are ever read. No worker, profile, application
 * or PII column is touched. The connection string is never printed — only a coarse host class
 * ("LOCAL DOCKER" / "SUPABASE (remote)" / "OTHER-REMOTE") and the database name, which is what
 * an operator actually needs in order to know they are pointed where they think they are. Alias
 * TEXT is reference vocabulary, not PII, but stays behind `--verbose` anyway: an audit whose
 * default output is safe to paste into a public issue is more useful than one that is not.
 *
 * Usage:
 *   pnpm db:audit:embeddings                 # the report
 *   pnpm db:audit:embeddings --verbose       # + the unstamped rows, named
 *   pnpm db:audit:embeddings --json=<path>   # + a committed evidence record
 */
import { config } from "dotenv";
import { existsSync, writeFileSync } from "node:fs";

import { sql as dsql } from "drizzle-orm";

import { createDbClient } from "./client";
import { classifyEmbedding, corpusBlockReason, type ProvenanceReport } from "./taxonomy-retrieval-eval";

config();

const SCRIPT = "audit:embeddings";

/**
 * The two vocabularies that carry embeddings.
 *
 * The SELECT is written out per table rather than interpolating the name into one shared
 * string. The tables are hardcoded here so interpolation would be safe TODAY, but a
 * `sql.raw(table)` is an invitation for the next person to pass something that is not — and a
 * scanner cannot tell the two apart, so it either flags this forever or teaches everyone to
 * wave it through. Two literal queries cost four lines and remove the question.
 */
const VOCABULARIES = [
  {
    table: "skill_alias",
    // `embedding::text` because postgres.js hands vector() back as a string either way; being
    // explicit means the parse is the ONLY place the wire format is assumed.
    query: dsql`SELECT id::text AS id, text, embedding::text AS embedding, embedding_model, embedded_at
                FROM skill_alias`,
  },
  {
    table: "job_domain_alias",
    query: dsql`SELECT id::text AS id, text, embedding::text AS embedding, embedding_model, embedded_at
                FROM job_domain_alias`,
  },
] as const;

interface AliasRow {
  id: string;
  text: string;
  embedding: string | null;
  embedding_model: string | null;
  embedded_at: Date | null;
}

/** Everything the report says about one vocabulary. Serializable as evidence. */
export interface VocabularyAudit {
  table: string;
  rows: number;
  embedded: number;
  provenance: ProvenanceReport;
  /** Embedded rows with no `embedded_at` — the pre-#900 runner signature. */
  embeddedAtMissing: number;
  /** Embedded rows that HAVE `embedded_at` but no model — needs its own explanation. */
  stampedTimeButNoModel: number;
  /** Distinct vector lengths seen. More than one = two pipelines wrote this table. */
  dimensions: number[];
  /** L2 norms of the stored vectors, rounded. This corpus is normalized, so expect ~1. */
  l2: { min: number; max: number } | null;
  /** `corpusBlockReason` — the sentence that actually gates `db:eval:taxonomy --run`. */
  blockReason: string | null;
  /** Ids of embedded-but-unstamped rows. Ids only; text only under `--verbose`. */
  unstampedIds: string[];
}

/** Coarse enough to be safe in any log, specific enough to prevent a wrong-database mistake. */
export function hostClass(connectionString: string): string {
  let host: string;
  try {
    host = new URL(connectionString).hostname;
  } catch {
    return "UNPARSEABLE";
  }
  if (/^(localhost|127\.0\.0\.1|::1)$/i.test(host)) return "LOCAL DOCKER";
  if (/supabase/i.test(host)) return "SUPABASE (remote)";
  return "OTHER-REMOTE";
}

/** L2 norm, to the precision the report prints. */
export function l2Norm(v: readonly number[]): number {
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}

/**
 * The whole audit for one vocabulary, from rows already read.
 *
 * Split from the query so it is testable without a database — the arithmetic here is the part
 * a reader has to trust, and "we ran it against prod and it looked right" is not a test.
 */
export function auditRows(
  table: string,
  rows: readonly { id: string; text: string; embedding: number[] | null; embedding_model: string | null; embedded_at: Date | null }[],
): VocabularyAudit {
  const embedded = rows.filter((r) => r.embedding !== null);
  const mock: string[] = [];
  const models = new Set<string>();
  const dims = new Set<number>();
  const unstampedIds: string[] = [];
  let unstamped = 0;
  let embeddedAtMissing = 0;
  let stampedTimeButNoModel = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const r of embedded) {
    const vec = r.embedding as number[];
    dims.add(vec.length);
    const n = l2Norm(vec);
    if (n < min) min = n;
    if (n > max) max = n;
    if (classifyEmbedding(r.text, vec) === "MOCK") mock.push(r.id);
    const m = r.embedding_model ?? null;
    if (m === null || m.length === 0) {
      unstamped += 1;
      unstampedIds.push(r.id);
      if (r.embedded_at === null) embeddedAtMissing += 1;
      else stampedTimeButNoModel += 1;
    } else {
      models.add(m);
      if (r.embedded_at === null) embeddedAtMissing += 1;
    }
  }

  const provenance: ProvenanceReport = {
    embedded: embedded.length,
    mock: mock.length,
    notMock: embedded.length - mock.length,
    sampleMockAliasIds: mock.slice(0, 5),
    models: [...models].sort(),
    unstamped,
  };

  return {
    table,
    rows: rows.length,
    embedded: embedded.length,
    provenance,
    embeddedAtMissing,
    stampedTimeButNoModel,
    dimensions: [...dims].sort((a, b) => a - b),
    l2: embedded.length > 0 ? { min: Number(min.toFixed(6)), max: Number(max.toFixed(6)) } : null,
    blockReason: corpusBlockReason(provenance),
    unstampedIds,
  };
}

function print(a: VocabularyAudit, verbose: boolean, texts: Map<string, string>): void {
  console.log(`\n  ── ${a.table} ─────────────────────────────────────────`);
  console.log(`  rows                     = ${a.rows}`);
  console.log(`  embedded                 = ${a.embedded}`);
  console.log(`  PROVEN MOCK (recompute)  = ${a.provenance.mock}`);
  console.log(`  not mock                 = ${a.provenance.notMock}`);
  console.log(`  embedding_model(s)       = ${a.provenance.models.length > 0 ? a.provenance.models.join(", ") : "(none stamped)"}`);
  console.log(`  unstamped                = ${a.provenance.unstamped}`);
  console.log(`  of those, embedded_at NULL too = ${a.embeddedAtMissing}   <- pre-#900 runner signature`);
  if (a.stampedTimeButNoModel > 0) {
    console.log(`  !! embedded_at SET but model NULL = ${a.stampedTimeButNoModel} — NOT the pre-#900 story; investigate`);
  }
  console.log(`  vector dimension(s)      = ${a.dimensions.join(", ") || "-"}${a.dimensions.length > 1 ? "   <- TWO PIPELINES WROTE THIS TABLE" : ""}`);
  console.log(`  L2 norm range            = ${a.l2 ? `${a.l2.min} … ${a.l2.max}` : "-"}   (this corpus is client-side L2-normalized: expect ~1)`);
  console.log(`  would --run be allowed?  = ${a.blockReason === null ? "YES" : `NO — ${a.blockReason}`}`);
  if (verbose && a.unstampedIds.length > 0) {
    console.log(`  unstamped rows:`);
    for (const id of a.unstampedIds) console.log(`     ${id}  ${JSON.stringify(texts.get(id) ?? "")}`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const verbose = argv.includes("--verbose");
  const jsonArg = argv.find((a) => a.startsWith("--json="));

  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);

  const { db, sql } = createDbClient(url, { max: 1 });
  try {
    const [where] = (await db.execute(dsql`SELECT current_database() AS db`)) as unknown as { db: string }[];
    console.log(`[${SCRIPT}] READ-ONLY. No write path exists in this script.`);
    console.log(`  target                   = ${hostClass(url)}  db=${where?.db ?? "?"}`);

    const audits: VocabularyAudit[] = [];
    const texts = new Map<string, string>();
    for (const v of VOCABULARIES) {
      const rows = (await db.execute(v.query)) as unknown as AliasRow[];
      const parsed = rows.map((r) => {
        texts.set(r.id, r.text);
        return {
          id: r.id,
          text: r.text,
          embedding: r.embedding === null ? null : (JSON.parse(r.embedding) as number[]),
          embedding_model: r.embedding_model,
          embedded_at: r.embedded_at === null ? null : new Date(r.embedded_at),
        };
      });
      audits.push(auditRows(v.table, parsed));
    }

    for (const a of audits) print(a, verbose, texts);

    console.log(`\n  ── what this does and does not prove ────────────────────`);
    for (const a of audits) {
      if (a.embedded === 0) {
        console.log(`  ${a.table}: nothing embedded — no provenance question to answer.`);
        continue;
      }
      const stamped = a.embedded - a.provenance.unstamped;
      console.log(
        `  ${a.table}: mock is ${a.provenance.mock === 0 ? "RULED OUT by recompute" : "PRESENT"} ` +
          `for all ${a.embedded}; ${stamped} carry a model, ${a.provenance.unstamped} do not.`,
      );
      if (a.provenance.unstamped > 0) {
        console.log(
          `     A recompute can rule out MOCK. It cannot rule out FOREIGN-MODEL: two real models ` +
            `produce two incomparable geometries and neither looks wrong at rest. Stamping a model ` +
            `name onto these rows would not discover that — it would only stop the gate asking.`,
        );
      }
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
            kind: "embedding-provenance-audit",
            target: { host_class: hostClass(url), database: where?.db ?? null },
            note: "Read-only. Alias ids are reference-vocabulary row ids, not worker data. No connection string, secret or PII is recorded.",
            vocabularies: audits,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      console.log(`\n  evidence written to ${path}`);
    }
  } finally {
    await sql.end();
  }
}

// GUARDED ENTRYPOINT. This module exports `hostClass` and `auditRows`, so it gets IMPORTED —
// and an unguarded `main()` at module scope means importing an audit function silently opens a
// connection to whatever DATABASE_URL happens to be set and prints a second report. That is not
// hypothetical: `verify-embedding-provenance.ts` imports `hostClass` from here, and the first
// run of it emitted this script's entire output above its own.
if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
