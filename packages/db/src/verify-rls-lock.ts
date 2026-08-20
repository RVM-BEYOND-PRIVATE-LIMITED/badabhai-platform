/**
 * Prove migration 0081 will actually lock the seven R39 tables — WITHOUT applying it.
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 * `db:audit:rls` says the seven tables are open. That is the diagnosis. It does not say the
 * prescription works, and for a REVOKE that is not a rhetorical distinction: **a REVOKE only
 * removes privileges the executing role is entitled to remove.** If the grants were made by a
 * role the migration's connection is not a member of, every REVOKE in 0081 is a silent no-op —
 * no error, no warning, and an audit run afterwards reports the same seven tables. The migration
 * would be recorded as applied and would have changed nothing.
 *
 * There are two more ways 0081 could be wrong in a way review cannot catch:
 *
 *   FORCE LOCKS THE APP OUT. FORCE makes RLS apply to the table OWNER, and this schema has zero
 *   policies anywhere — so on a connection without `rolbypassrls` it is a total denial of a
 *   table the backend uses. The reasoning that says it is safe here (`postgres` is bypassrls)
 *   is correct, and reasoning is not measurement.
 *
 *   THE SECTION-B GUARD MISFIRES. Four of the seven exist on production and in no migration, so
 *   0081 wraps them in a `to_regclass` guard. A guard that silently skips a table that IS there
 *   looks exactly like success.
 *
 * This runner answers all three by DOING it — the real statements, in the real order, against
 * the real database — and then throwing the whole thing away.
 *
 * ===========================================================================
 * WHY IT IS SAFE TO POINT AT PRODUCTION
 * ===========================================================================
 * Every statement runs inside ONE transaction that CANNOT commit: the callback's last act is an
 * unconditional `throw new RollbackSignal(...)`, caught outside and discarded. There is no
 * `--apply`, no branch that skips the throw, and no path that reaches COMMIT. The catalog is
 * then RE-READ on a fresh statement after the transaction has ended and compared field by field
 * against the snapshot taken before it — so "nothing changed" is verified, not asserted.
 *
 * THE FOOTPRINT IS HEAVIER THAN A ROW LOCK AND SMALLER THAN IT SOUNDS. `ALTER TABLE` and
 * `REVOKE` take ACCESS EXCLUSIVE on their table, which blocks readers for as long as the
 * transaction lives — milliseconds here, on seven tables that hold zero rows. `SET LOCAL
 * lock_timeout = '3s'` bounds the wait: if a real transaction holds one of the three agency
 * tables, this probe fails with 55P03 and says so rather than queueing behind it and making
 * every subsequent query queue behind IT.
 *
 * Per-table SAVEPOINTs (`tx.transaction(...)`) confine a failure to the table that caused it. A
 * failed statement aborts a Postgres transaction outright (25P02), so without them the first
 * failure would render every later probe as a schema error it is not.
 *
 *   pnpm db:verify:rls-lock            # report; exit 1 if the lock would not take
 *   pnpm db:verify:rls-lock --json=<p> # + an evidence record
 */
import { config } from "dotenv";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sql as dsql } from "drizzle-orm";

import { createDbClient } from "./client";
import { hostClass } from "./audit-embedding-provenance";
import { opsGuard } from "./ops-guard";
import { DATA_API_ROLES, rlsLocked } from "./schema-contract";
import {
  RollbackSignal,
  allPassed,
  causeOf,
  formatResults,
  scalar as scalarRow,
  type ProbeResult,
} from "./probe-report";

config({ path: join("..", "..", ".env") });

const SCRIPT = "verify:rls-lock";
const scalar = <T,>(rows: readonly T[], what: string): T => scalarRow(rows, what, SCRIPT);

/**
 * Which half of 0081 a table belongs to. The distinction is not cosmetic: it decides whether
 * "table absent" is a failure or the expected state.
 */
export type R39Class = "declared-by-0048" | "unmodelled";

export interface R39Table {
  readonly table: string;
  readonly cls: R39Class;
}

/**
 * The seven, in the order 0081 locks them.
 *
 * `declared-by-0048` tables exist in every environment — migration 0048 creates them — so their
 * absence here is a real failure. `unmodelled` tables (GAP-DB-21) exist on production and in no
 * migration and no schema file, so their absence is the CORRECT state everywhere else and this
 * runner reports it as `skipped`, never as a pass.
 */
