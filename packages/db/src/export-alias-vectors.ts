/**
 * `db:export:alias-vectors` — READ-ONLY. Export `skill_alias` embeddings as the TSV that
 * `db:replay:path-a` and `db:report:s3d-shadow` take via `--vectors=`.
 *
 * WHY A SCRIPT AND NOT THE DOCUMENTED ONE-LINER. `replay-path-a.ts` prescribes:
 *
 *     docker exec badabhai-postgres psql -U badabhai -d badabhai -A -t -c "COPY (...) TO STDOUT"
 *
 * That reaches the COMPOSE-INTERNAL postgres — the container R38 wants removed, which holds no
 * production data (`docker-compose.staging.yml`: "the real Postgres, never the compose-internal
 * one"). So the documented command either exports an empty/stale corpus or cannot run at all
 * once R38's residual is cleared. This reads the same rows over the ordinary `DATABASE_URL`,
 * which is where the corpus actually lives.
 *
 * THE MODEL COLUMN IS THE POINT, NOT DECORATION. `loadVectors` hard-fails when a file mixes
 * embedding models, because cosines across two geometries look entirely normal and mean
 * nothing. The export therefore emits `embedding_model` verbatim — including the literal
 * `<null>` for unstamped rows, which is what makes an unstamped row a loud failure downstream
 * rather than a silent participant.
 *
 * It writes ONE file and refuses to overwrite: these exports are evidence for a replay, and a
 * replay whose inputs were quietly replaced is not reproducible.
 *
 *   pnpm --filter @badabhai/db db:export:alias-vectors --out=<path>
 */
import { config } from "dotenv";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sql as dsql } from "drizzle-orm";

import { createDbClient } from "./client";
import { hostClass } from "./audit-embedding-provenance";

config({ path: join("..", "..", ".env") });

const SCRIPT = "export:alias-vectors";

export interface AliasVectorRow {
  readonly text: string;
  readonly lang: string | null;
  readonly embeddingModel: string | null;
  readonly embedding: string;
}

/**
 * One TSV line per row, in the column order `loadVectors` reads: text, lang, model, vector.
 *
 * A tab or newline inside `text` would shift every later column on that line, and the reader
 * splits on tabs with no quoting. There is no escaping to get right because there must be no
 * such row: {@link offendingTexts} makes it a refusal instead of a corrupted export.
 */
export function toTsv(rows: readonly AliasVectorRow[]): string {
  return rows
    .map((r) => [r.text, r.lang ?? "", r.embeddingModel ?? "<null>", r.embedding].join("\t"))
    .join("\n");
}

/** Alias texts that cannot be represented in a tab-separated line. Empty is the expected case. */
export function offendingTexts(rows: readonly AliasVectorRow[]): string[] {
  return rows.filter((r) => /[\t\r\n]/.test(r.text)).map((r) => r.text);
}

async function main(): Promise<void> {
  const outArg = process.argv.slice(2).find((a) => a.startsWith("--out="));
  if (outArg === undefined) {
    console.error(`[${SCRIPT}] --out=<path> is required.`);
    process.exit(2);
  }
  const out = outArg.slice("--out=".length);
  if (existsSync(out)) {
    console.error(`[${SCRIPT}] refusing to overwrite ${out} — a replay input is evidence.`);
    process.exit(1);
  }

  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);
  const { db, sql } = createDbClient(url, { max: 1 });
  try {
    console.log(`[${SCRIPT}] READ-ONLY.  target = ${hostClass(url)}`);
    const rows = (await db.execute(
      dsql`SELECT text, lang, embedding_model, embedding::text AS embedding
             FROM skill_alias
            WHERE embedding IS NOT NULL
            ORDER BY text, lang`,
    )) as unknown as { text: string; lang: string | null; embedding_model: string | null; embedding: string }[];

    const mapped: AliasVectorRow[] = rows.map((r) => ({
      text: r.text,
      lang: r.lang,
      embeddingModel: r.embedding_model,
      embedding: r.embedding,
    }));

    const bad = offendingTexts(mapped);
    if (bad.length > 0) {
      console.error(`[${SCRIPT}] ${bad.length} alias text(s) contain a tab or newline and would`);
      console.error(`  corrupt the TSV silently. Fix the data; refusing to write. ${bad.slice(0, 5).join(" | ")}`);
      process.exit(1);
    }

    const models = new Map<string, number>();
    for (const r of mapped) {
      const k = r.embeddingModel ?? "<null>";
      models.set(k, (models.get(k) ?? 0) + 1);
    }

    writeFileSync(out, `${toTsv(mapped)}\n`, "utf8");
    console.log(`  rows exported = ${mapped.length}`);
    for (const [model, n] of [...models].sort()) console.log(`    ${model.padEnd(28)} ${n}`);
    if (models.size > 1) {
      console.log(`  NOTE: more than one model is present. The replay will REFUSE this file, and`);
      console.log(`  that is correct — cosines across two geometries look normal and mean nothing.`);
    }
    console.log(`  written to ${out}`);
  } finally {
    await sql.end();
  }
}

if (process.argv[1]?.includes("export-alias-vectors")) void main();
