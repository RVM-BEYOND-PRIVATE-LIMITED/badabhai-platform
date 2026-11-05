/**
 * The B4 (#2557) candidate read-table backfill + drift check, run by hand.
 *
 *   node apps/api/dist/admin/candidate-index/candidate-index-backfill.cli.js \
 *     [--apply] [--batch-size=<n>] [--worker=<uuid>] [--drift] [--drift-sample=<n>]
 *
 * (`pnpm --filter @badabhai/api build` first; on a deployed box the api image already
 * carries `dist/`, so it runs where `DATABASE_URL` and the PII/keyring env are.)
 *
 * MODES. `--drift` compares stored rows against fresh `projectWorker` output and
 * reports mismatched columns (the drift check #2557 requires, run against the
 * synthetic seed); without it the script backfills (projects every worker, or
 * `--worker` for one). DRY-RUN is the default: backfill reports how many workers
 * would project (and how many rows exist); drift reports mismatches; `--apply`
 * writes. `--worker` with `--apply` re-projects one worker (the repair path
 * after a resolver change).
 *
 * THE SAME PROJECTOR AS THE QUEUE: hand-constructed `CandidateIndexProjector`
 * over the same repositories — no second implementation to drift. Name tokens
 * use the box's `ADMIN_NAME_TOKEN_KEYS` (empty = empty token sets, fail closed).
 *
 * TARGET SAFETY: the shared ops guard (`enforceOpsGuard`) — a write to a
 * production-like database needs `--i-am-authorised-to-write-to-production` AND
 * `OPS_ALLOW_PRODUCTION=candidate-index-backfill`. Output is ids, column names
 * and counts only — never a name, phone, label or token.
 */
import { parseArgs } from "node:util";
import { sql as dsql } from "drizzle-orm";
import { loadServerConfig } from "@badabhai/config";
import {
  PRODUCTION_WRITE_FLAG,
  createDbClient,
  enforceOpsGuard,
  type Database,
} from "@badabhai/db";
import { PiiCryptoService } from "../../common/pii-crypto.service";
import { AdminCandidateDetailRepository } from "../admin-candidate-detail.repository";
import { WorkerAttributesRepository } from "../../profiles/worker-attributes.repository";
import { WorkerLanguagesRepository } from "../../profiles/worker-languages.repository";
import { WorkerQualificationsRepository } from "../../profiles/worker-qualifications.repository";
import { WorkersRepository } from "../../workers/workers.repository";
import { CandidateIndexProjector } from "./candidate-index.projector";
import { CandidateIndexRepository } from "./candidate-index.repository";
import { NameTokenService } from "./name-token.service";

export const CANDIDATE_INDEX_BACKFILL_SCRIPT = "candidate-index-backfill";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CandidateIndexBackfillArgs {
  apply: boolean;
  batchSize: number;
  worker: string | null;
  drift: boolean;
  driftSample: number;
}

/** Strict argv parsing: an unknown, malformed or missing flag is an error, never a guess. */
export function parseCandidateIndexBackfillArgs(argv: readonly string[]): CandidateIndexBackfillArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      apply: { type: "boolean", default: false },
      "batch-size": { type: "string" },
      worker: { type: "string" },
      drift: { type: "boolean", default: false },
      "drift-sample": { type: "string" },
      [PRODUCTION_WRITE_FLAG.replace(/^--/, "")]: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const batchSize = values["batch-size"] === undefined ? 500 : Number(values["batch-size"]);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) {
    throw new Error("--batch-size must be an integer in 1..5000");
  }
  const worker = values.worker ?? null;
  if (worker !== null && !UUID.test(worker)) throw new Error("--worker must be a uuid");
  const driftSample =
    values["drift-sample"] === undefined ? 200 : Number(values["drift-sample"]);
  if (!Number.isInteger(driftSample) || driftSample < 1 || driftSample > 5000) {
    throw new Error("--drift-sample must be an integer in 1..5000");
  }
  return {
    apply: values.apply === true,
    batchSize,
    worker,
    drift: values.drift === true,
    driftSample,
  };
}

async function countWorkers(db: Database): Promise<number> {
  const rows = await db.execute<{ n: number }>(dsql`SELECT count(*)::int AS n FROM workers`);
  return (rows as unknown as { n: number }[])[0]?.n ?? 0;
}

async function countIndexed(db: Database): Promise<number> {
  const rows = await db.execute<{ n: number }>(
    dsql`SELECT count(*)::int AS n FROM admin_candidate_index`,
  );
  return (rows as unknown as { n: number }[])[0]?.n ?? 0;
}

