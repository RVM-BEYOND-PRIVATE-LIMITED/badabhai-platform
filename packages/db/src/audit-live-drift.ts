/**
 * `db:audit:live-drift` — READ-ONLY. What does the live database have that the Drizzle schema
 * does not declare, and what does the schema declare that the database does not have?
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT `db:audit:schema-contract`.
 *
 * `schema-contract` answers "are the objects a NAMED migration promised actually present?" — it
 * is a whitelist, and it can only ever check what someone thought to write down. Twice now this
 * repository has been surprised by the complement of that question:
 *
 *   - `GAP-DB-21` — four tables (`agency_profiles`, `employer_profiles`, `payer_capabilities`,
 *     `payer_member_invites`) exist on production, in NO migration and NO schema file. They were
 *     found by an RLS sweep that happened to enumerate `pg_class`, not by anything looking for
 *     undeclared tables. They are the reason `0082` needed a `to_regclass` guard.
 *   - An orphan `drizzle.__drizzle_migrations` row (`created_at=1787230000000`, 2026-08-20) —
 *     production had a migration applied from a checkout that never reached `main`.
 *
 * Both are the same shape: the database is ahead of the repository, and every tool pointed the
 * other way. This one points here. It is deliberately blunt — names only, no types, no
 * constraint depth — because its job is to say WHERE to look, and `schema-contract` is what says
 * whether a specific promise held.
 *
 * IT DOES NOT FAIL ON UNDECLARED OBJECTS BY DEFAULT. A monorepo legitimately carries tables
 * Drizzle does not model (Supabase's own, extension-owned, and the four above until they are
 * ruled on). Pass `--strict` to exit non-zero on any drift; the default exit code is 1 only for
 * the direction that is unambiguously wrong — DECLARED BUT ABSENT, which means code is compiled
 * against a column the database does not have.
 */
import { config } from "dotenv";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sql as dsql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

import { createDbClient } from "./client";
import { hostClass } from "./audit-embedding-provenance";
import * as schema from "./schema";

config({ path: join("..", "..", ".env") });

const SCRIPT = "audit:live-drift";

/**
 * Tables the database owns and Drizzle is never expected to model. Matched as exact names or as
 * a prefix ending in `_`. Keep this list SHORT and justified — every entry is a thing this audit
 * has been told to stop looking at.
 */
export const NOT_OURS: readonly string[] = [
  // Drizzle's own bookkeeping lives in the `drizzle` schema, not `public`; listed for the reader.
  "__drizzle_migrations",
  // pgvector / pg_trgm and friends create no public tables today. Left empty on purpose:
  // an extension table appearing here is exactly the surprise this tool is for.
];

export interface LiveTable {
  readonly table: string;
  readonly columns: readonly string[];
}

export interface DeclaredTable {
  readonly table: string;
  readonly columns: readonly string[];
}

export interface RoutineDrift {
  /** Trigger names on public tables that no migration file creates. */
  readonly undeclaredTriggers: readonly string[];
  /** Function names in `public` that no migration file creates, extension-owned excluded. */
  readonly undeclaredFunctions: readonly string[];
}

export interface Drift {
  /** In the database, declared by no Drizzle table. The `GAP-DB-21` direction. */
  readonly undeclaredTables: readonly string[];
  /** Declared by Drizzle, absent from the database. Code compiled against nothing. */
  readonly missingTables: readonly string[];
  /** Table present both sides; column in the database that Drizzle does not declare. */
  readonly undeclaredColumns: readonly string[];
  /** Table present both sides; column Drizzle declares that the database does not have. */
  readonly missingColumns: readonly string[];
}

/**
 * Trigger and function names any migration file CREATEs.
 *
 * Drizzle models neither, so unlike tables there is no schema object to compare against — the
 * migration text is the only declaration that exists. As of 2026-08-20 the answer is the empty
 * set: `grep -iE "create (or replace )?(function|trigger)"` over all 83 files matches nothing,
 * so every routine in production's `public` schema is undeclared. That is the finding, not a
 * bug in this parser.
 */
/**
 * What the migration TEXT declares. Three sets rather than two, because #1110 declared an EVENT
 * trigger and an event trigger is not a trigger: `undeclaredEventTriggers` is computed from a
 * `pg_event_trigger` read, so matching it against table triggers would have reported `ensure_rls`
 * as undeclared forever no matter what any migration said.
 */
export type DeclaredRoutines = {
  triggers: Set<string>;
  functions: Set<string>;
  eventTriggers: Set<string>;
};

