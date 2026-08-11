/**
 * Adopt ALREADY-APPLIED migrations into the Drizzle journal — generalized from adopt-0066.ts.
 *
 * THE PROBLEM. `drizzle.__drizzle_migrations` records 47 of the repo's 74 migrations. The other
 * 27 are unrecorded but their DDL is already live (created by hand, or by differently-numbered
 * copies on stale branches). `pnpm db:migrate` therefore reaches 0048 — the first unrecorded
 * migration carrying DDL — and dies on "already exists", which blocks EVERY later migration
 * including the org-as-tenant one. See GAP-DB-19.
 *
 * THE FIX. Record those migrations as applied WITHOUT re-running their DDL. That is only safe if
 * what is in the database actually matches what each migration would have created, so this
 * script VERIFIES FIRST, AT DEPTH, and refuses to record anything on any mismatch.
 *
 * DEPTH (per migration, matching adopt-0066.ts rather than a presence-only heuristic):
 *   • tables exist
 *   • every column exists AND its data_type matches the declared type
 *   • every CREATE INDEX exists
 *   • every ADD CONSTRAINT exists
 *   • ENABLE / FORCE ROW LEVEL SECURITY is actually enabled / forced
 *
 * SAFETY RAILS — this writes to a live database, so:
 *   • verify-only by default; --apply is required to write
 *   • --apply additionally REQUIRES --expect-host <substring>, matched against the real host,
 *     so it is impossible to adopt against the wrong environment by having the wrong .env loaded
 *   • ALL-OR-NOTHING: if any selected migration fails verification, NOTHING is recorded
 *   • --only <tag,tag,...> pins the exact set, so a later drift cannot silently widen the scope
 *   • an unrecognised SQL type is a HARD FAILURE, never a silent pass (fail closed)
 *
 *   npx tsx adopt-migrations.ts                                  # verify every unrecorded one
 *   npx tsx adopt-migrations.ts --only 0048_empty_archangel      # verify a subset
 *   npx tsx adopt-migrations.ts --apply --expect-host db.staging # verify, then record
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";
import postgres from "postgres";

config({ path: "../../.env" });
config({ path: ".env" });

const argv = process.argv;
const APPLY = argv.includes("--apply");
const flag = (name: string): string => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? "") : "";
};
const DOCTOR = argv.includes("--doctor");
const FORCE_RLS_FOR = flag("--force-rls-for");
const EXPECT_HOST = flag("--expect-host");
const ONLY = flag("--only")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

/**
 * Declared-SQL-type → information_schema.data_type.
 *
 * Deliberately NOT a permissive fallback: an unmapped type raises, because silently treating an
 * unknown type as "matches" is exactly how a partly-applied migration would get adopted.
 */
