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
import { existsSync, writeFileSync } from "node:fs";

import { sql as dsql } from "drizzle-orm";

import { createDbClient } from "./client";
import { hostClass } from "./audit-embedding-provenance";
import {
  SCHEMA_REQUIREMENTS,
  contractBlockReason,
  evaluateContract,
  uniqueIndexMatches,
  type PresenceMap,
} from "./schema-contract";

config();

const SCRIPT = "audit:schema-contract";

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
    console.log(`\n  ready for the code on main? = ${blocked === null ? "YES" : `NO — ${blocked}`}`);
    if (blocked !== null) {
      console.log(`  remedy: pnpm --filter @badabhai/db db:migrate   (against THIS database)`);
      process.exitCode = 1;
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