async function run(argv: readonly string[]): Promise<number> {
  const args = parseCandidateIndexBackfillArgs(argv);
  const config = loadServerConfig();
  const { connectionString } = enforceOpsGuard({
    script: CANDIDATE_INDEX_BACKFILL_SCRIPT,
    connectionString: process.env.DATABASE_URL,
    mutating: args.apply,
  });
  console.log(
    `[${CANDIDATE_INDEX_BACKFILL_SCRIPT}] ${args.apply ? "APPLY" : "DRY-RUN"} mode=${
      args.drift ? "drift" : args.worker ? "single" : "backfill"
    } batch=${args.batchSize}`,
  );

  const client = createDbClient(connectionString, { max: 1 });
  const db = client.db;
  const pii = new PiiCryptoService(config);
  const projector = new CandidateIndexProjector(
    new WorkersRepository(db),
    new WorkerAttributesRepository(db),
    new WorkerQualificationsRepository(db),
    new WorkerLanguagesRepository(db),
    new AdminCandidateDetailRepository(db),
    new CandidateIndexRepository(db),
    pii,
    new NameTokenService(config),
  );
  const index = new CandidateIndexRepository(db);

  try {
    if (args.drift) {
      return await runDrift(projector, index, args);
    }
    return await runBackfill(projector, index, db, args);
  } finally {
    await client.sql.end({ timeout: 5 });
  }
}

async function runBackfill(
  projector: CandidateIndexProjector,
  index: CandidateIndexRepository,
  db: Database,
  args: CandidateIndexBackfillArgs,
): Promise<number> {
  if (args.worker) {
    if (!args.apply) {
      const stored = await index.readRow(args.worker);
      console.log(`  worker=${args.worker.slice(0, 8)} indexed=${stored ? "yes" : "no"} (dry-run)`);
      return 0;
    }
    const ok = await projector.projectWorker(args.worker);
    console.log(`  worker=${args.worker.slice(0, 8)} projected=${ok}`);
    return ok ? 0 : 1;
  }
  const [total, indexed] = await Promise.all([countWorkers(db), countIndexed(db)]);
  if (!args.apply) {
    console.log(`  workers=${total} indexed=${indexed} missing=${total - indexed} (dry-run)`);
    return 0;
  }
  let projected = 0;
  let failed = 0;
  let after: string | null = null;
  for (;;) {
    const ids = await index.listWorkerIds(args.batchSize, after);
    if (ids.length === 0) break;
    for (const id of ids) {
      try {
        if (await projector.projectWorker(id)) projected++;
      } catch (err) {
        failed++;
        console.log(
          `  worker=${id.slice(0, 8)} FAILED (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
    after = ids[ids.length - 1] ?? null;
    if (ids.length < args.batchSize) break;
  }
  console.log(`  workers=${total} projected=${projected} failed=${failed}`);
  return failed > 0 ? 1 : 0;
}

async function runDrift(
  projector: CandidateIndexProjector,
  index: CandidateIndexRepository,
  args: CandidateIndexBackfillArgs,
): Promise<number> {
  if (args.worker) {
    // Drift on one worker is a read-only report unless --apply re-projects it.
    if (!args.apply) {
      const stored = await index.readRow(args.worker);
      console.log(`  worker=${args.worker.slice(0, 8)} indexed=${stored ? "yes" : "no"} (dry-run)`);
      return 0;
    }
  }
  let checked = 0;
  let drifted = 0;
  const byColumn = new Map<string, number>();
  let after: string | null = null;
  for (;;) {
    const ids: string[] = args.worker ? [args.worker] : await index.listWorkerIds(args.batchSize, after);
    if (ids.length === 0) break;
    for (const id of ids) {
      checked++;
      try {
        const out = await projector.driftForWorker(id);
        if (out.drifted) {
          drifted++;
          for (const col of out.columns) byColumn.set(col, (byColumn.get(col) ?? 0) + 1);
          console.log(`  worker=${id.slice(0, 8)} drift columns=${out.columns.join(",")}`);
        }
      } catch (err) {
        drifted++;
        console.log(
          `  worker=${id.slice(0, 8)} DRIFT-ERROR (${err instanceof Error ? err.message : String(err)})`,
        );
      }
      if (checked >= args.driftSample && !args.worker) break;
    }
    if (args.worker || ids.length < args.batchSize || checked >= args.driftSample) break;
    after = ids[ids.length - 1] ?? null;
  }
  console.log(
    `  checked=${checked} drifted=${drifted} byColumn=${[...byColumn.entries()].map(([c, n]) => `${c}:${n}`).join(" ") || "-"}`,
  );
  return drifted > 0 ? 1 : 0;
}

// istanbul ignore next — CLI entry; logic is unit-tested via the arg parser + services.
if (require.main === module) {
  run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(
        `[${CANDIDATE_INDEX_BACKFILL_SCRIPT}] failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
    },
  );
}
