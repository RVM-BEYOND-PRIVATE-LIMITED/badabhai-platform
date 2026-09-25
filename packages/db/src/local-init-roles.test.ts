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

/** Every role always present on any Postgres — nothing needs to create it. */
const BUILT_IN = new Set(["public", "current_user", "session_user", "current_role"]);

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

function normalise(role: string): string {
  return role.replace(/"/g, "").toLowerCase();
}

/**
 * The roles one migration names, in the four places a migration can name one:
 * `FOR ROLE x`, `GRANT … TO x[, y]`, `REVOKE … FROM x[, y]`, and `OWNER TO x`.
 * `%I` placeholders inside `format(...)` are not identifiers and are not matched; the literal
 * role lists those loops iterate over are quoted strings, handled by {@link quotedRoleArrays}.
 */
function namedRoles(sql: string): string[] {
  const roles: string[] = [];
  for (const m of sql.matchAll(/\bFOR\s+ROLE\s+("?[A-Za-z_][\w$]*"?)/gi)) roles.push(m[1]!);
  for (const m of sql.matchAll(
    /\b(?:GRANT|REVOKE)\b[^;]*?\b(?:TO|FROM)\s+((?:"?[A-Za-z_][\w$]*"?\s*,\s*)*"?[A-Za-z_][\w$]*"?)/gi,
  )) {
    roles.push(...m[1]!.split(/\s*,\s*/));
  }
  for (const m of sql.matchAll(/\bOWNER\s+TO\s+("?[A-Za-z_][\w$]*"?)/gi)) roles.push(m[1]!);
  return roles.map((r) => normalise(r.trim())).filter((r) => r.length > 0 && !BUILT_IN.has(r));
}

/**
 * Roles named inside a PL/pgSQL `ARRAY['anon', 'authenticated', …]` that a loop REVOKEs from.
 * Those loops guard each role on `pg_roles`, so they tolerate a missing one — but they name the
 * roles the migration was written for, so the init script should create them all the same.
 */
function quotedRoleArrays(sql: string): string[] {
  const roles: string[] = [];
  for (const m of sql.matchAll(/\broles\s+text\[\]\s*:=\s*ARRAY\[([^\]]*)\]/gi)) {
    for (const q of m[1]!.matchAll(/'([A-Za-z_][\w$]*)'/g)) roles.push(normalise(q[1]!));
  }
  return roles;
}

function rolesCreatedByInitScript(): Set<string> {
  const sql = stripComments(readFileSync(INIT_SCRIPT, "utf8"));
  return new Set(
    [...sql.matchAll(/\bCREATE\s+ROLE\s+("?[A-Za-z_][\w$]*"?)/gi)].map((m) => normalise(m[1]!)),
  );
}

function rolesNamedByMigrations(): Map<string, string[]> {
  const byRole = new Map<string, string[]>();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = stripComments(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    for (const role of [...namedRoles(sql), ...quotedRoleArrays(sql)]) {
      const where = byRole.get(role) ?? [];
      if (!where.includes(file)) where.push(file);
      byRole.set(role, where);
    }
  }
  return byRole;
}

describe("the local init script creates every role the migrations name (#1724)", () => {
  const created = rolesCreatedByInitScript();
  const named = rolesNamedByMigrations();

  it("VACUITY: the reader finds the roles the chain is known to name, where it names them", () => {
    // If the extraction silently matched nothing, the real assertion below would pass on an
    // empty set. These are the four the chain names today, and two anchors for each kind.
    expect([...named.keys()].sort()).toEqual(
      expect.arrayContaining(["anon", "authenticated", "postgres", "service_role"]),
    );
    expect(named.get("anon")).toContain("0004_workers_force_rls_revoke.sql");
    expect(named.get("postgres")).toEqual(
      expect.arrayContaining([
        "0085_revoke_execute_undeclared_routines.sql",
        "0087_default_privileges_tables.sql",
      ]),
    );
    expect(created.size).toBeGreaterThan(0);
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

  it("reads each kind of mention — the reader cannot miss the shape 0085 used", () => {
    expect(namedRoles("ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public ...")).toEqual([
      "postgres",
    ]);
    expect(namedRoles("REVOKE ALL ON TABLE t FROM anon, authenticated, service_role;")).toEqual([
      "anon",
      "authenticated",
      "service_role",
    ]);
    expect(namedRoles("GRANT SELECT ON t TO reader;")).toEqual(["reader"]);
    expect(namedRoles(`ALTER TABLE t OWNER TO "Owner";`)).toEqual(["owner"]);
    expect(namedRoles("REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;")).toEqual([]);
    expect(quotedRoleArrays("roles text[] := ARRAY['anon', 'service_role'];")).toEqual([
      "anon",
      "service_role",
    ]);
  });
});
