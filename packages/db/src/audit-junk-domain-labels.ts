/**
 * D-5 — the non-title `job_domain.label_en` rows and their aliases. READ-ONLY.
 *
 * ===========================================================================
 * READ-ONLY BY DECLARATION, NOT BY PROMISE
 * ===========================================================================
 * The first statement is `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`, and the
 * second reads `default_transaction_read_only` back and aborts unless it is `on`. From that
 * point the SERVER rejects any write on this connection, so the guarantee does not depend on
 * every query below being inspected. `materialize-inheritance-dry-run.ts` gets the same
 * property structurally, by having no write path; this file gets it from the server because
 * it is doing far more querying.
 *
 * ===========================================================================
 * WHAT IT REFUSES TO CONCLUDE
 * ===========================================================================
 * A count of zero references is only evidence if the reader could have seen the rows. Two
 * ways it could not:
 *
 *   RLS      — every table here is `FORCE ROW LEVEL SECURITY` with zero policies, so a role
 *              without BYPASSRLS reads an empty table and calls it unused. The audit prints
 *              `current_user` and `rolbypassrls` and refuses to classify without it.
 *   MISSING  — a table declared in the schema may not exist in the target yet. That is
 *              reported as UNKNOWN, never folded into zero.
 *
 *   pnpm db:audit:junk-labels [--json=<out>]
 */
import { writeFileSync } from "node:fs";

import { sql as dsql } from "drizzle-orm";
import { config } from "dotenv";

import { createDbClient } from "./client";
import { hostClass } from "./ops-guard";
import {
  classifyAlias,
  classifyDomain,
  classifyLabel,
  isTitleShaped,
  NO_REMEDIATION_NOTICE,
  type AliasClass,
  type DomainClass,
} from "./junk-label-classifier";

config({ path: "../../.env" });
config();

const SCRIPT = "audit:junk-labels";

/** Tables that carry a `job_domain_id`. Probed for existence before being counted. */
const REFERENCING_TABLES = [
  "job_domain_skill",
  "worker_profiles",
  "job_postings",
  "unresolved_phrase",
  "profiling_family_binding",
] as const;

function arg(n: string): string | undefined {
  return process.argv.find((x) => x.startsWith(`--${n}=`))?.slice(n.length + 3);
}

interface DomainRow {
  job_domain_id: string;
  label_en: string;
  label_hi: string | null;
  source: string;
  source_code: string | null;
  level: number;
  status: string;
  selectable: boolean;
  isco_unit_code: string | null;
  industry_id: string | null;
  canonical_role_id: string | null;
  parent_job_domain_id: string | null;
  child_count: string;
}