export const R39_TABLES: readonly R39Table[] = [
  { table: "agency_kyc", cls: "declared-by-0048" },
  { table: "agency_payout_accruals", cls: "declared-by-0048" },
  { table: "agency_payout_requests", cls: "declared-by-0048" },
  { table: "agency_profiles", cls: "unmodelled" },
  { table: "employer_profiles", cls: "unmodelled" },
  { table: "payer_capabilities", cls: "unmodelled" },
  { table: "payer_member_invites", cls: "unmodelled" },
];

/** Every DML privilege REVOKE ALL must strip. TRUNCATE and REFERENCES are in the grant too. */
export const DML = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES"] as const;

/** The roles whose privilege must actually reach zero. `PUBLIC` is not a role `has_table_privilege` accepts. */
export const REVOKED_ROLES = DATA_API_ROLES.filter((r) => r !== "PUBLIC");

/**
 * Exactly what 0081 runs for one table, in 0081's order.
 *
 * Shared by the probe and by the migration's own text — a test asserts the two agree, so the
 * thing this proves is the thing that will be applied rather than a paraphrase of it.
 */
export function lockStatements(table: string): string[] {
  return [
    `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`,
    ...DATA_API_ROLES.map((role) => `REVOKE ALL ON TABLE "${table}" FROM ${role}`),
  ];
}

/** One line of expectation per probe id. Pure, so the report is testable without a database. */
export function expectationFor(id: string): string {
  const [table, kind] = id.split(":");
  switch (kind) {
    case "lock-takes":
      return `${table}: after 0081's statements the table reads back ENABLED + FORCED + no Data-API grant`;
    case "owner-can-read":
      return `${table}: the backend's own connection can still read it once FORCE is on`;
    case "privileges-zero":
      return `${table}: anon / authenticated / service_role hold no DML privilege at all`;
    default:
      return id;
  }
}

interface TableState {
  readonly exists: boolean;
  readonly enabled: boolean;
  readonly forced: boolean;
  readonly grantedRoles: readonly string[];
}

/** Field-by-field equality, so the after-rollback comparison cannot pass on a partial match. */
export function sameState(a: TableState, b: TableState): boolean {
  return (
    a.exists === b.exists &&
    a.enabled === b.enabled &&
    a.forced === b.forced &&
    [...a.grantedRoles].sort().join(",") === [...b.grantedRoles].sort().join(",")
  );
}

type Executor = { execute: (q: ReturnType<typeof dsql>) => Promise<unknown> };

