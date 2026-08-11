/**
 * READ-ONLY inventory of tables that exist in the database but appear in NO migration and NO
 * Drizzle schema file (GAP-DB-21).
 *
 * WHY. Production carries 69 public tables; the repo models 65. Four are invisible to the repo:
 * agency_profiles, employer_profiles, payer_capabilities, payer_member_invites. Before the
 * org-as-tenant migration re-scopes `payer_members`, we must know whether its unmodelled sibling
 * `payer_member_invites` holds live invite state — a second source of truth the backfill would
 * silently inherit.
 *
 * Read-only: SELECTs against catalog views plus COUNT(*). No column VALUES are printed — these
 * tables may hold PII, and an inventory needs shape and volume, not contents.
 *
 *   npx tsx inspect-unmodelled.ts
 */
import { config } from "dotenv";
import postgres from "postgres";

config({ path: "../../.env" });
config({ path: ".env" });

const TABLES = [
  "agency_profiles",
  "employer_profiles",
  "payer_capabilities",
  "payer_member_invites",
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const parsed = new URL(url);
  console.log(`[inspect] target host=${parsed.hostname} db=${parsed.pathname.slice(1)}`);
  console.log("[inspect] READ-ONLY — shape + row counts only, never column values\n");

  const sql = postgres(url, { max: 1 });
  try {
    for (const t of TABLES) {
      const cols = await sql<{ column_name: string; data_type: string; is_nullable: string }[]>`
        SELECT column_name, data_type, is_nullable FROM information_schema.columns
         WHERE table_schema='public' AND table_name=${t}
         ORDER BY ordinal_position`;
      if (cols.length === 0) {
        console.log(`── ${t}: DOES NOT EXIST\n`);
        continue;
      }
      const [{ n }] = await sql<{ n: string }[]>`SELECT count(*)::text n FROM ${sql(t)}`.catch(
        () => [{ n: "?" }],
      );
      const idx = await sql<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename=${t}`;
      const fks = await sql<{ def: string }[]>`
        SELECT pg_get_constraintdef(c.oid) def FROM pg_constraint c
          JOIN pg_class r ON r.oid=c.conrelid
         WHERE r.relname=${t} AND c.contype='f'`;
      const rls = await sql<{ en: boolean; fo: boolean }[]>`
        SELECT relrowsecurity en, relforcerowsecurity fo FROM pg_class WHERE relname=${t}`;

      console.log(`── ${t}  ROWS=${n}  RLS(enabled=${rls[0]?.en} forced=${rls[0]?.fo})`);
      for (const c of cols)
        console.log(`     ${c.column_name.padEnd(28)} ${c.data_type}${c.is_nullable === "NO" ? " NOT NULL" : ""}`);
      if (fks.length) for (const f of fks) console.log(`     FK: ${f.def}`);
      console.log(`     indexes: ${idx.map((i) => i.indexname).join(", ") || "(none)"}`);
      console.log("");
    }

    // The decisive Phase 3 question: is payer_member_invites live state that overlaps payer_members?
    const cmp = await sql<{ t: string; n: string }[]>`
      SELECT 'payer_members' t, count(*)::text n FROM payer_members
      UNION ALL SELECT 'payer_member_invites', count(*)::text FROM payer_member_invites`.catch(
      () => [],
    );
    if (cmp.length) {
      console.log("── Phase 3 overlap check");
      for (const r of cmp) console.log(`     ${r.t.padEnd(24)} rows=${r.n}`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("[inspect] failed:", err);
  process.exit(1);
});