export function declaredRoutines(migrationsDir: string): DeclaredRoutines {
  const triggers = new Set<string>();
  const functions = new Set<string>();
  const eventTriggers = new Set<string>();
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith(".sql"))) {
    const sql = readFileSync(join(migrationsDir, f), "utf8");
    // ORDER MATTERS. `CREATE EVENT TRIGGER` is matched FIRST and its name is deliberately NOT
    // added to `triggers`: an event trigger lives in `pg_event_trigger`, a table trigger in
    // `pg_trigger`, and they are compared against different catalog reads. Conflating them would
    // let a table trigger read as declared because an event trigger happened to share its name.
    //
    // The table-trigger pattern below cannot match an event trigger anyway — after `CREATE` it
    // allows only an optional `CONSTRAINT`, so the `EVENT` keyword fails it — but that is a
    // property of the regex rather than an intention, so the intention is written here.
    for (const m of sql.matchAll(/CREATE\s+EVENT\s+TRIGGER\s+"?([\w]+)"?/gi)) eventTriggers.add(m[1]!);
    for (const m of sql.matchAll(/CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\s+"?([\w]+)"?/gi)) triggers.add(m[1]!);
    for (const m of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?public"?\.)?"?([\w]+)"?/gi)) {
      functions.add(m[1]!);
    }
  }
  return { triggers, functions, eventTriggers };
}

/** `true` when the database owns this name and we never expect to model it. */
export function isNotOurs(table: string): boolean {
  return NOT_OURS.some((p) => (p.endsWith("_") ? table.startsWith(p) : table === p));
}

/**
 * Compare the two sides. Pure — the whole point is that the comparison is testable without a
 * database, so a fixture can pin every direction of the four.
 */
export function drift(live: readonly LiveTable[], declared: readonly DeclaredTable[]): Drift {
  const liveByName = new Map(live.map((t) => [t.table, t]));
  const declByName = new Map(declared.map((t) => [t.table, t]));

  const undeclaredTables = live
    .map((t) => t.table)
    .filter((t) => !declByName.has(t) && !isNotOurs(t))
    .sort();
  const missingTables = declared
    .map((t) => t.table)
    .filter((t) => !liveByName.has(t))
    .sort();

  const undeclaredColumns: string[] = [];
  const missingColumns: string[] = [];
  for (const d of declared) {
    const l = liveByName.get(d.table);
    if (l === undefined) continue; // already reported as a missing TABLE; do not double-count
    const liveCols = new Set(l.columns);
    const declCols = new Set(d.columns);
    for (const c of l.columns) if (!declCols.has(c)) undeclaredColumns.push(`${d.table}.${c}`);
    for (const c of d.columns) if (!liveCols.has(c)) missingColumns.push(`${d.table}.${c}`);
  }

  return {
    undeclaredTables,
    missingTables,
    undeclaredColumns: undeclaredColumns.sort(),
    missingColumns: missingColumns.sort(),
  };
}

/** Every `pgTable` the schema barrel exports, as name + column names. */
export function declaredTables(): DeclaredTable[] {
  const out: DeclaredTable[] = [];
  for (const value of Object.values(schema)) {
    if (!(value instanceof PgTable)) continue;
    const cfg = getTableConfig(value);
    if (cfg.schema !== undefined && cfg.schema !== "public") continue;
    out.push({ table: cfg.name, columns: cfg.columns.map((c) => c.name).sort() });
  }
  // A table can be exported twice under different aliases; collapse by name.
  const byName = new Map(out.map((t) => [t.table, t]));
  return [...byName.values()].sort((a, b) => a.table.localeCompare(b.table));
}

/** True when nothing at all differs. */
export function isClean(d: Drift): boolean {
  return (
    d.undeclaredTables.length === 0 &&
    d.missingTables.length === 0 &&
    d.undeclaredColumns.length === 0 &&
    d.missingColumns.length === 0
  );
}

function report(label: string, items: readonly string[], note: string): void {
  console.log(`\n  ${label} = ${items.length}`);
  if (items.length === 0) return;
  console.log(`    ${note}`);
  for (const i of items) console.log(`      ${i}`);
}

