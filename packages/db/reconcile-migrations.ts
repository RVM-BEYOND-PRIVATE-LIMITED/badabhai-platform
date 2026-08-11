/**
 * Reconcile the Drizzle migration journal against what is ACTUALLY in the live database.
 *
 * WHY THIS EXISTS. `drizzle.__drizzle_migrations` records 47 of the repo's 74 migrations, so 27
 * are unrecorded — but "unrecorded" is NOT the same as "unapplied". Some unrecorded migrations'
 * objects are already live (created by hand, or by an earlier differently-numbered copy on a
 * stale branch — exactly the situation adopt-0066.ts was written for). Running `pnpm db:migrate`
 * against that state dies on the first "already exists" and blocks every LATER migration too.
 *
 * Before the org-as-tenant migration adds `org_id` to the payer-owned business tables, we must
 * know, per migration, which of three states it is in:
 *
 *   RECORDED            — in the journal table; drizzle will skip it. Nothing to do.
 *   UNRECORDED / LIVE   — not in the journal, but its objects EXIST. Needs ADOPTION (record the
 *                         row without re-running the DDL), else db:migrate breaks on it.
 *   UNRECORDED / ABSENT — not in the journal and its objects do NOT exist. Genuinely pending;
 *                         db:migrate will apply it normally.
 *   UNRECORDED / PARTIAL— SOME objects exist and some do not. THE DANGEROUS ONE. Neither adopt
 *                         nor migrate is safe; it needs hand reconciliation.
 *
 * READ-ONLY BY CONSTRUCTION. This script issues SELECTs against catalog views only. There is no
 * --apply path, no INSERT, no DDL. It cannot modify anything, deliberately: the decision about
 * what to adopt is a human one, and adopting a PARTIAL migration would hide real drift from
 * every future migration.
 *
 *   npx tsx reconcile-migrations.ts              # full report
 *   npx tsx reconcile-migrations.ts --org-only   # only the org_id target tables
 *   npx tsx reconcile-migrations.ts --json       # machine-readable
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";
import postgres from "postgres";

config({ path: "../../.env" });
config({ path: ".env" });

const ORG_ONLY = process.argv.includes("--org-only");
const AS_JSON = process.argv.includes("--json");

/**
 * The payer-owned business tables that the org-as-tenant migration will add `org_id` to
 * (DATABASE_AUDIT.md PAY-DB-01). If ANY of these is touched by an unrecorded migration, the
 * Phase 3 backfill would run against an assumption that is already false.
 */
const ORG_TARGET_TABLES = [
  "unlocks",
  "payer_credits",
  "credit_ledger",
  "posting_plans",
  "posting_boosts",
  "resume_disclosures",
  "payer_capacity",
  "payment_orders",
  "job_postings",
  "jobs",
  "agency_invites",
  "agency_kyc",
  "agency_payout_requests",
  "agency_payout_accruals",
  "referral_links",
  "payer_job_posting_chat_sessions",
  "payer_job_posting_chat_messages",
  "payer_form_drafts",
];

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

/** An object a migration creates, that we can check for in the live catalog. */
type Obj =
  | { kind: "table"; table: string }
  | { kind: "column"; table: string; column: string }
  | { kind: "index"; index: string };

const unquote = (s: string): string => s.replace(/^"|"$/g, "");

/**
 * Extract the checkable objects a migration's DDL creates.
 *
 * Drizzle-generated SQL is highly regular, which makes this tractable — but it IS a heuristic.
 * It deliberately looks only at CREATE TABLE / ADD COLUMN / CREATE INDEX, because those are the
 * statements whose presence is unambiguous in the catalog. Constraints, RLS, REVOKEs, data
 * backfills and DROPs are NOT checked: a migration reported ABSENT on these grounds may still
 * have had its non-object effects applied. Treat the output as evidence, not proof.
 */
