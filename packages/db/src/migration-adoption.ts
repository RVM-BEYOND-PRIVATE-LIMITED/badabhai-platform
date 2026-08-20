/**
 * Can this already-applied migration be RECORDED as applied without re-running its DDL?
 *
 * ===========================================================================
 * WHAT ADOPTION IS, AND THE ONE WAY IT CAN GO WRONG
 * ===========================================================================
 * `drizzle.__drizzle_migrations` records 76 of this repo's 81 migrations. The other five are
 * unrecorded and their DDL is already live, applied out of band. `drizzle-kit migrate` replays
 * every unrecorded file in order, so it reaches the first one, dies on *already exists*, and
 * blocks every later migration — including whichever one someone actually wanted to apply.
 *
 * Adoption fixes that by writing the journal row WITHOUT running the DDL. Which means the whole
 * safety of the operation rests on one question: **is what is in the database actually what this
 * migration would have created?** Get that wrong and the journal now asserts something false,
 * permanently, and every future migration inherits the lie — `db:migrate` will skip a migration
 * whose effects were never applied, and nothing will ever look again.
 *
 * So this module is the verifier, and it is deliberately paranoid. It is pure: it takes the
 * migration text and a snapshot of the live catalog and returns the list of reasons NOT to
 * adopt. That makes every rule here testable without a database, which matters, because the
 * rules are the product.
 *
 * ===========================================================================
 * THE TWO BLIND SPOTS THIS MODULE EXISTS TO CLOSE
 * ===========================================================================
 * The first version of this checker verified tables, columns *and their types*, indexes,
 * constraints, and RLS enable/force. That is real depth and it caught real drift. It also had
 * two holes, and both of them are how a migration gets recorded as applied when it was not:
 *
 *   GRANTS WERE NEVER CHECKED. `0048` declares `FORCE ROW LEVEL SECURITY` plus four `REVOKE ALL`
 *   statements per table. Its tables, columns, indexes, constraints and RLS flags were all
 *   verified present, so it was adopted clean — and to this day `anon`, `authenticated` and
 *   `service_role` hold every DML privilege plus TRUNCATE on all three of its tables. That is
 *   R39. The one tool positioned to catch it passed it, and the pass is what stopped anyone
 *   looking. A REVOKE is not decoration in this schema; on `service_role`, which has
 *   `rolbypassrls = true`, it is the ONLY control there is.
 *
 *   NOTHING-TO-CHECK COUNTED AS EVERYTHING-CHECKED. A migration whose statements are all
 *   backfills, DROPs, `ALTER COLUMN`s, triggers, views or dynamic SQL parses to an EMPTY
 *   expectation set — and an empty set has no unmet members, so it was reported clean and
 *   adopted on no evidence whatsoever. {@link vacuous} makes that a refusal instead.
 *
 * Fail closed in both directions: an unrecognised SQL type raises rather than being treated as
 * a match, and a `DO $$` block is a refusal rather than an assumption, because what dynamic SQL
 * does cannot be read off the file.
 */

/** What a migration claims to have created, as far as it can be read from its text. */
export interface Expect {
  readonly tables: Set<string>;
  /** "table.column" -> expected `information_schema.data_type`. */
  readonly columns: Map<string, string>;
  readonly indexes: Set<string>;
  readonly constraints: Set<string>;
  readonly rlsEnabled: Set<string>;
  readonly rlsForced: Set<string>;
  /** "table:role" — the role must hold NO privilege on the table afterwards. */
  readonly revoked: Set<string>;
  /** The file contains `DO $$ … $$` or `EXECUTE`, whose effect cannot be read statically. */
  dynamicSql: boolean;
}

/** A snapshot of the live database, in the shape {@link verifyAgainst} compares against. */
export interface LiveCatalog {
  readonly tables: ReadonlySet<string>;
  /** "table.column" -> actual `information_schema.data_type`. */
  readonly columns: ReadonlyMap<string, string>;
  readonly indexes: ReadonlySet<string>;
  readonly constraints: ReadonlySet<string>;
  readonly rlsEnabled: ReadonlySet<string>;
  readonly rlsForced: ReadonlySet<string>;
  /** "table:role", role lowercased — one entry per grantee holding ANY privilege. */
  readonly grants: ReadonlySet<string>;
}

/**
 * Declared-SQL-type → `information_schema.data_type`.
 *
 * Deliberately NOT a permissive fallback: an unmapped type raises, because silently treating an
 * unknown type as "matches" is exactly how a partly-applied migration would get adopted.
 */
