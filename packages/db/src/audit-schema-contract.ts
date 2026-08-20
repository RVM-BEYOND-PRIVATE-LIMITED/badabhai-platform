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
  rlsLocked,
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

/**
 * WHICH CLUSTER IS THIS, ANSWERED IN A FORM THE OPERATOR CAN COMPARE ELSEWHERE.
 *
 * Added on 2026-08-19 after a migration was reported applied and this audit kept reporting it
 * missing. Both statements can be true at once — of two different clusters — and nothing in the
 * output could tell them apart, so the disagreement had no mechanical resolution. It does now:
 * run {@link CLUSTER_IDENTITY_SQL} in the SQL editor of whichever project the migration was
 * applied to and compare the number. Same number means the apply did not commit; different
 * number means it landed somewhere else.
 *
 * SAFE TO PRINT, and that is a deliberate judgement rather than an oversight.
 * `system_identifier` is a random 64-bit value stamped at `initdb`, used to stop a standby
 * replaying the wrong cluster's WAL. It is not derived from any credential, it does not appear
 * in a connection string, and it cannot be used to reach the database. The hostname and the
 * password — the parts that ARE secret — never leave `hostClass`, which reduces the URL to a
 * class name.
 *
 * Returns null rather than throwing when the role cannot read it: an audit that dies on an
 * optional identity line would be worse than one that omits it.
 */
export const CLUSTER_IDENTITY_SQL = "SELECT system_identifier FROM pg_control_system();";

async function clusterIdentity(db: {
  execute: (q: ReturnType<typeof dsql>) => Promise<unknown>;
}): Promise<string | null> {
  try {
    const rows = (await db.execute(
      dsql`SELECT system_identifier::text AS id FROM pg_control_system()`,
    )) as unknown as { id: string }[];
    return rows[0]?.id ?? null;
  } catch {
    return null;
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
    const identity = await clusterIdentity(db);
    console.log(`[${SCRIPT}] READ-ONLY.`);
    console.log(`  target                   = ${hostClass(url)}  db=${where?.db ?? "?"}`);
    console.log(`  cluster                  = ${identity ?? "unavailable (pg_control_system denied)"}`);

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
      } else if (r.kind === "rls") {
        // Three facts in one probe. `pg_class` carries ENABLE/FORCE; the grants live in
        // `information_schema`, which reports the OWNER's rows too — harmless, because
        // `rlsLocked` only looks for the Data-API roles and FORCE is what handles the owner.
        const [row] = (await db.execute(
          dsql`SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
               FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE c.relname = ${r.table} AND n.nspname = 'public'`,
        )) as unknown as { enabled: boolean; forced: boolean }[];
        const grants = (await db.execute(
          dsql`SELECT DISTINCT grantee FROM information_schema.role_table_grants
               WHERE table_name = ${r.table} AND table_schema = 'public'`,
        )) as unknown as { grantee: string }[];
        presence[r.id] =
          row !== undefined &&
          rlsLocked({
            enabled: row.enabled === true,
            forced: row.forced === true,
            grantedRoles: grants.map((g) => g.grantee),
          });
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
      // THE OTHER EXPLANATION, stated before the remedy is attempted a second time. If the
      // migration was already applied, the two candidate causes are "it did not commit" and
      // "it landed on a different cluster", and only the operator can tell them apart —
      // cheaply, with one query.
      console.log("");
      console.log(`  If this migration was ALREADY applied, it did not land on THIS cluster.`);
      console.log(`  Run  ${CLUSTER_IDENTITY_SQL}  where you applied it and compare to`);
      console.log(`  the cluster line above. Different number = a different database.`);
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
            // `cluster` is what makes an archived evidence file comparable to a later one:
            // "ready = NO" is only meaningful alongside which database it was asked of.
            target: { host_class: hostClass(url), database: where?.db ?? null, cluster: identity },
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
