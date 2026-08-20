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
import { DATA_API_ROLES, R39_TABLES } from "./schema-contract";

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
  /**
   * "function:role" for EXECUTE, role lowercased, `PUBLIC` spelled `public`.
   *
   * Keyed on the BARE function name, not the signature: the three routines #1110 is about are
   * not overloaded, and a signature-keyed set would make the verifier depend on how the
   * argument list happens to be rendered. If an overload ever appears, the audit reports it as
   * a separate routine and this set collapses them — which is a false PASS, so
   * {@link executeRevokedProblems} states that limit rather than leaving it to be discovered.
   *
   * REQUIRED, not optional. An absent set and an empty set mean opposite things — "nobody
   * collected this" versus "nobody holds it" — and a verifier that cannot tell them apart is
   * the exact shape of false assurance the effect-verifier rules exist to prevent.
   */
  readonly functionGrants: ReadonlySet<string>;
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
/**
 * ===========================================================================
 * EFFECT VERIFIERS — the one narrow way past the dynamic-SQL refusal
 * ===========================================================================
 * A `DO $$` block is refused because what it does is chosen at run time, so the file cannot be
 * read as a promise. That refusal is right, and it is also a dead end: `0082_rls_lock_seven_tables`
 * has a guarded Section B, was applied to production by hand, and then had drizzle's watermark
 * move PAST it by an unrelated out-of-band apply — so `db:migrate` will now skip it forever and
 * adoption is the only remaining way to record it.
 *
 * The escape hatch is deliberately NOT "trust me, adopt it". It is: name the migration, and
 * supply a function that verifies its EFFECTS against the live catalog. That is strictly
 * stronger evidence than the text parse it replaces — a parse asks what the file says, a
 * verifier asks what the database actually is.
 *
 * FOUR PROPERTIES THAT KEEP THIS FROM BECOMING A BACK DOOR:
 *
 *   1. Keyed to ONE migration tag. There is no flag that relaxes the rule generally.
 *   2. The verifier runs IN ADDITION to the static check, never instead of it — whatever
 *      {@link parseMigration} can still read off the file is still verified.
 *   3. `assertions` must be > 0 and is asserted by a test. A verifier that checks nothing would
 *      reproduce exactly the "nothing to check counted as everything checked" defect that made
 *      {@link vacuous} necessary.
 *   4. It can still FAIL. Run against a database where 0082 has not been applied, the 0082
 *      verifier reports 42 problems and adoption refuses — the property the runbook needs is
 *      "cannot record a migration whose effects are absent", and this preserves it exactly.
 */
export interface EffectVerifier {
  readonly tag: string;
  /** Why this migration cannot be verified from its text. One line, for the report. */
  readonly why: string;
  /** How many independent facts {@link verify} checks. Must be > 0 — see property 3. */
  readonly assertions: number;
  /** Every reason the live database does NOT show this migration's effects. */
  readonly verify: (live: LiveCatalog) => string[];
}

/**
 * `0082` locks seven tables: ENABLE + FORCE + `REVOKE ALL` from each of the four Data-API roles.
 * Three of them it names in plain text (verified statically anyway); four it reaches only
 * through `to_regclass` inside the `DO` block. This checks all seven the same way, from the
 * catalog — the same three conditions `rlsLocked` uses and `db:audit:rls` reports on.
 */
function r39LockProblems(live: LiveCatalog): string[] {
  const problems: string[] = [];
  for (const { table } of R39_TABLES) {
    if (!live.tables.has(table)) {
      // Absent is not a pass. On a database that has not applied `0084`, the four
      // `declared-by-0084` tables genuinely are not there — but adoption only ever runs against
      // a database claimed to ALREADY have the migration's effects, and "the table 0082 locks
      // is missing" is never that.
      problems.push(`${table}: table MISSING — 0082 locks it, so it cannot already be applied here`);
      continue;
    }
    if (!live.rlsEnabled.has(table)) problems.push(`${table}: RLS is not ENABLED`);
    if (!live.rlsForced.has(table)) problems.push(`${table}: RLS is not FORCED — the owner bypasses every policy`);
    for (const role of DATA_API_ROLES) {
      if (live.grants.has(`${table}:${role.toLowerCase()}`)) {
        problems.push(`${table}: ${role} still holds a privilege — the REVOKE did not take`);
      }
    }
  }
  return problems;
}

/** The four `0084` creates and locks — the GAP-DB-21 half of the R39 list. */
const GAP_DB_21_TABLES = R39_TABLES.filter((t) => t.cls === "declared-by-0084");

/**
 * `0084` creates the four GAP-DB-21 tables and locks them, and its ONE dynamic statement is the
 * `auth.users` foreign key — guarded by `to_regclass` because that schema exists on Supabase and
 * nowhere else.
 *
 * WHAT THIS VERIFIES, AND WHAT IT DELIBERATELY DOES NOT. It asserts the four tables exist and
 * are locked, from the catalog. It does NOT assert the `auth.users` FK: whether that constraint
 * should be present is a property of the ENVIRONMENT, not of whether the migration ran, so
 * requiring it would make 0084 unadoptable on exactly the databases where it correctly did
 * nothing. The static parse still covers everything else in the file — every CREATE TABLE,
 * every index, every payer FK, every FORCE and every REVOKE is plain text and checked as usual.
 *
 * This verifier runs IN ADDITION to that parse, never instead of it.
 */