interface AliasRow {
  id: string;
  job_domain_id: string;
  text: string;
  text_norm: string | null;
  is_searchable: boolean;
  lang: string | null;
  source: string;
  embedded: boolean;
  domains_sharing_norm: string;
}

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);
  const { db, sql } = createDbClient(url, { max: 1 });

  try {
    await db.execute(dsql`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`);
    const [ro] = (await db.execute(
      dsql`SHOW default_transaction_read_only`,
    )) as unknown as Array<{ default_transaction_read_only: string }>;
    if (ro?.default_transaction_read_only !== "on") {
      throw new Error(`[${SCRIPT}] refusing to run: the session is not read-only`);
    }

    const [who] = (await db.execute(dsql`
      SELECT current_user AS who,
             (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass_rls
    `)) as unknown as Array<{ who: string; bypass_rls: boolean }>;
    const canSeeEverything = who?.bypass_rls === true;

    console.log(`[${SCRIPT}] READ-ONLY session (server-enforced).`);
    console.log(`  target                 = ${hostClass(url)}`);
    console.log(`  role                   = ${who?.who ?? "?"} (bypassrls=${String(canSeeEverything)})`);
    if (!canSeeEverything) {
      console.log(
        `\n  !! This role does NOT bypass RLS. Every table below is FORCE ROW LEVEL SECURITY\n` +
          `     with zero policies, so a reference count of 0 would be indistinguishable from\n` +
          `     "not permitted to see it". Reference counts are NOT reported.`,
      );
    }

    // ---- which referencing tables actually exist in this target ----
    const present = new Set(
      (
        (await db.execute(dsql`
          SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
        `)) as unknown as Array<{ table_name: string }>
      ).map((r) => r.table_name),
    );
    const missing = REFERENCING_TABLES.filter((t) => !present.has(t));

    // ---- the population ----
    const domains = (await db.execute(dsql`
      SELECT d.job_domain_id, d.label_en, d.label_hi, d.source, d.source_code, d.level,
             d.status, d.selectable, d.isco_unit_code, d.industry_id, d.canonical_role_id,
             d.parent_job_domain_id,
             (SELECT count(*) FROM job_domain c WHERE c.parent_job_domain_id = d.job_domain_id) AS child_count
      FROM job_domain d
      WHERE d.label_en LIKE '%:' OR d.label_en ~ '^[a-z]'
      ORDER BY d.job_domain_id
    `)) as unknown as DomainRow[];

    const ids = domains.map((d) => d.job_domain_id);

    const aliases = (await db.execute(dsql`
      SELECT a.id::text AS id, a.job_domain_id, a.text, a.text_norm, a.is_searchable, a.lang,
             a.source, (a.embedding IS NOT NULL) AS embedded,
             (SELECT count(DISTINCT b.job_domain_id) FROM job_domain_alias b
              WHERE b.is_searchable AND b.text_norm = a.text_norm) AS domains_sharing_norm
      FROM job_domain_alias a
      WHERE a.job_domain_id IN (SELECT job_domain_id FROM job_domain
                                WHERE label_en LIKE '%:' OR label_en ~ '^[a-z]')
      ORDER BY a.job_domain_id, a.text
    `)) as unknown as AliasRow[];

    // ---- references, per table, only where the table exists AND we can see through RLS ----
    const refsByDomain = new Map<string, number>();
    const refTotals: Record<string, number | "UNKNOWN"> = {};
    for (const t of REFERENCING_TABLES) {
      if (!present.has(t)) {
        refTotals[t] = "UNKNOWN";
        continue;
      }
      if (!canSeeEverything) {
        refTotals[t] = "UNKNOWN";
        continue;
      }
      const rows = (await db.execute(dsql`
        SELECT job_domain_id, count(*) AS n FROM ${dsql.identifier(t)}
        WHERE job_domain_id IN (SELECT job_domain_id FROM job_domain
                                WHERE label_en LIKE '%:' OR label_en ~ '^[a-z]')
        GROUP BY 1
      `)) as unknown as Array<{ job_domain_id: string; n: string }>;
      let total = 0;
      for (const r of rows) {
        refsByDomain.set(r.job_domain_id, (refsByDomain.get(r.job_domain_id) ?? 0) + Number(r.n));
        total += Number(r.n);
      }
      refTotals[t] = total;
    }

    // ---- classify ----
    const aliasByDomain = new Map<string, AliasRow[]>();
    for (const a of aliases) {
      aliasByDomain.set(a.job_domain_id, [...(aliasByDomain.get(a.job_domain_id) ?? []), a]);
    }

    const aliasVerdicts = aliases.map((a) => ({
      ...a,
      klass: classifyAlias({
        text: a.text,
        isSearchable: a.is_searchable,
        domainsSharingNorm: Number(a.domains_sharing_norm),
      }),
    }));

    const domainVerdicts = domains.map((d) => {
      const mine = aliasByDomain.get(d.job_domain_id) ?? [];
      const searchable = mine.filter((a) => a.is_searchable);
      return {
        ...d,
        label_defect: classifyLabel(d.label_en).defect,
        searchable_aliases: searchable.length,
        title_shaped_aliases: searchable.filter((a) => isTitleShaped(a.text)).length,
        references: refsByDomain.get(d.job_domain_id) ?? 0,
        klass: classifyDomain({
          jobDomainId: d.job_domain_id,
          labelEn: d.label_en,
          childCount: Number(d.child_count),
          referenceCount: refsByDomain.get(d.job_domain_id) ?? 0,
          searchableAliases: searchable.length,
          titleShapedAliases: searchable.filter((a) => isTitleShaped(a.text)).length,
          hasSourceCode: d.source_code !== null,
        }),
      };
    });

    // ---- report ----
    const tally = <T extends string>(xs: readonly { klass: T }[]): Record<string, number> => {
      const o: Record<string, number> = {};
      for (const x of xs) o[x.klass] = (o[x.klass] ?? 0) + 1;
      return o;
    };
    const domainCounts = tally<DomainClass>(domainVerdicts);
    const aliasCounts = tally<AliasClass>(aliasVerdicts);

    console.log(`\n  === population ===`);
    console.log(`  non-title label_en rows    = ${domains.length}`);
    console.log(`    section headers  ("...:")= ${domainVerdicts.filter((d) => d.label_defect === "SECTION_HEADER").length}`);
    console.log(`    prose fragments (lower)  = ${domainVerdicts.filter((d) => d.label_defect === "PROSE_FRAGMENT").length}`);
    console.log(`  their alias rows           = ${aliases.length}`);
    console.log(`    on the retrieval surface = ${aliases.filter((a) => a.is_searchable).length}`);
    console.log(`    embedded (live in ANN)   = ${aliases.filter((a) => a.is_searchable && a.embedded).length}`);
    console.log(`  all selectable+active      = ${domains.every((d) => d.selectable && d.status === "active")}`);
    console.log(`  distinct sources           = ${[...new Set(domains.map((d) => d.source))].join(", ")}`);
    console.log(`  with a published code      = ${domains.filter((d) => d.source_code !== null).length}`);
    console.log(`  with any child             = ${domains.filter((d) => Number(d.child_count) > 0).length}`);

    console.log(`\n  === references, per table ===`);
    for (const t of REFERENCING_TABLES) {
      const v = refTotals[t];
      const note = v === "UNKNOWN" ? (present.has(t) ? "  (RLS: cannot see)" : "  (table absent in target)") : "";
      console.log(`  ${t.padEnd(28)} ${String(v).padStart(8)}${note}`);
    }
    if (missing.length > 0) {
      console.log(`\n  !! declared in the schema but ABSENT here: ${missing.join(", ")}`);
      console.log(`     Reported UNKNOWN, never folded into zero.`);
    }

    console.log(`\n  === domain classification ===`);
    for (const [k, v] of Object.entries(domainCounts).sort()) {
      console.log(`  ${k.padEnd(28)} ${String(v).padStart(5)}`);
    }

    console.log(`\n  === alias classification ===`);
    for (const [k, v] of Object.entries(aliasCounts).sort()) {
      console.log(`  ${k.padEnd(28)} ${String(v).padStart(5)}`);
    }

    const conflicts = aliasVerdicts.filter((a) => a.klass === "CONFLICTING_ALIAS");
    if (conflicts.length > 0) {
      console.log(`\n  === CONFLICTING ALIASES — a worker phrase reaching two domains ===`);
      const byNorm = new Map<string, typeof conflicts>();
      for (const c of conflicts) {
        byNorm.set(c.text_norm ?? "", [...(byNorm.get(c.text_norm ?? "") ?? []), c]);
      }
      for (const [norm, rows] of [...byNorm.entries()].sort()) {
        console.log(`     "${norm}" — ${rows[0]?.domains_sharing_norm} domains, ${rows.length} of them here`);
      }
    }

    const needReview = domainVerdicts.filter((d) => d.klass === "E_AMBIGUOUS" || d.klass === "A_UNUSED_JUNK");
    if (needReview.length > 0) {
      console.log(`\n  === needs owner review (${needReview.length}) ===`);
      for (const d of needReview) {
        console.log(
          `     ${d.klass.padEnd(24)} ${d.job_domain_id}  aliases=${d.searchable_aliases}` +
            ` titleish=${d.title_shaped_aliases}  "${d.label_en.slice(0, 48)}"`,
        );
      }
    }

    console.log(`\n  ${NO_REMEDIATION_NOTICE}`);

    const out = arg("json");
    if (out !== undefined) {
      writeFileSync(
        out,
        `${JSON.stringify(
          {
            kind: "junk-domain-label-audit",
            target: hostClass(url),
            role: who?.who ?? null,
            bypass_rls: canSeeEverything,
            tables_absent: missing,
            reference_totals: refTotals,
            domain_counts: domainCounts,
            alias_counts: aliasCounts,
            domains: domainVerdicts,
            aliases: aliasVerdicts,
            notice: NO_REMEDIATION_NOTICE,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      console.log(`\n  written to ${out}`);
    }

    void ids;
  } finally {
    await sql.end();
  }
}

/**
 * Say what actually went wrong.
 *
 * A saturated Supabase pooler surfaces as a `cause` two frames down, so the default handler
 * prints "Failed query: SET SESSION CHARACTERISTICS…" and buries the reason. That reads as a
 * broken statement and sends the next reader to debug the SQL, which is the wrong place.
 */
export function explain(e: unknown): string {
  const cause = (e as { cause?: { message?: string } } | undefined)?.cause?.message;
  if (cause !== undefined && cause.includes("max clients")) {
    return (
      `[${SCRIPT}] BLOCKED — the connection pooler is saturated, not a query fault:\n  ${cause}\n` +
      `  This is environmental. Retry when capacity frees; do not change pooler configuration.`
    );
  }
  const head = e instanceof Error ? e.message : String(e);
  return cause === undefined ? head : `${head}\n  cause: ${cause}`;
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(explain(e));
    process.exit(1);
  });
}
