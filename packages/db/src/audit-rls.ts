/**
 * Sweep EVERY public table for the RLS lock, and say precisely how each deviation fails.
 *
 * ===========================================================================
 * WHY A SWEEP AND NOT MORE MANIFEST ENTRIES
 * ===========================================================================
 * `schema-contract.ts` answers "does this database have the objects the code on `main`
 * names". That is a per-migration question and its manifest is deliberately small. RLS is the
 * opposite shape: the rule applies to every table, and the dangerous case is the table nobody
 * thought to list. A manifest can only ever check the tables someone remembered — this sweeps
 * what is actually there, so a NEW table with no lock is caught by the same run that checks
 * the old ones.
 *
 * The existing coverage does not do this. `tests/e2e/rls-spine.e2e.test.ts` checks a
 * hand-maintained `LOCKED_TABLES` list AND is `describe.skipIf(!RUN)` — so it does not run in
 * ordinary CI, and a table absent from its list is invisible to it even when it does.
 *
 * ===========================================================================
 * WHAT "LOCKED" MEANS, AND WHY GRANTS MATTER MORE THAN THEY LOOK
 * ===========================================================================
 * Three conditions: RLS enabled, FORCE, and no grant to a Data-API role. The third is the one
 * that is easy to under-rate, because "RLS is on with no policies, so everything is denied"
 * sounds like enough. It is not, and the reason is `rolbypassrls`:
 *
 *   anon / authenticated  -> bypassrls = false  -> RLS denies them, grant or no grant
 *   service_role          -> bypassrls = TRUE   -> RLS does not apply; only the GRANT stops it
 *
 * So on a table that keeps its `service_role` grant, RLS is not the control — the grant is,
 * and it is open. That is exactly why the house pattern REVOKEs rather than trusting RLS
 * alone, and why a table can be "RLS enabled, 0 policies" and still be reachable.
 *
 *   pnpm db:audit:rls            # report; exit 1 on any deviation
 *   pnpm db:audit:rls --json=<p> # + an evidence record
 */
import { config } from "dotenv";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sql as dsql } from "drizzle-orm";

import { createDbClient } from "./client";
import { hostClass } from "./audit-embedding-provenance";
import { DATA_API_ROLES } from "./schema-contract";

config({ path: join("..", "..", ".env") });

const SCRIPT = "audit:rls";

export interface TableRls {
  readonly table: string;
  readonly enabled: boolean;
  readonly forced: boolean;
  readonly grantedRoles: readonly string[];
}

/** One reason a table is not locked. Ordered worst-first by {@link rlsFindings}. */
export interface RlsFinding {
  readonly table: string;
  readonly problem: "granted-to-bypassing-role" | "granted-to-data-api-role" | "not-forced" | "rls-off";
  readonly detail: string;
}

/**
 * Roles that IGNORE row-level security. A grant to one of these is not mitigated by RLS,
 * whatever the policy set says — so it is reported at a higher severity than a grant to a role
 * RLS still filters.
 *
 * `postgres` is the owner and the backend's own connection; FORCE is what governs it, and
 * revoking its grant would take the application down. It is deliberately not listed.
 */
export const RLS_BYPASSING_ROLES = ["service_role"] as const;

/** Every way this table deviates, worst first. Empty means locked. Pure. */
export function rlsFindings(t: TableRls): RlsFinding[] {
  const out: RlsFinding[] = [];
  const granted = new Set(t.grantedRoles.map((r) => r.toLowerCase()));

  for (const role of RLS_BYPASSING_ROLES) {
    if (granted.has(role.toLowerCase())) {
      out.push({
        table: t.table,
        problem: "granted-to-bypassing-role",
        detail: `${role} holds a grant AND bypasses RLS — the grant is the only control, and it is open`,
      });
    }
  }
  const plain = DATA_API_ROLES.filter(
    (r) => granted.has(r.toLowerCase()) && !RLS_BYPASSING_ROLES.some((b) => b.toLowerCase() === r.toLowerCase()),
  );
  if (plain.length > 0) {
    out.push({
      table: t.table,
      problem: "granted-to-data-api-role",
      detail: `${plain.join(", ")} hold grants (RLS still filters them, but the REVOKE is missing)`,
    });
  }
  if (!t.enabled) {
    out.push({ table: t.table, problem: "rls-off", detail: "ROW LEVEL SECURITY is not enabled at all" });
  } else if (!t.forced) {
    out.push({
      table: t.table,
      problem: "not-forced",
      detail: "RLS is enabled but not FORCED — the table owner bypasses every policy",
    });
  }
  return out;
}