function gapDb21CreateLockProblems(live: LiveCatalog): string[] {
  const problems: string[] = [];
  for (const { table } of GAP_DB_21_TABLES) {
    if (!live.tables.has(table)) {
      problems.push(`${table}: table MISSING — 0084 creates it, so it cannot already be applied here`);
      continue;
    }
    if (!live.rlsEnabled.has(table)) problems.push(`${table}: RLS is not ENABLED`);
    if (!live.rlsForced.has(table)) problems.push(`${table}: RLS is not FORCED — the owner bypasses every policy`);
    for (const role of DATA_API_ROLES) {
      if (live.grants.has(`${table}:${role.toLowerCase()}`)) {
        problems.push(`${table}: ${role} still holds a privilege — the REVOKE did not take`);
      }
    }
  }
  return problems;
}

/**
 * The three undeclared `SECURITY DEFINER` functions `0085` revokes EXECUTE on — #1110.
 *
 * Bare names, because {@link LiveCatalog.functionGrants} is keyed that way and none of the three
 * is overloaded on this database.
 */
export const UNDECLARED_DEFINER_FUNCTIONS: readonly string[] = [
  "_log_delete",
  "is_active_payer_member",
  "rls_auto_enable",
];

/**
 * `0085` is one `DO` block and {@link parseMigration} can read nothing out of it — every REVOKE
 * is inside `format()`, behind a `to_regprocedure` guard, behind a loop.
 *
 * ABSENCE IS A PASS HERE, and that is the opposite of the rule 0082 and 0084 follow — so it is
 * argued rather than assumed. For those two, a missing table means "this migration did not run"
 * and adoption must refuse. For 0085 there is no object it creates: it constrains three
 * functions that NO migration declares, so a database built from this repository correctly does
 * not have them and there is genuinely no privilege left to take away. Requiring their presence
 * would make 0085 unadoptable on exactly the databases where it correctly did nothing.
 *
 * What still cannot pass: a function that IS present while a Data-API role still holds EXECUTE.
 * That is the whole finding, and it is the one state this refuses to record as applied.
 *
 * LIMIT, stated: `functionGrants` is keyed on the bare name, so an overload of one of these
 * three would be collapsed into the same key and its grants would read as the original's. None
 * of the three is overloaded today; `db:audit:undeclared-routines` is what would report a new
 * one, and it lists routines rather than merging them.
 */
function executeRevokedProblems(live: LiveCatalog): string[] {
  const problems: string[] = [];
  for (const fn of UNDECLARED_DEFINER_FUNCTIONS) {
    for (const role of DATA_API_ROLES) {
      if (live.functionGrants.has(`${fn}:${role.toLowerCase()}`)) {
        problems.push(`${fn}(): ${role} still holds EXECUTE — the REVOKE did not take`);
      }
    }
  }
  return problems;
}

/** Every migration whose effects may be verified from the catalog instead of from its text. */
export const EFFECT_VERIFIERS: readonly EffectVerifier[] = [
  {
    tag: "0082_rls_lock_seven_tables",
    why: "Section B locks four GAP-DB-21 tables through a to_regclass-guarded DO block",
    assertions: R39_TABLES.length * (2 + DATA_API_ROLES.length),
    verify: r39LockProblems,
  },
  {
    tag: "0084_model_gap_db_21_payer_onboarding",
    why: "the auth.users foreign key is guarded by to_regclass — present on Supabase, absent elsewhere",
    assertions: GAP_DB_21_TABLES.length * (2 + DATA_API_ROLES.length),
    verify: gapDb21CreateLockProblems,
  },
  {
    tag: "0085_revoke_execute_undeclared_routines",
    why: "every REVOKE is inside format() behind a to_regprocedure guard, so the file text states none of them",
    assertions: UNDECLARED_DEFINER_FUNCTIONS.length * DATA_API_ROLES.length,
    verify: executeRevokedProblems,
  },
];

export function effectVerifierFor(tag: string | undefined): EffectVerifier | undefined {
  if (tag === undefined) return undefined;
  return EFFECT_VERIFIERS.find((v) => v.tag === tag);
}

/**
 * Every reason this migration must NOT be recorded as applied.
 *
 * `tag` is optional only so existing callers that verify a bare string keep compiling; pass it
 * whenever you have it, because it is what enables the effect verifier above.
 */
export function adoptionProblems(sql: string, live: LiveCatalog, tag?: string): string[] {
  let e: Expect;
  try {
    e = parseMigration(sql);
  } catch (err) {
    return [`parse failed: ${(err as Error).message}`];
  }
  const verifier = effectVerifierFor(tag);
  const refusals: string[] = [];
  if (e.dynamicSql && verifier === undefined) {
    refusals.push(
      "contains dynamic SQL (DO $$ / EXECUTE) — what it does is decided at run time and cannot be verified from the file",
    );
  }
  if (vacuous(e) && verifier === undefined) {
    refusals.push(
      "declares nothing this tool can check (no table, column, index, constraint, RLS flag or REVOKE) — adopting it would record a claim on no evidence",
    );
  }
  // Both, never either: the verifier ADDS catalog evidence, it does not excuse the text.
  return [...refusals, ...verifyAgainst(e, live), ...(verifier?.verify(live) ?? [])];
}
