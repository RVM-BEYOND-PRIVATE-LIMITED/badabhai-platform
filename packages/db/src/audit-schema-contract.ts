/**
 * Ask a live database whether it is ready for the code on `main`. Read-only; no write path.
 *
 * See `schema-contract.ts` for what the manifest contains and why. This file is only the
 * probe + the report.
 *
 *   pnpm db:audit:schema-contract            # report; exit 1 if the database is behind
 *   pnpm db:audit:schema-contract --json=<p> # + an evidence record
 */
import { config } from "dotenv";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sql as dsql } from "drizzle-orm";

import { createDbClient } from "./client";
import { hostClass } from "./audit-embedding-provenance";
import {
  SCHEMA_REQUIREMENTS,
  contractBlockReason,
  driftRemedy,
  evaluateContract,
  migrationDrift,
  uniqueIndexMatches,
  type JournalEntry,
  type PresenceMap,
} from "./schema-contract";

// EXPLICIT PATH, matching every other runner in this package. A bare `config()` resolves
// against `process.cwd()`, where there is no env file — this only ever found one because
// `audit-embedding-provenance` loads it as an import side effect, which is a dependency on
// import ORDER for something as load-bearing as which database gets audited.
config({ path: join("..", "..", ".env") });

const SCRIPT = "audit:schema-contract";
const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

/** The repo's migration files, in journal order, keyed the way drizzle keys them. */
function readJournal(): JournalEntry[] {
  const meta = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  return meta.entries.map((e) => ({
    tag: e.tag,
    hash: createHash("sha256").update(readFileSync(join(MIGRATIONS_DIR, `${e.tag}.sql`), "utf8")).digest("hex"),
  }));
}

/**
 * What the database has RECORDED. Absent-table tolerant: a database that has never been
 * migrated has no `drizzle.__drizzle_migrations`, and that is a legitimate state to audit
 * rather than a crash.
 */
async function recordedHashes(db: {
  execute: (q: ReturnType<typeof dsql>) => Promise<unknown>;
}): Promise<Set<string>> {
  try {
    const rows = (await db.execute(
      dsql`SELECT hash FROM drizzle.__drizzle_migrations`,
    )) as unknown as { hash: string }[];
    return new Set(rows.map((r) => r.hash));
  } catch {
    return new Set();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const jsonArg = argv.find((a) => a.startsWith("--json="));

  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);

  const { db, sql } = createDbClient(url, { max: 1 });
  try {
    const [where] = (await db.execute(dsql`SELECT current_database() AS db`)) as unknown as { db: string }[];
    console.log(`[${SCRIPT}] READ-ONLY.`);
    console.log(`  target                   = ${hostClass(url)}  db=${where?.db ?? "?"}`);

    const presence: Record<string, boolean> = {};
    for (const r of SCHEMA_REQUIREMENTS) {
      if (r.kind === "table") {
        const [row] = (await db.execute(
          dsql`SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = ${r.table}) AS ok`,
        )) as unknown as { ok: boolean }[];
        presence[r.id] = row?.ok === true;
      } else if (r.kind === "column") {
        const [row] = (await db.execute(
          dsql`SELECT EXISTS(SELECT 1 FROM information_schema.columns
               WHERE table_name = ${r.table} AND column_name = ${r.object ?? ""}) AS ok`,
        )) as unknown as { ok: boolean }[];
        presence[r.id] = row?.ok === true;
      } else if (r.kind === "constraint") {
        const [row] = (await db.execute(
          dsql`SELECT EXISTS(SELECT 1 FROM pg_constraint WHERE conname = ${r.object ?? ""}) AS ok`,
        )) as unknown as { ok: boolean }[];
        presence[r.id] = row?.ok === true;
      } else {
        // Shape, not just existence — a same-named index with the old column list is the
        // quiet failure, so `EXISTS` would be the wrong question here.
        const [row] = (await db.execute(
          dsql`SELECT indexdef FROM pg_indexes WHERE indexname = ${r.object ?? ""}`,
        )) as unknown as { indexdef: string }[];
        presence[r.id] = uniqueIndexMatches(row?.indexdef ?? null);
      }
    }

    const results = evaluateContract(SCHEMA_REQUIREMENTS, presence as PresenceMap);
    console.log("");
    for (const { requirement: r, present } of results) {
      console.log(`  ${present ? "OK     " : "MISSING"}  ${r.migration}  ${r.kind} ${r.table}${r.object ? `.${r.object}` : ""}`);
      if (!present) {
        console.log(`             required by: ${r.requiredBy}`);
        console.log(`             failure    : ${r.failureMode}`);
      }
    }

    const blocked = contractBlockReason(results);
    const missingMigrations = [
      ...new Set(results.filter((r) => !r.present).map((r) => r.requirement.migration)),
    ];

    // THE SECOND QUESTION — can the remedy run? See `migrationDrift` for the incident.
    const drift = migrationDrift(readJournal(), await recordedHashes(db), missingMigrations);

    console.log(`\n  ready for the code on main? = ${blocked === null ? "YES" : `NO — ${blocked}`}`);
    if (blocked !== null) {
      console.log("");
      console.log(
        `  migration journal        = ${drift.unrecorded.length} of ${readJournal().length} file(s) unrecorded` +
          (drift.unrecorded.length > 0 ? `: ${drift.unrecorded.join(", ")}` : ""),
      );
      for (const line of driftRemedy(drift)) console.log(`  ${line}`);
      process.exitCode = 1;
    } else if (!drift.migrateAloneIsSafe) {
      // The objects are all there, so nothing is broken TODAY — but the journal is behind and
      // the NEXT migration to land will hit the same wall. Reported, never fatal: this is a
      // readiness audit for the code on `main`, and by that measure the database passes.
      console.log("");
      console.log(
        `  note: the journal is behind by ${drift.unclassified.length} file(s) whose objects are ` +
          `already live (${drift.unclassified.join(", ")}). Nothing is broken now, and the next ` +
          `pending migration will not apply until they are adopted.`,
      );
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
            kind: "schema-contract-audit",
            target: { host_class: hostClass(url), database: where?.db ?? null },
            ready: blocked === null,
            block_reason: blocked,
            results: results.map((r) => ({ id: r.requirement.id, migration: r.requirement.migration, present: r.present })),
            journal: {
              unrecorded: drift.unrecorded,
              pending: drift.pending,
              unclassified: drift.unclassified,
              migrate_alone_is_safe: drift.migrateAloneIsSafe,
            },
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

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
