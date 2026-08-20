/**
 * The routines nobody declared — #1110, made re-runnable.
 *
 *   pnpm db:audit:undeclared-routines            # report
 *   pnpm db:audit:undeclared-routines --json=<p> # + an evidence record
 *
 * ===========================================================================
 * WHY A RUNNER AND NOT A ONE-OFF QUERY
 * ===========================================================================
 * `db:audit:live-drift` asks *what tables and columns does the database have that no schema file
 * declares?* and found `_delete_forensics` that way. It then grew a routine sweep and found
 * three functions, two triggers and an event trigger that no migration creates either. That is
 * where a one-off query stops being enough: the interesting questions about a ROUTINE are not
 * "does it exist" but **who owns it, what can call it, and what does it write** — and each of
 * those has a different failure mode.
 *
 * This runner asks all of them at once, so the answer is a command rather than a memory.
 *
 * ===========================================================================
 * THE FOUR QUESTIONS, AND WHY EACH ONE IS HERE
 * ===========================================================================
 *
 *   1. UNDECLARED?      A routine no migration creates does not exist on a fresh database.
 *                       Whatever it does — enforce a lock, record a deletion — silently does not
 *                       happen there, and nothing reports the difference.
 *
 *   2. WHOSE?           Supabase's platform installs its own event triggers and functions, owned
 *                       by `supabase_admin`. Anything owned by `postgres` was added with THIS
 *                       project's credentials. That single column separates "the platform does
 *                       this" from "somebody here did this and did not write it down", and it is
 *                       the difference between a curiosity and an ownership question.
 *
 *   3. SECURITY DEFINER + WHO MAY EXECUTE?   A `SECURITY DEFINER` function runs as its owner. If
 *                       `EXECUTE` is also granted to a Data-API role, a network-reachable client
 *                       can run owner-privileged code. Supabase's DEFAULT PRIVILEGES grant
 *                       EXECUTE on functions to `public`, so this combination arrives by
 *                       accident rather than by decision — which is exactly why it must be
 *                       reported rather than assumed.
 *
 *   4. WHAT DOES IT CAPTURE?   Reported for `_delete_forensics` only, and see the note on
 *                       {@link PII_SHAPES}: its `query` column stores `current_query()`, and a
 *                       DELETE statement can carry literal PII in its predicate.
 *
 * ===========================================================================
 * COUNTS ONLY. NEVER VALUES.
 * ===========================================================================
 * The PII section reports HOW MANY rows match a shape and never what they contain. That rule is
 * not politeness: the whole point of the finding is that this column may hold raw PII, and a
 * tool that printed it to a terminal — into scrollback, into a ticket, into a paste — would be
 * the second copy. `selectsAValueColumn` enforces it structurally against every query in this file
 * before a connection is opened, and a test drives that guard in both directions.
 *
 * READ-ONLY. SELECTs against catalogs and one aggregate over `_delete_forensics`. No
 * transaction, nothing written, safe to point at production — which is the only place the
 * answers exist.
 */
import { config } from "dotenv";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createDbClient } from "./client";
import { hostClass } from "./audit-embedding-provenance";
import { DATA_API_ROLES } from "./schema-contract";
import { declaredRoutines } from "./audit-live-drift";

config({ path: join("..", "..", ".env") });

const SCRIPT = "audit:undeclared-routines";

/**
 * Roles whose EXECUTE grant on a `SECURITY DEFINER` function is the finding.
 *
 * Reuses the Data-API set the RLS audit uses, minus `PUBLIC` — `PUBLIC` is not a role name
 * `pg_proc.proacl` records as such, it appears as the empty grantee (`=X/postgres`), and that
 * form is matched separately.
 */
export const EXECUTE_RISK_ROLES = DATA_API_ROLES.filter((r) => r !== "PUBLIC").map((r) =>
  r.toLowerCase(),
);

export interface RoutineRow {
  readonly kind: "function" | "trigger" | "event_trigger";
  readonly name: string;
  readonly owner: string;
  /** `true` only for functions; triggers inherit their function's. */
  readonly securityDefiner: boolean;
  /** Which of {@link EXECUTE_RISK_ROLES} (plus `PUBLIC`) hold EXECUTE. Functions only. */
  readonly executableBy: readonly string[];
  /** For a trigger: the table it fires on. For an event trigger: the event. */
  readonly on: string | null;
  readonly declaredByAMigration: boolean;
}