export function normalizeType(declared: string): string {
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

/**
 * Postgres truncates identifiers at 63 bytes (NAMEDATALEN-1), so a longer generated FK name in
 * the migration is stored truncated in `pg_constraint`. Comparing the untruncated name reports a
 * false MISSING — four of them on the first full-depth run.
 */
export const pgIdent = (s: string): string => Buffer.from(s, "utf8").subarray(0, 63).toString("utf8");

/** Split a CREATE TABLE body on commas that are not inside parentheses. */
export function splitTopLevel(body: string): string[] {
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

const unquote = (s: string): string => s.replace(/^"|"$/g, "").split(".").pop()!;

/** Read a migration's claims off its text. Throws only on an unmapped column type. */
export function parseMigration(sql: string): Expect {
  const e: Expect = {
    tables: new Set(),
    columns: new Map(),
    indexes: new Set(),
    constraints: new Set(),
    rlsEnabled: new Set(),
    rlsForced: new Set(),
    revoked: new Set(),
    dynamicSql: false,
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

  for (const m of src.matchAll(/ALTER\s+TABLE\s+("?[\w.]+"?)\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi))
    e.rlsEnabled.add(unquote(m[1]!));
  for (const m of src.matchAll(/ALTER\s+TABLE\s+("?[\w.]+"?)\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/gi))
    e.rlsForced.add(unquote(m[1]!));

  // THE R39 CHECK. `REVOKE ALL ON TABLE "x" FROM anon` — the `ON TABLE` is optional in SQL and
  // present in every migration here. Only a full `REVOKE ALL` is recorded: a partial revoke
  // ("REVOKE INSERT") leaves other privileges standing, so "the role holds nothing" would be
  // the wrong assertion to make about it, and asserting the wrong thing is worse than asserting
  // nothing.
  for (const m of src.matchAll(
    /REVOKE\s+ALL(?:\s+PRIVILEGES)?\s+ON\s+(?:TABLE\s+)?("?[\w.]+"?)\s+FROM\s+([\w"]+)/gi,
  )) {
    e.revoked.add(`${unquote(m[1]!)}:${unquote(m[2]!).toLowerCase()}`);
  }

  // Dynamic SQL. What a `DO $$ … EXECUTE format(...) … $$` block does is decided at run time,
  // so no amount of parsing establishes what it should have left behind.
  if (/\bDO\s+\$\$/i.test(src) || /\bEXECUTE\s+/i.test(src)) e.dynamicSql = true;

  return e;
}

/** How many independently checkable claims this migration makes. Zero is the refusal case. */
export function expectationCount(e: Expect): number {
  return (
    e.tables.size +
    e.columns.size +
    e.indexes.size +
    e.constraints.size +
    e.rlsEnabled.size +
    e.rlsForced.size +
    e.revoked.size
  );
}

/**
 * A migration this tool can say nothing about.
 *
 * Backfills, DROPs, `ALTER COLUMN`, triggers, views and dynamic SQL all parse to an empty
 * expectation set, and an empty set trivially "matches" any database. Recording a migration as
 * applied on that basis is a claim made on no evidence — which is precisely the failure adoption
 * exists to avoid — so it is a refusal, and the operator is told to verify by hand.
 */
export function vacuous(e: Expect): boolean {
  return expectationCount(e) === 0;
}

/** Every reason the live database does NOT match what this migration would have created. */
export function verifyAgainst(e: Expect, live: LiveCatalog): string[] {
  const problems: string[] = [];

  for (const t of e.tables) if (!live.tables.has(t)) problems.push(`table ${t} MISSING`);
  for (const [key, want] of e.columns) {
    const got = live.columns.get(key);
    if (got === undefined) problems.push(`column ${key} MISSING`);
    else if (got !== want) problems.push(`column ${key} is ${got}, expected ${want}`);
  }
  for (const i of e.indexes) if (!live.indexes.has(pgIdent(i))) problems.push(`index ${i} MISSING`);
  for (const c of e.constraints)
    if (!live.constraints.has(pgIdent(c))) problems.push(`constraint ${c} MISSING`);
  for (const t of e.rlsEnabled) if (!live.rlsEnabled.has(t)) problems.push(`${t}: RLS not enabled`);
  for (const t of e.rlsForced) if (!live.rlsForced.has(t)) problems.push(`${t}: RLS not FORCED`);
  for (const key of e.revoked) {
    if (live.grants.has(key)) {
      const [table, role] = key.split(":");
      problems.push(`${table}: ${role} STILL HOLDS a grant this migration revokes`);
    }
  }

  return problems;
}

/**
 * The complete verdict for one migration: the two refusals first, then the object comparison.
 *
 * The refusals come first on purpose. Both of them mean "this tool cannot establish the answer",
 * which is a different statement from "the answer is no" — and a reader who saw a clean object
 * list above them would take the file as verified.
 */
export function adoptionProblems(sql: string, live: LiveCatalog): string[] {
  let e: Expect;
  try {
    e = parseMigration(sql);
  } catch (err) {
    return [`parse failed: ${(err as Error).message}`];
  }
  const refusals: string[] = [];
  if (e.dynamicSql) {
    refusals.push(
      "contains dynamic SQL (DO $$ / EXECUTE) — what it does is decided at run time and cannot be verified from the file",
    );
  }
  if (vacuous(e)) {
    refusals.push(
      "declares nothing this tool can check (no table, column, index, constraint, RLS flag or REVOKE) — adopting it would record a claim on no evidence",
    );
  }
  return [...refusals, ...verifyAgainst(e, live)];
}