function normalizeType(declared: string): string {
  // The column regex captures the type PLUS any trailing modifiers ("uuid PRIMARY KEY DEFAULT
  // gen_random_uuid", "boolean DEFAULT false NOT NULL"). Cut at the first modifier keyword.
  // Multi-word types survive because none of them contains one of these words.
  const raw = declared.trim().replace(/\s+/g, " ");
  const cut = raw.search(
    /\b(NOT\s+NULL|NULL|DEFAULT|PRIMARY\s+KEY|REFERENCES|UNIQUE|CHECK|GENERATED|COLLATE)\b/i,
  );
  const t = (cut >= 0 ? raw.slice(0, cut) : raw).trim().toLowerCase();
  if (/^varchar\(|^character varying/.test(t)) return "character varying";
  if (/^numeric|^decimal/.test(t)) return "numeric";
  if (/^vector\(/.test(t)) return "USER-DEFINED";
  // information_schema reports every array type as the literal "ARRAY" (e.g. `text[]`).
  if (/\[\s*\]$/.test(t)) return "ARRAY";
  const map: Record<string, string> = {
    text: "text",
    uuid: "uuid",
    boolean: "boolean",
    integer: "integer",
    int: "integer",
    serial: "integer",
    bigint: "bigint",
    smallint: "smallint",
    jsonb: "jsonb",
    json: "json",
    date: "date",
    "double precision": "double precision",
    real: "real",
    "timestamp with time zone": "timestamp with time zone",
    "timestamp without time zone": "timestamp without time zone",
    timestamp: "timestamp without time zone",
  };
  const hit = map[t];
  if (hit === undefined) throw new Error(`unmapped SQL type "${declared}" — refusing to guess`);
  return hit;
}

interface Expect {
  tables: Set<string>;
  columns: Map<string, string>; // "table.column" -> expected data_type
  indexes: Set<string>;
  constraints: Set<string>;
  rlsEnabled: Set<string>;
  rlsForced: Set<string>;
}

/**
 * Postgres truncates identifiers at 63 bytes (NAMEDATALEN-1), so a longer generated FK name in
 * the migration is stored truncated in pg_constraint. Comparing the untruncated name reports a
 * false MISSING — four of them on the first full-depth run.
 */
const pgIdent = (s: string): string => Buffer.from(s, "utf8").subarray(0, 63).toString("utf8");

const unquote = (s: string): string => s.replace(/^"|"$/g, "").split(".").pop()!;

function parseMigration(sql: string): Expect {
  const e: Expect = {
    tables: new Set(),
    columns: new Map(),
    indexes: new Set(),
    constraints: new Set(),
    rlsEnabled: new Set(),
    rlsForced: new Set(),
  };
  const src = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");

  // CREATE TABLE "x" ( "col" type ..., CONSTRAINT ... )
  for (const m of src.matchAll(
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[\w.]+"?)\s*\(([\s\S]*?)\n\s*\);/gi,
  )) {
    const table = unquote(m[1]!);
    e.tables.add(table);
    for (const raw of splitTopLevel(m[2]!)) {
      const line = raw.trim();
      if (!line || /^(CONSTRAINT|PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK)\b/i.test(line)) continue;
      const cm = /^("?\w+"?)\s+([a-z0-9_ ]+(?:\(\d+(?:,\s*\d+)?\))?(?:\s*\[\])?)/i.exec(line);
      if (cm) e.columns.set(`${table}.${unquote(cm[1]!)}`, normalizeType(cm[2]!));
    }
  }

  // ALTER TABLE ... ADD COLUMN — `[^;]*?` so the span can never cross a statement boundary
  // (a `[\s\S]*?` span silently pairs one statement's table with a later statement's column).
  for (const m of src.matchAll(
    /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?("?[\w.]+"?)[^;]*?ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?("?\w+"?)\s+([a-z0-9_ ]+(?:\(\d+(?:,\s*\d+)?\))?(?:\s*\[\])?)/gi,
  )) {
    e.columns.set(`${unquote(m[1]!)}.${unquote(m[2]!)}`, normalizeType(m[3]!));
  }

  for (const m of src.matchAll(
    /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?("?\w+"?)/gi,
  ))
    e.indexes.add(unquote(m[1]!));

  // Offsets, not a regex built from the constraint name. Interpolating a name into `new RegExp`
  // alongside a `[\s\S]*` span is a ReDoS shape (semgrep detect-non-literal-regexp) and is also
  // needlessly indirect: the actual question is "was this constraint dropped AFTER its last
  // add?", which is a comparison of two offsets. Drop-then-re-add keeps the constraint;
  // add-then-drop, or a bare drop, does not.
  const lastAddAt = new Map<string, number>();
  for (const m of src.matchAll(/ADD\s+CONSTRAINT\s+("?\w+"?)/gi)) {
    const name = unquote(m[1]!);
    e.constraints.add(name);
    lastAddAt.set(name, m.index ?? 0);
  }
  for (const m of src.matchAll(/DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?("?\w+"?)/gi)) {
    const name = unquote(m[1]!);
    const addedAt = lastAddAt.get(name);
    if (addedAt === undefined || (m.index ?? 0) > addedAt) e.constraints.delete(name);
  }

  for (const m of src.matchAll(
    /ALTER\s+TABLE\s+("?[\w.]+"?)\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi,
  ))
    e.rlsEnabled.add(unquote(m[1]!));
  for (const m of src.matchAll(/ALTER\s+TABLE\s+("?[\w.]+"?)\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/gi))
    e.rlsForced.add(unquote(m[1]!));

  return e;
}

/** Split a CREATE TABLE body on commas that are not inside parentheses. */
function splitTopLevel(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const parsed = new URL(url);
  const host = parsed.hostname;
  console.log(`[adopt] target host=${host} db=${parsed.pathname.slice(1)}`);
  console.log(`[adopt] mode=${APPLY ? "APPLY (writes)" : "VERIFY-ONLY (read-only)"}`);

  if (APPLY) {
    if (!EXPECT_HOST) {
      console.error(
        "[adopt] REFUSING: --apply requires --expect-host <substring>.\n" +
          "        The wrong .env is the likeliest way to adopt against the wrong database.",
      );
      process.exitCode = 1;
      return;
    }
    if (!host.includes(EXPECT_HOST)) {
      console.error(
        `[adopt] REFUSING: --expect-host "${EXPECT_HOST}" does not match host "${host}".`,
      );
      process.exitCode = 1;
      return;
    }
  }

  const dir = join(process.cwd(), "migrations");
  const journal = JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8")) as {
    entries: JournalEntry[];
  };

  const sql = postgres(url, { max: 1 });
  try {
    if (DOCTOR) {
      // Pre-flight. `FORCE ROW LEVEL SECURITY` makes RLS apply to the table OWNER too. With ZERO
      // policies in this schema, forcing a table the API's role owns WITHOUT bypassrls would deny
      // the API all access to it. So: is the connection role bypassrls, and who owns the tables?
      const me = await sql<{ u: string; su: boolean; brls: boolean }[]>`
        SELECT current_user u, rolsuper su, rolbypassrls brls
          FROM pg_roles WHERE rolname = current_user`;
      console.log(`\n[doctor] role=${me[0]!.u} superuser=${me[0]!.su} bypassrls=${me[0]!.brls}`);
      console.log(
        me[0]!.brls || me[0]!.su
          ? "[doctor] → FORCE RLS is SAFE for this connection (it bypasses RLS regardless)."
          : "[doctor] → ⚠ FORCE RLS would DENY this connection on any table it owns (zero policies).",
      );
      const own = await sql<{ relname: string; owner: string; forced: boolean; n: string }[]>`
        SELECT c.relname, pg_get_userbyid(c.relowner) owner, c.relforcerowsecurity forced,
               (SELECT count(*) FROM pg_class x WHERE x.oid=c.oid)::text n
          FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
         WHERE ns.nspname='public' AND c.relkind='r' AND NOT c.relforcerowsecurity
         ORDER BY c.relname`;
      console.log(`\n[doctor] tables with RLS enabled but NOT forced (${own.length}):`);
      for (const r of own) console.log(`   ${r.relname.padEnd(26)} owner=${r.owner}`);

      // Will `drizzle-kit migrate` skip everything? It matches a recorded row by created_at AND
      // the sha256 of the migration file. A hash mismatch means drizzle would try to RE-APPLY a
      // migration whose DDL is already live — the exact "already exists" failure we just cleared.
      const rows = await sql<{ hash: string; created_at: string }[]>`
        SELECT hash, created_at FROM drizzle.__drizzle_migrations`;
      const byWhen = new Map(rows.map((r) => [String(r.created_at), r.hash]));
      const bad: string[] = [];
      let matched = 0;
      for (const e of journal.entries) {
        const stored = byWhen.get(String(e.when));
        if (stored === undefined) {
          bad.push(`${e.tag}: NOT RECORDED`);
          continue;
        }
        const actual = createHash("sha256")
          .update(readFileSync(join(dir, `${e.tag}.sql`)))
          .digest("hex");
        if (stored === actual) matched += 1;
        else bad.push(`${e.tag}: hash mismatch (stored ${stored.slice(0, 12)}… vs file ${actual.slice(0, 12)}…)`);
      }
      console.log(`\n[doctor] journal hash check: ${matched}/${journal.entries.length} match`);
      if (bad.length === 0) console.log("[doctor] → `pnpm db:migrate` will skip all migrations (no DDL).");
      else for (const b of bad) console.log(`   ✗ ${b}`);
      console.log("");
      return;
    }

    if (FORCE_RLS_FOR) {
      // Complete a PARTIALLY-applied migration by running exactly the FORCE ROW LEVEL SECURITY
      // statements that migration itself declares — never a table it does not name. Scope comes
      // from the .sql file, so it cannot creep.
      const entry = journal.entries.find((e) => e.tag === FORCE_RLS_FOR);
      if (!entry) throw new Error(`unknown migration "${FORCE_RLS_FOR}"`);
      const exp = parseMigration(readFileSync(join(dir, `${entry.tag}.sql`), "utf8"));
      const declared = [...exp.rlsForced];
      const live = await sql<{ relname: string; forced: boolean }[]>`
        SELECT c.relname, c.relforcerowsecurity forced FROM pg_class c
          JOIN pg_namespace ns ON ns.oid=c.relnamespace
         WHERE ns.nspname='public' AND c.relkind='r'`;
      const forcedNow = new Set(live.filter((r) => r.forced).map((r) => r.relname));
      const todo = declared.filter((t) => !forcedNow.has(t));
      console.log(`\n[force-rls] ${entry.tag} declares FORCE on ${declared.length} table(s)`);
      console.log(`[force-rls] already forced: ${declared.length - todo.length} | to fix: ${todo.length}`);
      for (const t of todo) console.log(`   → ${t}`);
      if (todo.length === 0) {
        console.log("[force-rls] nothing to do.");
        return;
      }
      if (!APPLY) {
        console.log("[force-rls] verify-only. Re-run with --apply --expect-host <host>.");
        return;
      }
      for (const t of todo) {
        await sql.unsafe(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
        console.log(`[force-rls] forced ${t}`);
      }
      const after = await sql<{ relname: string; forced: boolean }[]>`
        SELECT c.relname, c.relforcerowsecurity forced FROM pg_class c
          JOIN pg_namespace ns ON ns.oid=c.relnamespace
         WHERE ns.nspname='public' AND c.relkind='r' AND c.relname = ANY(${declared})`;
      console.log("[force-rls] verify:");
      for (const r of after) console.log(`   ${r.forced ? "OK  " : "FAIL"} ${r.relname} forced=${r.forced}`);
      return;
    }

    const recordedRows = await sql<{ created_at: string }[]>`
      SELECT created_at FROM drizzle.__drizzle_migrations`;
    const recorded = new Set(recordedRows.map((r) => String(r.created_at)));

    let targets = journal.entries.filter((e) => !recorded.has(String(e.when)));
    if (ONLY.length > 0) {
      const want = new Set(ONLY);
      const unknown = ONLY.filter((t) => !journal.entries.some((e) => e.tag === t));
      if (unknown.length > 0) throw new Error(`--only names unknown migrations: ${unknown.join(", ")}`);
      targets = targets.filter((e) => want.has(e.tag));
    }
    console.log(`[adopt] recorded=${recorded.size} unrecorded=${journal.entries.length - recorded.size} selected=${targets.length}\n`);
    if (targets.length === 0) {
      console.log("[adopt] nothing to do.");
      return;
    }

    // live catalog
    const cols = await sql<{ table_name: string; column_name: string; data_type: string }[]>`
      SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE table_schema='public'`;
    const liveTables = new Set(cols.map((r) => r.table_name));
    const liveCols = new Map(cols.map((r) => [`${r.table_name}.${r.column_name}`, r.data_type]));
    const liveIdx = new Set(
      (await sql<{ indexname: string }[]>`SELECT indexname FROM pg_indexes WHERE schemaname='public'`).map(
        (r) => r.indexname,
      ),
    );
    const liveCons = new Set(
      (await sql<{ conname: string }[]>`SELECT conname FROM pg_constraint`).map((r) => r.conname),
    );
    const rlsRows = await sql<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relkind='r'`;
    const rlsOn = new Set(rlsRows.filter((r) => r.relrowsecurity).map((r) => r.relname));
    const rlsForced = new Set(rlsRows.filter((r) => r.relforcerowsecurity).map((r) => r.relname));

    const clean: JournalEntry[] = [];
    const dirty: { tag: string; problems: string[] }[] = [];

    for (const entry of targets) {
      let exp: Expect;
      try {
        exp = parseMigration(readFileSync(join(dir, `${entry.tag}.sql`), "utf8"));
      } catch (err) {
        const problems = [`parse failed: ${(err as Error).message}`];
        dirty.push({ tag: entry.tag, problems });
        // Log here too — an early `continue` that skips the reporting below makes a parse
        // failure look like a silent success in the per-migration output.
        console.log(`  ✗ ${entry.tag} — ${problems[0]}`);
        continue;
      }
      const problems: string[] = [];
      for (const t of exp.tables) if (!liveTables.has(t)) problems.push(`table ${t} MISSING`);
      for (const [key, want] of exp.columns) {
        const got = liveCols.get(key);
        if (got === undefined) problems.push(`column ${key} MISSING`);
        else if (got !== want) problems.push(`column ${key} is ${got}, expected ${want}`);
      }
      for (const i of exp.indexes) if (!liveIdx.has(pgIdent(i))) problems.push(`index ${i} MISSING`);
      for (const c of exp.constraints) if (!liveCons.has(pgIdent(c))) problems.push(`constraint ${c} MISSING`);
      for (const t of exp.rlsEnabled) if (!rlsOn.has(t)) problems.push(`${t}: RLS not enabled`);
      for (const t of exp.rlsForced) if (!rlsForced.has(t)) problems.push(`${t}: RLS not FORCED`);

      if (problems.length === 0) {
        clean.push(entry);
        console.log(`  ✓ ${entry.tag}`);
      } else {
        dirty.push({ tag: entry.tag, problems });
        console.log(`  ✗ ${entry.tag} — ${problems.length} mismatch(es)`);
        for (const p of problems.slice(0, 8)) console.log(`      ${p}`);
        if (problems.length > 8) console.log(`      … +${problems.length - 8} more`);
      }
    }

    console.log(`\n[adopt] clean=${clean.length} mismatched=${dirty.length}`);

    if (dirty.length > 0) {
      console.error(
        "\n[adopt] REFUSING to record ANYTHING — all-or-nothing.\n" +
          "        The live schema is not what these migrations would have created. Adopting\n" +
          "        would hide that difference from every future migration, permanently.",
      );
      process.exitCode = 1;
      return;
    }
    if (!APPLY) {
      console.log("[adopt] verify-only. Re-run with --apply --expect-host <host> to record.");
      return;
    }

    // Drizzle stores a plain sha256 of the migration FILE contents, ordered by created_at.
    await sql.begin(async (tx) => {
      for (const entry of clean) {
        const hash = createHash("sha256")
          .update(readFileSync(join(dir, `${entry.tag}.sql`)))
          .digest("hex");
        await tx`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${hash}, ${entry.when})`;
      }
    });
    console.log(`[adopt] recorded ${clean.length} migration(s). \`pnpm db:migrate\` can now proceed.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("[adopt] failed:", err);
  process.exit(1);
});