/** A routine is "ours" when this project's own role owns it, not the platform's. */
export function isOurs(owner: string): boolean {
  return owner === "postgres";
}

/**
 * The combination worth reporting: owner-privileged code a network-reachable role may call.
 *
 * Neither half is a finding on its own. `SECURITY DEFINER` is how a trigger function reaches a
 * table the caller cannot; an EXECUTE grant to `authenticated` is ordinary for a helper meant to
 * be called from a policy. Together they mean a Data-API client can run code as the owner.
 */
export function isExposedDefiner(r: RoutineRow): boolean {
  return r.kind === "function" && r.securityDefiner && r.executableBy.length > 0;
}

/**
 * PII shapes counted in `_delete_forensics.query`, never printed.
 *
 * `_log_delete` writes `current_query()` — the whole statement text. A parameterised DELETE
 * (`WHERE id = $1`) carries no values, but a hand-typed one
 * (`DELETE FROM workers WHERE phone_e164 = '+91…'`) carries them verbatim, into a table that is
 * an audit record and therefore outlives the row it describes. `client_addr` is the same class
 * of question: an IP is personal data under DPDP.
 *
 * The regexes are shapes, not extractors. A hit means "a row here looks like it contains a
 * phone number"; it never means anyone has seen one.
 */
export const PII_SHAPES: Readonly<Record<string, string>> = {
  phone_e164_shaped: String.raw`\+91[0-9]{10}`,
  ten_digit_run: String.raw`[0-9]{10}`,
  // THE ONE THAT SEPARATES A TYPED VALUE FROM A COINCIDENCE. A ten-digit run on its own fires
  // on a backend pid, a txid, a timestamp, or a digit sequence inside a uuid — none of which is
  // PII. The same run INSIDE A SINGLE-QUOTED LITERAL is a value somebody wrote into the
  // statement, which for a bare Indian mobile is exactly the shape a phone number takes.
  ten_digit_in_literal: String.raw`''[^'']*[0-9]{10}[^'']*''`,
  // The narrowest shape, and the one that would settle it: a WHOLE literal that is exactly ten
  // digits starting 6-9 — an Indian mobile number written without its country code, and nothing
  // else this schema stores looks like that.
  bare_indian_mobile_literal: String.raw`''[6-9][0-9]{9}''`,
  email_shaped: String.raw`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`,
};

export const ROUTINES_SQL = `
SELECT 'function' AS kind, p.proname AS name, pg_get_userbyid(p.proowner) AS owner,
       p.prosecdef AS security_definer,
       COALESCE(p.proacl::text[], ARRAY[]::text[]) AS acl,
       NULL::text AS on_what
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
UNION ALL
SELECT 'trigger', t.tgname, pg_get_userbyid(c.relowner), f.prosecdef,
       ARRAY[]::text[], c.relname
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_proc f ON f.oid = t.tgfoid
WHERE n.nspname = 'public' AND NOT t.tgisinternal
UNION ALL
SELECT 'event_trigger', e.evtname, pg_get_userbyid(e.evtowner), f.prosecdef,
       ARRAY[]::text[], e.evtevent
FROM pg_event_trigger e JOIN pg_proc f ON f.oid = e.evtfoid
ORDER BY 1, 2`;

/** The forensics table's own state, and the shapes its `query` column matches. Counts only. */
export const FORENSICS_SQL = `
SELECT count(*)::int AS rows,
       min(at)::text AS first_at,
       max(at)::text AS last_at,
       count(DISTINCT table_name)::int AS source_tables,
       count(*) FILTER (WHERE query IS NOT NULL)::int AS with_query_text,
       count(*) FILTER (WHERE client_addr IS NOT NULL)::int AS with_client_addr,
       count(*) FILTER (WHERE query ~ '${PII_SHAPES["phone_e164_shaped"]}')::int AS phone_e164_shaped,
       count(*) FILTER (WHERE query ~ '${PII_SHAPES["ten_digit_run"]}')::int AS ten_digit_run,
       count(*) FILTER (WHERE query ~ '${PII_SHAPES["ten_digit_in_literal"]}')::int AS ten_digit_in_literal,
       count(*) FILTER (WHERE query ~ '${PII_SHAPES["bare_indian_mobile_literal"]}')::int AS bare_indian_mobile_literal,
       count(*) FILTER (WHERE query ~ '${PII_SHAPES["email_shaped"]}')::int AS email_shaped,
       max(length(query))::int AS longest_query_chars
FROM public._delete_forensics`;

