/**
 * Adopt a PRE-EXISTING job-domain catalog into the Drizzle journal (migration 0066).
 *
 * WHY THIS EXISTS. `job_domain` / `job_domain_alias` were created by hand (or by the
 * earlier 0060-numbered copy of this migration on the stale branch) and seeded with the
 * ISCO-08 + NCO-2015 corpus. `drizzle.__drizzle_migrations` has no row for 0066, so
 * `drizzle-kit migrate` re-runs its `CREATE TABLE` and dies with "already exists" —
 * blocking every LATER migration too.
 *
 * The fix is to record 0066 as applied WITHOUT re-running its DDL. That is only safe if
 * what is actually in the database matches what 0066 would have created, so this script
 * VERIFIES FIRST and refuses to record anything on a mismatch. Read-only unless --apply.
 *
 *   npx tsx adopt-0066.ts            # verify only
 *   npx tsx adopt-0066.ts --apply    # verify, then record 0066 as applied
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { config } from "dotenv";
import postgres from "postgres";

config({ path: "../../.env" });
config({ path: ".env" });

const MIGRATION = "0066_special_pyro";
// From packages/db/migrations/meta/_journal.json — the `when` of idx 66. Drizzle stores
// this verbatim as created_at, and orders by it.
const WHEN = 1785913956589;

const APPLY = process.argv.includes("--apply");
// NOTE the guard on -1: `indexOf` returns -1 when the flag is absent, and argv[-1 + 1]
// is argv[0] — the node executable. Without this the script hashes the node binary and
// writes a journal row Drizzle will never match, so it re-applies 0066 anyway.
const SQL_FLAG = process.argv.indexOf("--sql");
const SQL_PATH = SQL_FLAG >= 0 ? (process.argv[SQL_FLAG + 1] ?? "") : "";

interface Expect {
  table: string;
  columns: Record<string, string>;
}

// The shape 0066 creates. data_type strings are exactly what information_schema reports.
const EXPECTED: Expect[] = [
  {
    table: "job_domain",
    columns: {
      job_domain_id: "text",
      label_en: "text",
      label_hi: "text",
      description_en: "text",
      source: "text",
      source_code: "text",
      level: "smallint",
      parent_job_domain_id: "text",
      isco_major_code: "text",
      isco_unit_code: "text",
      skill_level: "smallint",
      industry_id: "text",
      canonical_role_id: "text",
      selectable: "boolean",
      status: "text",
      version: "integer",
      replaced_by: "text",
      created_at: "timestamp with time zone",
      updated_at: "timestamp with time zone",
    },
  },
  {
    table: "job_domain_alias",
    columns: {
      id: "uuid",
      job_domain_id: "text",
      text: "text",
      lang: "text",
      source: "text",
      embedding: "USER-DEFINED", // vector(768)
      embedding_model: "text",
      embedded_at: "timestamp with time zone",
      created_at: "timestamp with time zone",
    },
  },
];

const WORKER_PROFILE_COLUMNS = [
  "job_domain_id",
  "job_domain_match_score",
  "job_domain_match_status",
  "job_domain_matched_at",
];

const REQUIRED_INDEXES = [
  "job_domain_alias_embedding_hnsw",
  "job_domain_alias_job_domain_id_idx",
  "job_domain_source_code_uq",
  "job_domain_selectable_idx",
  "worker_profiles_job_domain_id_idx",
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  // Show WHICH database, so this is never run against the wrong one by accident.
  const parsed = new URL(url);
  console.log(`[adopt] target host=${parsed.hostname} db=${parsed.pathname.slice(1)}`);

  const sql = postgres(url, { max: 1 });
  const problems: string[] = [];

  try {
    // 1. Is 0066 already recorded?
    const existing = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM drizzle.__drizzle_migrations WHERE created_at = ${WHEN}
    `;
    if (Number(existing[0]!.n) > 0) {
      console.log(`[adopt] ${MIGRATION} is ALREADY recorded — nothing to do.`);
      return;
    }

    // 2. Do the tables exist at all? If not, this is the wrong tool: just migrate.
    for (const { table, columns } of EXPECTED) {
      const rows = await sql<{ column_name: string; data_type: string }[]>`
        SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = ${table}
      `;
      if (rows.length === 0) {
        problems.push(
          `table "${table}" does NOT exist — do not adopt, run \`pnpm db:migrate\` normally`,
        );
        continue;
      }
      const actual = new Map(rows.map((r) => [r.column_name, r.data_type]));
      for (const [col, type] of Object.entries(columns)) {
        const got = actual.get(col);
        if (got === undefined) problems.push(`${table}.${col} MISSING`);
        else if (got !== type) problems.push(`${table}.${col} is ${got}, expected ${type}`);
      }
      for (const col of actual.keys()) {
        if (!(col in columns)) problems.push(`${table}.${col} is UNEXPECTED (not in 0066)`);
      }
    }

    // 3. The four worker_profiles columns.
    const wp = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'worker_profiles'
         AND column_name LIKE 'job_domain%'
    `;
    const wpSet = new Set(wp.map((r) => r.column_name));
    for (const col of WORKER_PROFILE_COLUMNS) {
      if (!wpSet.has(col)) problems.push(`worker_profiles.${col} MISSING`);
    }

    // 4. Indexes — the HNSW one especially: without it retrieval degrades silently.
    const idx = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename IN ('job_domain', 'job_domain_alias', 'worker_profiles')
    `;
    const idxSet = new Set(idx.map((r) => r.indexname));
    for (const name of REQUIRED_INDEXES) {
      if (!idxSet.has(name)) problems.push(`index ${name} MISSING`);
    }

    // 5. RLS must be ENABLED and FORCED on both new tables.
    const rls = await sql<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relname IN ('job_domain', 'job_domain_alias')
    `;
    for (const r of rls) {
      if (!r.relrowsecurity) problems.push(`${r.relname}: ROW LEVEL SECURITY not enabled`);
      if (!r.relforcerowsecurity) problems.push(`${r.relname}: RLS not FORCED`);
    }

    // 6. Catalog size, for the record.
    const counts = await sql<{ domains: string; aliases: string }[]>`
      SELECT (SELECT count(*) FROM job_domain) AS domains,
             (SELECT count(*) FROM job_domain_alias) AS aliases
    `.catch(() => [{ domains: "?", aliases: "?" }]);
    console.log(`[adopt] catalog: domains=${counts[0]!.domains} aliases=${counts[0]!.aliases}`);

    if (problems.length > 0) {
      console.error(`[adopt] REFUSING to adopt — ${problems.length} mismatch(es):`);
      for (const p of problems) console.error(`  ✗ ${p}`);
      console.error(
        "\n[adopt] The live schema is NOT what 0066 would have created. Recording it as " +
          "applied would hide that difference from every future migration. Reconcile the " +
          "schema first.",
      );
      process.exitCode = 1;
      return;
    }

    console.log("[adopt] the live schema matches 0066 exactly (columns, indexes, RLS).");

    if (!APPLY) {
      console.log("[adopt] verify-only. Re-run with --apply to record it.");
      return;
    }

    // The hash Drizzle stores is a plain sha256 of the migration FILE contents — verified
    // against an already-recorded row before this script was written.
    const path = SQL_PATH || `migrations/${MIGRATION}.sql`;
    const hash = createHash("sha256").update(readFileSync(path)).digest("hex");

    await sql`
      INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${hash}, ${WHEN})
    `;
    console.log(`[adopt] recorded ${MIGRATION} (hash=${hash.slice(0, 12)}…).`);
    console.log("[adopt] `pnpm db:migrate` will now skip it and continue past 0066.");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("[adopt] failed:", err);
  process.exit(1);
});
