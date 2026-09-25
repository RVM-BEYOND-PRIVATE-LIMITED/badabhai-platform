import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * EVERY ROLE THE MIGRATIONS NAME MUST EXIST ON A FRESH LOCAL DATABASE (#1724).
 *
 * The migrations were written against Supabase, which ships `anon`, `authenticated`,
 * `service_role` and `postgres`. The local container (`pnpm db:up`, a plain
 * `pgvector/pgvector:pg16` whose superuser is `badabhai`) ships none of them, so
 * `infra/docker/postgres-init/00-supabase-roles.sql` creates them on an empty data dir.
 *
 * That file is hand-maintained, and it fell behind once: 0085 added
 * `ALTER DEFAULT PRIVILEGES FOR ROLE postgres`, the init script never learned `postgres`, and
 * every fresh `pnpm db:migrate` died on 0085 with zero tables created. Nothing caught it,
 * because CI's E2E Postgres runs AS `postgres`. This test is the check that was missing: it
 * reads every role the migration chain names and fails when the init script does not create it.
 *
 * STATIC, NOT A DATABASE TEST, deliberately. The DB-gated suites do not run in CI, and the
 * failure mode here is an omission in a text file, which a text comparison finds exactly.
 *
 * THE INIT SCRIPT IS A TURBO INPUT OF THIS TASK (`packages/db/turbo.json`). Without that, a PR
 * editing only the init script would replay this test's cached pass instead of running it —
 * the one edit it exists to catch.
 *
 * A READER, NOT A PARSER. It knows the statement shapes that name a role and errs toward
 * flagging: a false positive fails loudly and names the word it misread, a false negative is
 * #1724 again. Every shape it reads has a unit case below.
 */

const MIGRATIONS_DIR = join(__dirname, "..", "migrations");
const INIT_SCRIPT = join(
  __dirname,
  "..",
  "..",
  "..",
  "infra",
  "docker",
  "postgres-init",
  "00-supabase-roles.sql",
);

/** Roles every Postgres has — nothing needs to create them. */
const BUILT_IN = new Set(["public", "current_user", "session_user", "current_role"]);

// ── The patterns. LITERALS, every one: semgrep's `detect-non-literal-regexp` blocks a RegExp
// built from arguments, so the identifier `(?:"[^"]+"|[A-Za-z_][\w$]*)` and its comma list are
// spelled out in each rather than interpolated.

/** `FOR ROLE a, b` / `FOR USER a` — ALTER DEFAULT PRIVILEGES, the shape 0085 used. */
const FOR_ROLE_RE =
  /\bFOR\s+(?:ROLE|USER)\s+((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*,\s*(?:"[^"]+"|[A-Za-z_][\w$]*))*)/gi;

/**
 * The grantees of a privilege GRANT/REVOKE: `… TO [GROUP] a, b` / `… FROM a, b`.
 *
 * ANCHORED TO A STATEMENT START — a line start, `;`, `(`, the `'` opening an EXECUTE string, a
 * PL/pgSQL keyword, or the `ALTER DEFAULT PRIVILEGES` prefix — and followed by whitespace. That
 * is what keeps prose from reading as a grant: a `'revoke'` literal in a consent query, or
 * "revoke … from the …" in a notice, is not a statement.
 */
const GRANTEES_RE =
  /(?:^|[;'(]|\b(?:THEN|ELSE|LOOP|BEGIN)\b|\bPRIVILEGES\b[^;]*?)\s*(?:GRANT|REVOKE)\s[^;]*?\b(?:TO|FROM)\s+(?:GROUP\s+)?((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*,\s*(?:"[^"]+"|[A-Za-z_][\w$]*))*)/gim;

/** Role membership, `GRANT a, b TO c` — no ON clause, so the granted names are roles too. */
const MEMBERSHIP_GRANT_RE =
  /(?:^|[;'(]|\b(?:THEN|ELSE|LOOP|BEGIN)\b)\s*GRANT\s+((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*,\s*(?:"[^"]+"|[A-Za-z_][\w$]*))*)\s+TO\b/gim;

/** `REVOKE [ADMIN|INHERIT|SET OPTION FOR] a, b FROM c` — the revoke half of membership. */
const MEMBERSHIP_REVOKE_RE =
  /(?:^|[;'(]|\b(?:THEN|ELSE|LOOP|BEGIN)\b)\s*REVOKE\s+(?:(?:ADMIN|INHERIT|SET)\s+OPTION\s+FOR\s+)?((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*,\s*(?:"[^"]+"|[A-Za-z_][\w$]*))*)\s+FROM\b/gim;

const GRANTED_BY_RE = /\bGRANTED\s+BY\s+("[^"]+"|[A-Za-z_][\w$]*)/gi;
const OWNER_TO_RE = /\bOWNER\s+TO\s+("[^"]+"|[A-Za-z_][\w$]*)/gi;

/** `CREATE|ALTER POLICY … TO a, b` — but never `ALTER POLICY … RENAME TO new_name`. */
const POLICY_TO_RE =
  /\b(?:CREATE|ALTER)\s+POLICY\b[^;]*?(?<!\bRENAME\s+)\bTO\s+((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*,\s*(?:"[^"]+"|[A-Za-z_][\w$]*))*)/gi;

/** A PL/pgSQL role list a guarded loop walks: `roles text[] := ARRAY['anon', …]`. */
const ROLE_ARRAY_RE = /\b\w*roles?\w*\s+(?:CONSTANT\s+)?text\[\]\s*:=\s*ARRAY\[([^\]]*)\]/gi;

const CREATE_ROLE_RE = /\bCREATE\s+(?:ROLE|USER|GROUP)\s+("[^"]+"|[A-Za-z_][\w$]*)/gi;
const IDENTIFIER_RE = /"[^"]+"|[A-Za-z_][\w$]*/g;

/**
 * Remove text that can only ever be prose: comments of both kinds, `COMMENT ON … IS '…'`, and
 * the string a `RAISE` prints. Other string literals stay — role names live in EXECUTE strings.
 */
function stripProse(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, "")
    .replace(/\bCOMMENT\s+ON\b[^;]*;/gi, ";")
    .replace(/\bRAISE\s+(?:NOTICE|WARNING|EXCEPTION|INFO|LOG|DEBUG)\s+'(?:[^']|'')*'/gi, "RAISE");
}

/** Postgres's own folding: a quoted name keeps its case, an unquoted one is lower-cased. */
function normalise(identifier: string): string {
  return identifier.startsWith('"') ? identifier.slice(1, -1) : identifier.toLowerCase();
}

function identifiers(list: string): string[] {
  return (list.match(IDENTIFIER_RE) ?? []).map(normalise);
}

/** Every role one migration's SQL names. Pure over the text, so each shape is unit-testable. */
function namedRoles(raw: string): string[] {
  const sql = stripProse(raw);
  const roles: string[] = [];
  // The membership patterns need no privilege-word filter: they require the list to meet TO or
  // FROM directly, and a privilege list never does — it is always followed by ON.
  for (const re of [
    FOR_ROLE_RE,
    GRANTEES_RE,
    POLICY_TO_RE,
    MEMBERSHIP_GRANT_RE,
    MEMBERSHIP_REVOKE_RE,
  ]) {
    for (const m of sql.matchAll(re)) roles.push(...identifiers(m[1]!));
  }
  for (const re of [GRANTED_BY_RE, OWNER_TO_RE]) {
    for (const m of sql.matchAll(re)) roles.push(normalise(m[1]!));
  }
  for (const m of sql.matchAll(ROLE_ARRAY_RE)) {
    for (const q of m[1]!.matchAll(/'([^']+)'/g)) roles.push(q[1]!);
  }
  return [...new Set(roles)].filter((r) => !BUILT_IN.has(r));
}

/** Roles a script creates for itself (`CREATE ROLE|USER|GROUP`). */
function createdRoles(raw: string): string[] {
  return [...stripProse(raw).matchAll(CREATE_ROLE_RE)].map((m) => normalise(m[1]!));
}

function rolesCreatedByInitScript(): Set<string> {
  return new Set(createdRoles(readFileSync(INIT_SCRIPT, "utf8")));
}

/**
 * Every role the chain names, with the files that name it — minus any role the chain CREATES
 * itself. That one must NOT go in the init script: the migration's own unguarded `CREATE ROLE`
 * would then fail with "already exists".
 */
function rolesNamedBy(migrations: readonly { file: string; sql: string }[]): Map<string, string[]> {
  const byRole = new Map<string, string[]>();
  const createdByChain = new Set<string>();
  for (const { file, sql } of migrations) {
    for (const role of createdRoles(sql)) createdByChain.add(role);
    for (const role of namedRoles(sql)) byRole.set(role, [...(byRole.get(role) ?? []), file]);
  }
  for (const role of createdByChain) byRole.delete(role);
  return byRole;
}

function rolesNamedByMigrations(): Map<string, string[]> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return rolesNamedBy(
    files.map((file) => ({ file, sql: readFileSync(join(MIGRATIONS_DIR, file), "utf8") })),
  );
}

describe("the local init script creates every role the migrations name (#1724)", () => {
  const created = rolesCreatedByInitScript();
  const named = rolesNamedByMigrations();

  it("VACUITY: the reader finds the roles the chain is known to name, where it names them", () => {
    // If the extraction silently matched nothing, the real assertion below would pass on an
    // empty set. These are the four the chain names today, anchored to where each is named.
    expect([...named.keys()].sort()).toEqual(["anon", "authenticated", "postgres", "service_role"]);
    expect(named.get("anon")).toContain("0004_workers_force_rls_revoke.sql");
    expect(named.get("postgres")).toEqual(
      expect.arrayContaining([
        "0085_revoke_execute_undeclared_routines.sql",
        "0087_default_privileges_tables.sql",
      ]),
    );
    expect([...created].sort()).toEqual(["anon", "authenticated", "postgres", "service_role"]);
  });

  it("creates every one of them", () => {
    const missing = [...named.entries()]
      .filter(([role]) => !created.has(role))
      .map(([role, files]) => `${role} (named by ${files.slice(0, 3).join(", ")})`);
    // A failure here means a fresh `pnpm db:up && pnpm db:migrate` dies on that migration with
    // `role "<name>" does not exist`. Add the role to 00-supabase-roles.sql — do NOT guard or
    // edit the shipped migration, which would change its hash.
    expect(missing).toEqual([]);
  });
});

describe("the role reader, shape by shape", () => {
  it("reads ALTER DEFAULT PRIVILEGES FOR ROLE/USER, lists included — the shape 0085 used", () => {
    expect(namedRoles("ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public …;")).toEqual([
      "postgres",
    ]);
    expect(namedRoles("ALTER DEFAULT PRIVILEGES FOR ROLE postgres, supabase_admin …;")).toEqual([
      "postgres",
      "supabase_admin",
    ]);
    expect(namedRoles("ALTER DEFAULT PRIVILEGES FOR USER app_owner IN SCHEMA s …;")).toEqual([
      "app_owner",
    ]);
  });

  it("reads privilege grantees, a GROUP grantee, and GRANTED BY", () => {
    expect(namedRoles("REVOKE ALL ON TABLE t FROM anon, authenticated, service_role;")).toEqual([
      "anon",
      "authenticated",
      "service_role",
    ]);
    expect(namedRoles("GRANT SELECT ON t TO GROUP readers;")).toEqual(["readers"]);
    expect(namedRoles("GRANT SELECT ON t TO anon GRANTED BY grantor_x;")).toEqual([
      "anon",
      "grantor_x",
    ]);
    expect(namedRoles("REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;")).toEqual([]);
  });

  it("reads both sides of role membership, and never a privilege word as a role", () => {
    expect(namedRoles("GRANT new_reader TO authenticated;")).toEqual([
      "authenticated",
      "new_reader",
    ]);
    expect(namedRoles("REVOKE ADMIN OPTION FOR new_reader FROM authenticated;")).toEqual([
      "authenticated",
      "new_reader",
    ]);
    expect(namedRoles("GRANT SELECT, INSERT ON t TO anon;")).toEqual(["anon"]);
  });

  it("reads CREATE/ALTER POLICY … TO, and not a policy RENAME", () => {
    expect(
      namedRoles("CREATE POLICY p ON t FOR SELECT TO authenticated, new_role USING (true);"),
    ).toEqual(["authenticated", "new_role"]);
    expect(namedRoles("ALTER POLICY p ON t TO auditor;")).toEqual(["auditor"]);
    expect(namedRoles("ALTER POLICY p ON t RENAME TO p_renamed;")).toEqual([]);
  });

  it("reads roles inside EXECUTE strings and guarded role arrays, as the chain writes them", () => {
    expect(namedRoles("EXECUTE format('REVOKE ALL ON %I FROM anon', t);")).toEqual(["anon"]);
    expect(
      namedRoles(
        "EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public ' || 'REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC';",
      ),
    ).toEqual(["postgres"]);
    expect(namedRoles("roles text[] := ARRAY['anon', 'service_role'];")).toEqual([
      "anon",
      "service_role",
    ]);
  });

  it("folds case the way Postgres does: a quoted name keeps its case", () => {
    expect(namedRoles(`ALTER TABLE t OWNER TO "Owner";`)).toEqual(["Owner"]);
    expect(namedRoles("ALTER TABLE t OWNER TO Owner;")).toEqual(["owner"]);
  });

  it("reads NO role out of prose — comments, COMMENT ON, notices, and 'revoke' literals", () => {
    // Each OPENS with the keyword where it can, because that is the shape only stripping stops:
    // a line start or an opening quote is a statement start to the anchor, so without the strip
    // these read "revoke … from the" as a grant to a role called `the`.
    const prose = [
      "/*\n  revoke EXECUTE from the Data-API roles\n*/",
      "-- grant access to the team",
      "COMMENT ON TABLE t IS 'grant rows move from pending to accepted';",
      "RAISE NOTICE 'revoke EXECUTE from the Data-API roles';",
      "RAISE NOTICE '0200: revoke EXECUTE from the Data-API roles';",
      "SELECT count(*) FILTER (WHERE action = 'revoke') AS n FROM consent_events;",
      "SELECT w.id, 'revoke' FROM workers w;",
    ];
    for (const sql of prose) expect(namedRoles(sql), sql).toEqual([]);
  });

  it("does not ask the init script for a role the chain creates itself", () => {
    // Asking for it would break migrate: the migration's own unguarded CREATE ROLE would then
    // fail with "already exists". A role the chain only NAMES is still required.
    const named = rolesNamedBy([
      { file: "9001_a.sql", sql: "CREATE ROLE analytics_reader NOLOGIN;" },
      { file: "9002_b.sql", sql: "GRANT SELECT ON v TO analytics_reader, outside_role;" },
    ]);
    expect([...named.keys()]).toEqual(["outside_role"]);
  });
});