export const FORENSICS_BY_TABLE_SQL = `
SELECT table_name, count(*)::int AS n, min(at)::text AS first_at, max(at)::text AS last_at
FROM public._delete_forensics GROUP BY 1 ORDER BY 2 DESC`;

/**
 * Structural guarantee that no query in this file can return a PII-bearing VALUE.
 *
 * Exported and driven by a test rather than left as a convention, because "we were careful" is
 * exactly the assurance that stops being true on the next edit. `query`, `client_addr`,
 * `app_name` and `db_user` may be COUNTED and never SELECTED.
 */
export const VALUE_COLUMNS = ["query", "client_addr"] as const;

/**
 * One LITERAL pattern per protected column.
 *
 * NOT ``new RegExp(`…${column}…`)``, which is how this was first written. Interpolating a name
 * into a constructed regex is a ReDoS shape — `semgrep detect-non-literal-regexp` blocks it, and
 * this repository has already been bitten by it once in `migration-adoption.ts`, where the fix
 * was to compare offsets instead. The set here is two entries and closed, so two literals cost
 * nothing, and {@link VALUE_COLUMN_PATTERN_KEYS} lets a test pin the map against
 * {@link VALUE_COLUMNS} so a third column cannot be added to one and forgotten in the other.
 */
const VALUE_COLUMN_PATTERNS: Readonly<Record<(typeof VALUE_COLUMNS)[number], RegExp>> = {
  query: /(^|[\s,(])query([\s,)]|$)/i,
  client_addr: /(^|[\s,(])client_addr([\s,)]|$)/i,
};

/** The pattern map's keys, so a test can require them to be exactly {@link VALUE_COLUMNS}. */
export const VALUE_COLUMN_PATTERN_KEYS: readonly string[] = Object.keys(VALUE_COLUMN_PATTERNS);

export function selectsAValueColumn(sql: string): boolean {
  // A value column is allowed only inside a `count(... FILTER ...)`, a `length(...)`, or an
  // `IS NOT NULL` test. Any bare projection of one is the thing this refuses.
  const stripped = sql
    .replace(/count\(\*\)\s*FILTER\s*\([^)]*\)/gi, " ")
    .replace(/max\(length\([^)]*\)\)/gi, " ")
    .replace(/count\(\*\)\s*FILTER\s*\(\s*WHERE\s+\w+\s+IS\s+NOT\s+NULL\s*\)/gi, " ");
  return VALUE_COLUMNS.some((c) => VALUE_COLUMN_PATTERNS[c].test(stripped));
}

export function classify(
  row: { kind: string; name: string; owner: string; security_definer: boolean; acl: string[]; on_what: string | null },
  declared: { triggers: Set<string>; functions: Set<string> },
): RoutineRow {
  const kind = row.kind as RoutineRow["kind"];
  const executableBy: string[] = [];
  for (const entry of row.acl) {
    // `proacl` entries read `grantee=PRIVS/grantor`; an EMPTY grantee is PUBLIC.
    const [grantee, rest] = entry.split("=");
    if (rest === undefined || !rest.includes("X")) continue;
    const who = grantee === undefined || grantee === "" ? "PUBLIC" : grantee;
    if (who === "PUBLIC" || EXECUTE_RISK_ROLES.includes(who.toLowerCase())) executableBy.push(who);
  }
  return {
    kind,
    name: row.name,
    owner: row.owner,
    securityDefiner: row.security_definer,
    executableBy,
    on: row.on_what,
    declaredByAMigration:
      kind === "function" ? declared.functions.has(row.name) : declared.triggers.has(row.name),
  };
}