function extractObjects(sql: string): Obj[] {
  const objs: Obj[] = [];
  const stripped = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");

  for (const m of stripped.matchAll(
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[\w.]+"?)/gi,
  )) {
    const t = unquote(m[1]!).split(".").pop()!;
    objs.push({ kind: "table", table: t });
  }

  // `[^;]*?` — NOT `[\s\S]*?`. A non-greedy any-char span silently crosses statement
  // boundaries and pairs the table from one statement with the column from a later one:
  // `ALTER TABLE "agency_kyc" ENABLE ROW LEVEL SECURITY; … ALTER TABLE "agency_invites" ADD
  // COLUMN "attributed_at"` was mis-read as agency_kyc.attributed_at, producing three bogus
  // PARTIAL verdicts. Statements end at `;`, so the span must never contain one.
  for (const m of stripped.matchAll(
    /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?("?[\w.]+"?)[^;]*?ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?("?\w+"?)/gi,
  )) {
    objs.push({
      kind: "column",
      table: unquote(m[1]!).split(".").pop()!,
      column: unquote(m[2]!),
    });
  }

  for (const m of stripped.matchAll(
    /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?("?\w+"?)/gi,
  )) {
    objs.push({ kind: "index", index: unquote(m[1]!) });
  }

  return objs;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  // Show WHICH database — never credentials. This must never be ambiguous.
  const parsed = new URL(url);
  const target = `host=${parsed.hostname} db=${parsed.pathname.slice(1)}`;
  if (!AS_JSON) console.log(`[reconcile] target ${target}\n[reconcile] READ-ONLY — no writes\n`);

  const migrationsDir = join(process.cwd(), "migrations");
  const journal = JSON.parse(
    readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8"),
  ) as { entries: JournalEntry[] };

  const sql = postgres(url, { max: 1 });

  try {
    // ── live catalog snapshot ────────────────────────────────────────────────────────────
    const cols = await sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public'
    `;
    const liveTables = new Set(cols.map((r) => r.table_name));
    const liveCols = new Set(cols.map((r) => `${r.table_name}.${r.column_name}`));

    const idx = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
    `;
    const liveIdx = new Set(idx.map((r) => r.indexname));

    const recordedRows = await sql<{ created_at: string }[]>`
      SELECT created_at FROM drizzle.__drizzle_migrations
    `;
    const recorded = new Set(recordedRows.map((r) => String(r.created_at)));

    // ── classify every migration ────────────────────────────────────────────────────────
    const report = journal.entries.map((e) => {
      const isRecorded = recorded.has(String(e.when));
      let ddl = "";
      try {
        ddl = readFileSync(join(migrationsDir, `${e.tag}.sql`), "utf8");
      } catch {
        return { ...e, state: "FILE-MISSING", present: 0, absent: 0, missing: [], tables: [] };
      }
      const objs = extractObjects(ddl);
      const missing: string[] = [];
      let present = 0;

      for (const o of objs) {
        const ok =
          o.kind === "table"
            ? liveTables.has(o.table)
            : o.kind === "column"
              ? liveCols.has(`${o.table}.${o.column}`)
              : liveIdx.has(o.index);
        if (ok) present += 1;
        else
          missing.push(
            o.kind === "table"
              ? `table ${o.table}`
              : o.kind === "column"
                ? `column ${o.table}.${o.column}`
                : `index ${o.index}`,
          );
      }

      const tables = [
        ...new Set(objs.flatMap((o) => (o.kind === "index" ? [] : [o.table]))),
      ];

      const state = isRecorded
        ? "RECORDED"
        : objs.length === 0
          ? "UNRECORDED / NO-CHECKABLE-OBJECTS"
          : missing.length === 0
            ? "UNRECORDED / LIVE — needs ADOPTION"
            : present === 0
              ? "UNRECORDED / ABSENT — genuinely pending"
              : "UNRECORDED / PARTIAL — ⚠ HAND RECONCILE";

      return { ...e, state, present, absent: missing.length, missing, tables };
    });

    const unrecorded = report.filter((r) => !r.state.startsWith("RECORDED"));
    const partial = report.filter((r) => r.state.includes("PARTIAL"));
    const needsAdoption = report.filter((r) => r.state.includes("ADOPTION"));
    const pending = report.filter((r) => r.state.includes("ABSENT"));

    // Which unrecorded migrations touch a table org_id will land on?
    const orgRisk = unrecorded.filter((r) =>
      r.tables.some((t) => ORG_TARGET_TABLES.includes(t)),
    );

    if (AS_JSON) {
      console.log(JSON.stringify({ target, report, orgRisk }, null, 2));
      return;
    }

    if (!ORG_ONLY) {
      console.log("TAG                                        STATE");
      console.log("─".repeat(96));
      for (const r of report) {
        const mark = r.state.startsWith("RECORDED") ? " " : r.state.includes("PARTIAL") ? "⚠" : "•";
        console.log(`${mark} ${r.tag.padEnd(42)} ${r.state}`);
        if (!r.state.startsWith("RECORDED") && r.missing.length > 0) {
          for (const m of r.missing.slice(0, 6)) console.log(`      ✗ ${m}`);
          if (r.missing.length > 6) console.log(`      … +${r.missing.length - 6} more`);
        }
      }
      console.log("");
    }

    console.log("═".repeat(96));
    console.log(`journal entries      : ${report.length}`);
    console.log(`recorded in DB       : ${report.length - unrecorded.length}`);
    console.log(`UNRECORDED           : ${unrecorded.length}`);
    console.log(`  ├─ live (adopt)    : ${needsAdoption.length}`);
    console.log(`  ├─ absent (pending): ${pending.length}`);
    console.log(`  └─ PARTIAL (⚠)     : ${partial.length}`);
    console.log("");
    console.log("── org_id target tables (Phase 3 backfill) ──");
    if (orgRisk.length === 0) {
      console.log("✓ NO unrecorded migration touches any org_id target table.");
      console.log("  The Phase 3 backfill assumption holds.");
    } else {
      console.log(`⚠ ${orgRisk.length} unrecorded migration(s) TOUCH org_id target tables:`);
      for (const r of orgRisk) {
        const hit = r.tables.filter((t) => ORG_TARGET_TABLES.includes(t));
        console.log(`  ⚠ ${r.tag} → ${hit.join(", ")}  [${r.state}]`);
      }
      console.log("\n  Phase 3 MUST NOT start until each of these is reconciled — the backfill");
      console.log("  would otherwise run against a schema that differs from the migration set.");
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("[reconcile] failed:", err);
  process.exit(1);
});
