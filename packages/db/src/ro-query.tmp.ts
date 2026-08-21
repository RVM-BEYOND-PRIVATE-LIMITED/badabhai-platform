/**
 * TEMPORARY read-only SQL runner for the job_domain_alias -> skill_alias coverage
 * investigation. Not shipped; delete once the report lands.
 *
 * Usage:  pnpm -C packages/db exec tsx src/ro-query.tmp.ts <path-to-sql-file>
 *
 * Hard read-only: every statement runs inside one READ ONLY transaction, so any
 * accidental DML aborts instead of mutating production.
 *
 * A file may carry many labelled queries, separated by a line that is exactly `-- @@`.
 */
import { readFileSync } from "node:fs";
import { config } from "dotenv";
import { createDbClient } from "./client";

config({ path: "../../.env" });

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) throw new Error("usage: tsx src/ro-query.tmp.ts <sql-file>");
  const body = readFileSync(file, "utf8");
  const blocks = body
    .split(/^--\s*@@\s*$/m)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const { sql: pg } = createDbClient(url, { max: 1 });

  try {
    await pg.begin(async (tx) => {
      await tx.unsafe("SET TRANSACTION READ ONLY");
      for (const block of blocks) {
        const firstLine = block.split("\n")[0];
        const label = firstLine.startsWith("--") ? firstLine.replace(/^--\s*/, "") : "query";
        const rows = await tx.unsafe(block);
        console.log(`\n===== ${label} =====`);
        console.log(JSON.stringify(rows, null, 2));
      }
    });
  } finally {
    await pg.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