/** The remediation, in the order a migration would apply it. Pure, so it is testable. */
export function remediationSql(t: TableRls): string[] {
  const out: string[] = [];
  if (!t.enabled) out.push(`ALTER TABLE "${t.table}" ENABLE ROW LEVEL SECURITY;`);
  if (!t.forced) out.push(`ALTER TABLE "${t.table}" FORCE ROW LEVEL SECURITY;`);
  const granted = new Set(t.grantedRoles.map((r) => r.toLowerCase()));
  for (const role of DATA_API_ROLES) {
    if (granted.has(role.toLowerCase())) out.push(`REVOKE ALL ON TABLE "${t.table}" FROM ${role};`);
  }
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const jsonArg = argv.find((a) => a.startsWith("--json="));
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);

  const { db, sql } = createDbClient(url, { max: 1 });
  try {
    console.log(`[${SCRIPT}] READ-ONLY.`);
    console.log(`  target = ${hostClass(url)}`);

    const rows = (await db.execute(
      dsql`SELECT c.relname AS tbl, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
                  coalesce(g.grantees, '') AS grantees
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           LEFT JOIN (
             SELECT table_name, string_agg(DISTINCT grantee, ',') AS grantees
             FROM information_schema.role_table_grants
             WHERE table_schema = 'public' GROUP BY table_name
           ) g ON g.table_name = c.relname
           WHERE n.nspname = 'public' AND c.relkind = 'r'
           ORDER BY c.relname`,
    )) as unknown as { tbl: string; enabled: boolean; forced: boolean; grantees: string }[];

    const tables: TableRls[] = rows.map((r) => ({
      table: r.tbl,
      enabled: r.enabled === true,
      forced: r.forced === true,
      grantedRoles: r.grantees ? r.grantees.split(",").filter(Boolean) : [],
    }));

    const deviating = tables.map((t) => ({ t, findings: rlsFindings(t) })).filter((x) => x.findings.length > 0);

    console.log(`  public tables    = ${tables.length}`);
    console.log(`  fully locked     = ${tables.length - deviating.length}`);
    console.log(`  DEVIATING        = ${deviating.length}`);

    for (const { t, findings } of deviating) {
      console.log(`\n  ${t.table}`);
      for (const f of findings) console.log(`     ${f.problem.padEnd(26)} ${f.detail}`);
      for (const s of remediationSql(t)) console.log(`     $ ${s}`);
    }

    if (deviating.length > 0) {
      console.log(`\n  NOT LOCKED: ${deviating.length} table(s). Remediation is a migration, not a console edit —`);
      console.log(`  the REVOKEs must be in a file or the next environment rebuild loses them again.`);
      process.exitCode = 1;
    } else {
      console.log(`\n  every public table is RLS-enabled, FORCED, and revoked from the Data-API roles.`);
    }

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
            kind: "rls-audit",
            target: hostClass(url),
            tables: tables.length,
            deviating: deviating.map((d) => ({ table: d.t.table, findings: d.findings, remediation: remediationSql(d.t) })),
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
    const err = e as { message?: string; cause?: { message?: string } };
    console.error(err?.message ?? String(e));
    if (err?.cause?.message) console.error(`  cause: ${err.cause.message}`);
    process.exit(1);
  });
}