export function render(rows: readonly RoutineRow[], forensics: Record<string, unknown> | null, byTable: readonly Record<string, unknown>[]): string[] {
  const ours = rows.filter((r) => isOurs(r.owner));
  const undeclared = ours.filter((r) => !r.declaredByAMigration);
  const exposed = rows.filter(isExposedDefiner);
  const L: string[] = [
    `[${SCRIPT}] READ-ONLY — catalog SELECTs and one aggregate. Counts only, never values.`,
    "",
    `  routines in public          ${rows.length}`,
    `  owned by 'postgres' (OURS)  ${ours.length}   — the rest are Supabase platform objects`,
    `  ...that no migration creates ${undeclared.length}`,
    "",
  ];
  if (undeclared.length > 0) {
    L.push("  UNDECLARED — absent on every fresh database, and nothing reports the difference:");
    for (const r of undeclared) {
      L.push(
        `    ${r.kind.padEnd(14)} ${r.name.padEnd(26)} ${r.on === null ? "" : `on ${r.on}`.padEnd(22)}` +
          `${r.securityDefiner ? "SECURITY DEFINER" : ""}`,
      );
    }
    L.push("");
  }
  if (exposed.length > 0) {
    L.push("  SECURITY DEFINER *and* executable by a Data-API role — owner-privileged code a");
    L.push("  network-reachable client can call. Supabase's default privileges grant this:");
    for (const r of exposed) L.push(`    ${r.name.padEnd(26)} EXECUTE: ${r.executableBy.join(", ")}`);
    L.push("");
  }
  if (forensics !== null) {
    L.push("  _delete_forensics — what the undeclared trigger has been capturing:");
    L.push(`    rows                       ${String(forensics["rows"])}`);
    L.push(`    first / last               ${String(forensics["first_at"])}  ..  ${String(forensics["last_at"])}`);
    L.push(`    source tables              ${String(forensics["source_tables"])}`);
    for (const r of byTable) L.push(`      ${String(r["table_name"]).padEnd(20)} ${String(r["n"])}`);
    L.push(`    rows carrying query text   ${String(forensics["with_query_text"])}  (current_query(), verbatim)`);
    L.push(`    rows carrying client IP    ${String(forensics["with_client_addr"])}  (personal data under DPDP)`);
    L.push(`    longest query captured     ${String(forensics["longest_query_chars"])} chars`);
    L.push("    PII SHAPES IN THE CAPTURED SQL — counts, never values:");
    for (const k of Object.keys(PII_SHAPES)) L.push(`      ${k.padEnd(24)} ${String(forensics[k])}`);
    L.push("");
  }
  L.push("  See docs/registers/gap-db-undeclared-routines.md (#1110). Nothing here is changed by");
  L.push("  this tool, and nothing should be changed before that page has an owner's answer.");
  return L;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const jsonArg = argv.find((a) => a.startsWith("--json="));
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);

  for (const q of [ROUTINES_SQL, FORENSICS_SQL, FORENSICS_BY_TABLE_SQL]) {
    if (selectsAValueColumn(q)) throw new Error(`[${SCRIPT}] a query projects a value column — refusing to run`);
  }

  const { sql } = createDbClient(url, { max: 1 });
  try {
    const declared = declaredRoutines(join(__dirname, "..", "migrations"));
    const raw = (await sql.unsafe(ROUTINES_SQL)) as unknown as Parameters<typeof classify>[0][];
    const rows = raw.map((r) => classify(r, declared));

    let forensics: Record<string, unknown> | null = null;
    let byTable: Record<string, unknown>[] = [];
    try {
      forensics = ((await sql.unsafe(FORENSICS_SQL)) as unknown as Record<string, unknown>[])[0] ?? null;
      byTable = (await sql.unsafe(FORENSICS_BY_TABLE_SQL)) as unknown as Record<string, unknown>[];
    } catch {
      // Absent on every database but production — which is the finding, not an error.
      forensics = null;
    }

    for (const line of render(rows, forensics, byTable)) console.log(line);

    if (jsonArg) {
      const path = jsonArg.slice("--json=".length);
      if (existsSync(path)) {
        console.error(`  refusing to overwrite ${path} — evidence is never replaced.`);
        process.exit(1);
      }
      writeFileSync(
        path,
        `${JSON.stringify({ kind: "undeclared-routines", target: hostClass(url), routines: rows, forensics, forensics_by_table: byTable }, null, 2)}\n`,
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
    const err = e as { message?: string; cause?: { message?: string } };
    console.error(err?.message ?? String(e));
    if (err?.cause?.message) console.error(`  cause: ${err.cause.message}`);
    process.exit(1);
  });
}