async function main(): Promise<void> {
  const strict = process.argv.slice(2).includes("--strict");
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);

  const { db, sql } = createDbClient(url, { max: 1 });
  try {
    console.log(`[${SCRIPT}] READ-ONLY.`);
    console.log(`  target = ${hostClass(url)}`);

    const rows = (await db.execute(
      dsql`SELECT c.relname AS tbl, a.attname AS col
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_attribute a ON a.attrelid = c.oid
            WHERE n.nspname = 'public'
              AND c.relkind = 'r'
              AND a.attnum > 0
              AND NOT a.attisdropped
            ORDER BY c.relname, a.attname`,
    )) as unknown as { tbl: string; col: string }[];

    const byTable = new Map<string, string[]>();
    for (const r of rows) {
      const cols = byTable.get(r.tbl);
      if (cols === undefined) byTable.set(r.tbl, [r.col]);
      else cols.push(r.col);
    }
    const live: LiveTable[] = [...byTable.entries()].map(([table, columns]) => ({ table, columns }));
    const declared = declaredTables();
    const d = drift(live, declared);

    console.log(`  live public tables = ${live.length}`);
    console.log(`  declared by Drizzle = ${declared.length}`);

    report(
      "UNDECLARED tables (in the DB, in no schema file)",
      d.undeclaredTables,
      "the GAP-DB-21 direction — a migration cannot reference these safely without a guard",
    );
    report(
      "MISSING tables (declared, absent from the DB)",
      d.missingTables,
      "code is compiled against a table that does not exist — this is always a defect",
    );
    report(
      "UNDECLARED columns",
      d.undeclaredColumns,
      "present live on a table Drizzle models — usually an out-of-band ALTER",
    );
    report(
      "MISSING columns",
      d.missingColumns,
      "declared on a modelled table and absent live — this is always a defect",
    );

    // ---- ROUTINES ---------------------------------------------------------------------------
    // Added after the table sweep found `_delete_forensics` (147 rows) but could NOT have found
    // the trigger and function that fill it — those came from a hand query, which is exactly the
    // gap this tool exists to remove. A trigger is the most consequential thing that can be
    // undeclared: it fires during someone else's migration or backfill, and the person running
    // it has no way to know it is there. See #1110.
    const routines = declaredRoutines(join(__dirname, "..", "migrations"));

    const trg = (await db.execute(
      dsql`SELECT t.tgname AS name, c.relname AS tbl
             FROM pg_trigger t
             JOIN pg_class c ON c.oid = t.tgrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE NOT t.tgisinternal AND n.nspname = 'public'
            ORDER BY c.relname, t.tgname`,
    )) as unknown as { name: string; tbl: string }[];

    // `deptype = 'e'` is extension membership. pgvector and friends install functions into
    // `public`, and listing those as drift would bury the rows that matter.
    const fns = (await db.execute(
      dsql`SELECT p.proname AS name
             FROM pg_proc p
             JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public'
              AND NOT EXISTS (
                SELECT 1 FROM pg_depend dep
                 WHERE dep.objid = p.oid AND dep.classid = 'pg_proc'::regclass AND dep.deptype = 'e')
            ORDER BY p.proname`,
    )) as unknown as { name: string }[];

    // EVENT triggers are not in `pg_trigger` and were the last blind spot — and the one that
    // mattered most. `ensure_rls` (ddl_command_end -> rls_auto_enable) AUTO-ENABLES RLS on every
    // table created in `public`. It is a live safety mechanism that exists in no migration, and
    // it is why GAP-DB-21's four tables read as RLS-enabled while still being FORCE-less and
    // fully granted: the trigger enables, and does nothing else. It made them LOOK protected,
    // which is a large part of why R39 went unnoticed.
    const evt = (await db.execute(
      dsql`SELECT e.evtname AS name, e.evtevent AS event, p.proname AS fn
             FROM pg_event_trigger e
             JOIN pg_proc p ON p.oid = e.evtfoid
            ORDER BY e.evtname`,
    )) as unknown as { name: string; event: string; fn: string }[];

    const undeclaredTriggers = trg
      .filter((t) => !routines.triggers.has(t.name))
      .map((t) => `${t.tbl}.${t.name}`);
    const undeclaredEventTriggers = evt
      .filter((e) => !routines.eventTriggers.has(e.name))
      .map((e) => `${e.name} (${e.event} -> ${e.fn}())`);
    const undeclaredFunctions = fns.filter((f) => !routines.functions.has(f.name)).map((f) => f.name);

    console.log(
      `\n  routines declared by migrations = ${routines.triggers.size} trigger(s), ` +
        `${routines.functions.size} function(s), ${routines.eventTriggers.size} event trigger(s)`,
    );
    report(
      "UNDECLARED triggers (public)",
      undeclaredTriggers,
      "fires during any write, including someone else's migration, and appears in no file",
    );
    report(
      "UNDECLARED functions (public, non-extension)",
      undeclaredFunctions,
      "no migration creates these — a fresh database will not have them",
    );
    report(
      "UNDECLARED event triggers",
      undeclaredEventTriggers,
      "fire on DDL itself. Supabase installs most of these; `ensure_rls` is the one that changes " +
        "what a CREATE TABLE means, so read this list before concluding a new table is unprotected",
    );

    const routinesClean =
      undeclaredTriggers.length === 0 && undeclaredFunctions.length === 0 && undeclaredEventTriggers.length === 0;
    if (isClean(d) && routinesClean) {
      console.log(`\n  the live schema and the Drizzle schema agree, name for name.`);
      return;
    }

    // Only the "declared but absent" directions are unambiguously broken. Undeclared objects are
    // a question, not a verdict — see the header.
    const broken = d.missingTables.length + d.missingColumns.length;
    if (broken > 0) {
      console.log(`\n  ${broken} DECLARED-BUT-ABSENT object(s). Code expects these; the database does not have them.`);
      process.exitCode = 1;
    } else if (strict) {
      console.log(`\n  --strict: drift present.`);
      process.exitCode = 1;
    } else {
      console.log(`\n  no declared-but-absent objects. The drift above is the database being AHEAD`);
      console.log(`  of the repository — rule on each one; pass --strict to make it a failure.`);
    }
  } finally {
    await sql.end();
  }
}

if (process.argv[1]?.includes("audit-live-drift")) void main();
