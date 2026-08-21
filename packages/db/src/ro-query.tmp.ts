/**
 * READ-ONLY ad-hoc query runner. Temporary (`.tmp.ts`, untracked).
 *
 * Opens ONE connection and runs every statement inside a single
 * `SET TRANSACTION READ ONLY` transaction, so any DML aborts.
 *
 * Usage: pnpm exec tsx src/ro-query.tmp.ts <absolute path to .sql>
 * Blocks are separated by a line that is exactly `-- @@`; the first line of a
 * block should be a `-- label` comment, echoed as the section header.
 */
import { readFileSync } from "node:fs";
import { sql as dsql } from "drizzle-orm";
import { config } from "dotenv";
import { createDbClient } from "./client";

config({ path: "../../.env" });
config();

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) throw new Error("usage: ro-query.tmp.ts <file.sql>");
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL not set");

  const blocks = readFileSync(file, "utf8")
    .split(/^-- @@\s*$/m)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  const { db, sql } = createDbClient(url, { max: 1 });
  try {
    await db.transaction(async (tx) => {
      await tx.execute(dsql`SET TRANSACTION READ ONLY`);
      for (const block of blocks) {
        const label = block.split("\n")[0]?.replace(/^--\s*/, "") ?? "(unlabelled)";
        try {
          const rows = (await tx.execute(dsql.raw(block))) as unknown as Record<
            string,
            unknown
          >[];
          console.log(`\n===== ${label} (${rows.length} rows) =====`);
          for (const r of rows) console.log(JSON.stringify(r));
        } catch (e: unknown) {
          console.log(
            `\n===== ${label} =====\nERROR: ${
              e instanceof Error ? e.message.split("\n")[0] : String(e)
            }`,
          );
        }
      }
    });
  } finally {
    await sql.end();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
