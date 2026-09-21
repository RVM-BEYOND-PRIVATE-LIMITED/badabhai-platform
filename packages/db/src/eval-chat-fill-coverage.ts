/**
 * `pnpm db:eval:chat-fill` — the chat-road fill ruler, runnable OFFLINE (no database, no
 * network, no credentials).
 *
 * WHAT IT ANSWERS. For each field in `CHAT_FILL_FIELDS`, what fraction of workers is it settled
 * for, split by the profile's road (`form` / `chat` / `unknown`=NULL source)? The corpus is one
 * JSON line per worker — `{"road", "filled"}` — in the format `parseCorpusLines` defines.
 *
 *   pnpm db:eval:chat-fill                                  # report + reports/chat-fill-coverage.json
 *   pnpm db:eval:chat-fill -- --corpus=<path>               # score another corpus (same format)
 *   pnpm db:eval:chat-fill -- --json=<path>                 # write the JSON summary elsewhere
 *
 * THE COMMITTED CORPUS IS A FIXTURE, NOT A CENSUS (`data/chat-fill/fixture-corpus.jsonl`). It
 * models the verified 2026-09-17 baseline so the ruler has deterministic numbers in CI and in a
 * git checkout. Real fill rates come from exporting one row per worker in the same format; the
 * per-worker settled view that produces that export is Layer B of the Phase 3 endpoint work
 * (`isSettled` AND projector drops — projector-dropped counts as missing).
 *
 * THE NULL-SOURCE NUMBER. Rows with `road: null` are `worker_profiles.source IS NULL`
 * (pre-0107, D1 unknown-never-guessed). The report prints the count; production expects ~0, and
 * the live census is one read-only query: `select count(*) from worker_profiles where source is
 * null`. This script scores whatever corpus it is handed and claims nothing about production.
 *
 * PRIVACY: the corpus and the output are field NAMES, roads and booleans. The parser refuses any
 * key other than `road`/`filled`, so a value cannot ride in; `formatReport` prints no string
 * that ever came from a worker.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  CHAT_FILL_FIELDS,
  aggregateFill,
  formatReport,
  parseCorpusLines,
  type FillObservation,
} from "./chat-fill-coverage";

const SCRIPT = "eval:chat-fill";
export const FIXTURE_CORPUS_PATH = join("data", "chat-fill", "fixture-corpus.jsonl");
const DEFAULT_JSON_OUT = join("reports", "chat-fill-coverage.json");

/** Read a corpus in the documented format. Blank lines and `#` comments carry the provenance. */
export function loadCorpus(path: string = FIXTURE_CORPUS_PATH): FillObservation[] {
  if (!existsSync(path)) throw new Error(`corpus not found at ${path}`);
  return parseCorpusLines(readFileSync(path, "utf8"));
}

function arg(name: string): string | undefined {
  return process.argv.find((x) => x.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function main(): void {
  const corpusPath = arg("corpus") ?? FIXTURE_CORPUS_PATH;
  const jsonOut = arg("json") ?? DEFAULT_JSON_OUT;
  const isFixture = corpusPath === FIXTURE_CORPUS_PATH;

  const observations = loadCorpus(corpusPath);
  const aggregate = aggregateFill(observations);

  console.log(
    `[${SCRIPT}] corpus: ${corpusPath}${isFixture ? " (FIXTURE — authored baseline, not a census)" : ""}`,
  );
  console.log(`[${SCRIPT}] fields: ${CHAT_FILL_FIELDS.length}`);
  for (const line of formatReport(aggregate)) console.log(line);

  const outDir = dirname(jsonOut);
  if (outDir && outDir !== "." && !existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(
    jsonOut,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        corpus: corpusPath,
        fixture: isFixture,
        totalWorkers: aggregate.totalWorkers,
        workersPerRoad: aggregate.workersPerRoad,
        unknownRoadWorkers: aggregate.unknownRoadWorkers,
        rows: aggregate.rows,
      },
      null,
      2,
    ),
  );
  console.log(`[${SCRIPT}] wrote ${jsonOut}`);
}

if (process.argv[1] && /eval-chat-fill-coverage/.test(process.argv[1])) {
  try {
    main();
  } catch (error: unknown) {
    console.error(`[${SCRIPT}] FAILED: ${(error as Error).message}`);
    process.exit(1);
  }
}