async function readState(x: Executor, table: string): Promise<TableState> {
  const rows = (await x.execute(
    dsql`SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ${table}`,
  )) as unknown as { enabled: boolean; forced: boolean }[];
  const row = rows[0];
  if (row === undefined) return { exists: false, enabled: false, forced: false, grantedRoles: [] };
  const grants = (await x.execute(
    dsql`SELECT DISTINCT grantee FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = ${table}`,
  )) as unknown as { grantee: string }[];
  return {
    exists: true,
    enabled: row.enabled === true,
    forced: row.forced === true,
    grantedRoles: grants.map((g) => g.grantee),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const jsonArg = argv.find((a) => a.startsWith("--json="));
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);

  // `mutating: false` is the honest declaration — the transaction cannot commit, so the run has
  // no net effect. The banner still says what it does, because "DDL inside a doomed
  // transaction" is not what a reader assumes from "read-only".
  const verdict = opsGuard({
    script: SCRIPT,
    connectionString: url,
    nodeEnv: process.env["NODE_ENV"],
    allowEnv: process.env["OPS_ALLOW_PRODUCTION"],
    argv,
    mutating: false,
  });
  if (verdict.warning) console.log(verdict.warning);
  console.log(`[${SCRIPT}] 0081 REHEARSAL inside a transaction that CANNOT commit.`);
  console.log(`  target = ${hostClass(url)}`);

  const { db, sql } = createDbClient(url, { max: 1 });
  const results: ProbeResult[] = [];
  const skipped: string[] = [];
  const add = (id: string, passed: boolean, detail?: string): void => {
    results.push({ id, expectation: expectationFor(id), passed, ...(detail ? { detail } : {}) });
  };

  try {
    // Who are we, and does FORCE apply to us? The answer decides whether the owner-read probe
    // below is a formality or the load-bearing check.
    const who = scalar(
      (await db.execute(
        dsql`SELECT current_user AS role, rolbypassrls AS bypass, rolsuper AS super
             FROM pg_roles WHERE rolname = current_user`,
      )) as unknown as { role: string; bypass: boolean; super: boolean }[],
      "the connection's own role",
    );
    console.log(`  role   = ${who.role}  bypassrls=${who.bypass}  superuser=${who.super}`);

    const before = new Map<string, TableState>();
    for (const { table } of R39_TABLES) before.set(table, await readState(db, table));

    try {
      await db.transaction(async (tx) => {
        // Bound the wait for ACCESS EXCLUSIVE. Without it this probe would queue behind any
        // in-flight transaction on the three agency tables — and every reader arriving
        // meanwhile would queue behind the probe.
        await tx.execute(dsql`SET LOCAL lock_timeout = '3s'`);

        for (const { table, cls } of R39_TABLES) {
          const state = before.get(table);
          if (state?.exists !== true) {
            if (cls === "unmodelled") {
              skipped.push(`${table} (absent — expected on every database but production)`);
              continue;
            }
            add(`${table}:lock-takes`, false, "table does not exist, but migration 0048 declares it");
            continue;
          }

          // SAVEPOINT per table: a failed statement aborts the whole transaction (25P02), so
          // without this the first failure would report every later table as broken too.
          try {
            await tx.transaction(async (sp) => {
              for (const stmt of lockStatements(table)) await sp.execute(dsql.raw(stmt));

              const after = await readState(sp, table);
              const locked = rlsLocked({
                enabled: after.enabled,
                forced: after.forced,
                grantedRoles: after.grantedRoles,
              });
              add(
                `${table}:lock-takes`,
                locked,
                locked
                  ? undefined
                  : `enabled=${after.enabled} forced=${after.forced} still granted to ${after.grantedRoles.join(", ")}`,
              );

              // The FORCE-lockout check, measured rather than reasoned. If this connection did
              // not bypass RLS, a zero-policy FORCEd table would deny it here.
              try {
                await sp.execute(dsql.raw(`SELECT 1 FROM "${table}" LIMIT 1`));
                add(`${table}:owner-can-read`, true);
              } catch (e) {
                add(`${table}:owner-can-read`, false, causeOf(e));
              }

              // The sharp form of the grant check: REVOKE ALL must strip write and TRUNCATE
              // too, not just SELECT. A table that kept INSERT would pass a SELECT-only test.
              const held: string[] = [];
              for (const role of REVOKED_ROLES) {
                for (const priv of DML) {
                  const r = scalar(
                    (await sp.execute(
                      dsql`SELECT has_table_privilege(${role}, ${`public.${table}`}, ${priv}) AS has`,
                    )) as unknown as { has: boolean }[],
                    `${role}/${priv} on ${table}`,
                  );
                  if (r.has) held.push(`${role}:${priv}`);
                }
              }
              add(`${table}:privileges-zero`, held.length === 0, held.length === 0 ? undefined : held.join(", "));
            });
          } catch (e) {
            add(`${table}:lock-takes`, false, causeOf(e));
          }
        }

        // The last act, unconditionally. Nothing above can skip it and nothing below runs.
        throw new RollbackSignal(SCRIPT);
      });
    } catch (e) {
      if (!(e instanceof RollbackSignal)) throw e;
    }

    // Verified, not asserted: re-read on a fresh statement after the transaction has ended.
    const drifted: string[] = [];
    for (const { table } of R39_TABLES) {
      const b = before.get(table);
      const a = await readState(db, table);
      if (b && !sameState(b, a)) drifted.push(table);
    }
    results.push({
      id: "nothing-committed",
      expectation: "every table's RLS flags and grant list are byte-identical after the rollback",
      passed: drifted.length === 0,
      ...(drifted.length === 0 ? {} : { detail: `changed: ${drifted.join(", ")}` }),
    });

    console.log("");
    for (const line of formatResults(results)) console.log(line);
    for (const s of skipped) console.log(`  SKIP  ${s}`);

    const ok = allPassed(results);
    console.log(
      `\n  would 0081 lock these tables? = ${ok ? "YES" : "NO — see the FAIL lines above"}`,
    );
    console.log(`  rehearsed ${results.length - 1} probe(s) over ${R39_TABLES.length - skipped.length} live table(s); nothing was committed.`);
    if (!ok) process.exitCode = 1;

    if (jsonArg !== undefined) {
      const path = jsonArg.slice("--json=".length);
      if (existsSync(path)) {
        console.error(`  refusing to overwrite ${path} — evidence is never replaced.`);
        process.exitCode = 1;
        return;
      }
      writeFileSync(
        path,
        `${JSON.stringify(
          {
            kind: "rls-lock-rehearsal",
            migration: "0081_rls_lock_seven_tables",
            target: hostClass(url),
            role: { name: who.role, bypassrls: who.bypass, superuser: who.super },
            would_lock: ok,
            skipped,
            results,
          },
          null,
          2,
        )}\n`,
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
    console.error(causeOf(e));
    process.exit(1);
  });
}
