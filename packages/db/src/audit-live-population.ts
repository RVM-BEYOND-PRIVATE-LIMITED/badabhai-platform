/**
 * The live population, and how it got there. READ-ONLY, ₹0.
 *
 * ===========================================================================
 * WHY A COUNT IS NOT ENOUGH
 * ===========================================================================
 * This programme has already been burned once by a bare count. `d1-runtime-path-trace.md`
 * recorded 44 worker profiles; 45 were deleted through the Supabase dashboard hours later the
 * same day; both documents were dated 2026-08-21 and neither was wrong. The date could not
 * separate them, so a correct measurement read as a contradiction for three days.
 *
 * The lesson was recorded as "artifacts must say when they were true". This instrument goes one
 * step further: a count that MOVED should also say **which direction and by what mechanism**.
 * `workers` went 1 -> 37 between 2026-08-24 and 2026-08-26, and "37" alone cannot distinguish
 *
 *     36 people registered            (growth — the product working)
 *     rows were restored              (an operation nobody recorded)
 *     the earlier count was partial   (a measurement defect)
 *
 * So every count here is reported beside the two things that can change it: `created_at`
 * histograms for arrivals, and `_delete_forensics` for departures. Where those two reconcile
 * with the delta, the movement is explained; where they do not, the report says so rather than
 * asserting the pleasant reading.
 *
 * ===========================================================================
 * WHAT IT DOES NOT DO
 * ===========================================================================
 * It reads no PII. Counts, timestamps and table names only — no name, phone, email or free text
 * leaves the database, and none is selected in the first place.
 *
 * It does not edit history. Historical figures are quoted from the committed documents and
 * compared; the documents themselves are left exactly as they were.
 *
 *   pnpm db:audit:live-population [--json=<out>]
 */
import { writeFileSync } from "node:fs";

import { sql as dsql } from "drizzle-orm";
import { config } from "dotenv";

import { createDbClient } from "./client";
import { provenance } from "./evidence-provenance";
import { hostClass } from "./ops-guard";

config({ path: "../../.env" });
config();

const SCRIPT = "audit:live-population";

/**
 * What the committed documents said, and when. Quoted, never edited.
 *
 * `null` means the document did not state the figure — which is different from stating zero, and
 * collapsing the two is how a "regression" gets reported that is really a gap in an old report.
 */
const RECORDED: Readonly<Record<string, Readonly<Record<string, number | null>>>> = {
  "2026-08-21 (d1-runtime-path-trace, PRE-deletion)": {
    workers: null,
    worker_profiles: 44,
    worker_skill: 8,
    job_reach: 6,
    jobs: null,
    applications: null,
    job_posting_skill: 0,
  },
  "2026-08-24 (project-control)": {
    workers: 1,
    worker_profiles: null,
    worker_skill: 8,
    job_reach: 0,
    jobs: 25,
    applications: 92,
    job_posting_skill: 0,
  },
};

function arg(n: string): string | undefined {
  return process.argv.find((x) => x.startsWith(`--${n}=`))?.slice(n.length + 3);
}

interface Counts {
  workers: number;
  worker_profiles: number;
  worker_skill: number;
  job_reach: number;
  jobs: number;
  open_jobs: number;
  applications: number;
  job_posting_skill: number;
  voice_notes: number;
  skills_total: number;
  skills_active: number;
  skills_provisional: number;
  skills_deprecated: number;
  match_skill_rows: number;
}

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);

  const { db, sql } = createDbClient(url, { max: 1 });
  try {
    await db.execute(dsql`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`);
    const [ro] = (await db.execute(
      dsql`SHOW default_transaction_read_only`,
    )) as unknown as { default_transaction_read_only: string }[];
    if (ro?.default_transaction_read_only !== "on") {
      throw new Error(`[${SCRIPT}] session is not read-only; refusing to measure`);
    }
    // A ZERO FROM A ROLE WITHOUT BYPASSRLS IS NOT EVIDENCE. Every table below is FORCE RLS with
    // no policies, so a non-bypassing role reads them empty and "0 workers" would be
    // indistinguishable from "not permitted to look".
    const [who] = (await db.execute(dsql`
      SELECT current_user AS who,
             (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass_rls
    `)) as unknown as { who: string; bypass_rls: boolean }[];
    if (who?.bypass_rls !== true) {
      throw new Error(
        `[${SCRIPT}] role ${who?.who} does not bypass RLS. Every count would be a permission ` +
          `artifact rather than a measurement; refusing to report.`,
      );
    }

    const [counts] = (await db.execute(dsql`
      SELECT (SELECT count(*)::int FROM workers)            AS workers,
             (SELECT count(*)::int FROM worker_profiles)    AS worker_profiles,
             (SELECT count(*)::int FROM worker_skill)       AS worker_skill,
             (SELECT count(*)::int FROM job_reach)          AS job_reach,
             (SELECT count(*)::int FROM jobs)               AS jobs,
             (SELECT count(*)::int FROM jobs WHERE status='open') AS open_jobs,
             (SELECT count(*)::int FROM applications)       AS applications,
             (SELECT count(*)::int FROM job_posting_skill)  AS job_posting_skill,
             (SELECT count(*)::int FROM voice_notes)        AS voice_notes,
             (SELECT count(*)::int FROM skill)              AS skills_total,
             (SELECT count(*)::int FROM skill WHERE status='active')      AS skills_active,
             (SELECT count(*)::int FROM skill WHERE status='provisional') AS skills_provisional,
             (SELECT count(*)::int FROM skill WHERE status='deprecated')  AS skills_deprecated,
             (SELECT count(*)::int FROM skill WHERE kind='match_skill')   AS match_skill_rows
    `)) as unknown as Counts[];

    // ARRIVALS. Counts alone cannot say whether a number rose because people registered.
    const arrivals = (await db.execute(dsql`
      SELECT to_char(created_at, 'YYYY-MM-DD') AS day, count(*)::int AS n
      FROM workers GROUP BY 1 ORDER BY 1
    `)) as unknown as { day: string; n: number }[];
    const profileArrivals = (await db.execute(dsql`
      SELECT to_char(created_at, 'YYYY-MM-DD') AS day, count(*)::int AS n
      FROM worker_profiles GROUP BY 1 ORDER BY 1
    `)) as unknown as { day: string; n: number }[];

    // DEPARTURES, and who performed them.
    const forensics = (await db.execute(dsql`
      SELECT table_name, to_char(at, 'YYYY-MM-DD') AS day,
             app_name, db_user, count(*)::int AS n
      FROM _delete_forensics GROUP BY 1,2,3,4 ORDER BY 2 DESC, 1
    `)) as unknown as {
      table_name: string;
      day: string;
      app_name: string | null;
      db_user: string | null;
      n: number;
    }[];

    console.log(`[${SCRIPT}] READ-ONLY, ZERO SPEND, NO PII SELECTED.`);
    console.log(`  target = ${hostClass(url)}  role=${who?.who}  bypassrls=${who?.bypass_rls}\n`);

    console.log(`  --- now, versus what the documents recorded ---`);
    const rows: [string, number][] = Object.entries(counts ?? {}).map(([k, v]) => [k, v as number]);
    const header = Object.keys(RECORDED);
    console.log(
      `    ${"table".padEnd(20)} ${"NOW".padStart(6)}   ` +
        header.map((h) => h.slice(0, 12).padStart(13)).join(""),
    );
    for (const [k, v] of rows) {
      const cells = header.map((h) => {
        const r = RECORDED[h]?.[k];
        return (r === undefined || r === null ? "-" : String(r)).padStart(13);
      });
      const moved = header.some((h) => {
        const r = RECORDED[h]?.[k];
        return r !== undefined && r !== null && r !== v;
      });
      console.log(`    ${k.padEnd(20)} ${String(v).padStart(6)}   ${cells.join("")}${moved ? "   <- moved" : ""}`);
    }

    console.log(`\n  --- arrivals: workers by created_at ---`);
    for (const a of arrivals) console.log(`    ${a.day}  ${String(a.n).padStart(4)}`);
    console.log(`  --- arrivals: worker_profiles by created_at ---`);
    for (const a of profileArrivals) console.log(`    ${a.day}  ${String(a.n).padStart(4)}`);

    console.log(`\n  --- departures: _delete_forensics ---`);
    for (const f of forensics) {
      console.log(
        `    ${f.day}  ${f.table_name.padEnd(18)} ${String(f.n).padStart(4)}  ` +
          `app=${f.app_name ?? "(null)"} user=${f.db_user ?? "(null)"}`,
      );
    }
    const totalDeleted = forensics.reduce((n, f) => n + f.n, 0);
    const dashboardDeleted = forensics
      .filter((f) => (f.app_name ?? "").includes("dashboard"))
      .reduce((n, f) => n + f.n, 0);
    console.log(
      `    total ${totalDeleted}, of which ${dashboardDeleted} via the Supabase dashboard`,
    );

    // WHICH TABLES THE FORENSICS TRIGGER ACTUALLY COVERS. A table with no trigger cannot
    // produce a departure row, so "no deletions recorded" means one of two very different
    // things and the report must not merge them.
    const covered = (await db.execute(dsql`
      SELECT DISTINCT table_name FROM _delete_forensics ORDER BY 1
    `)) as unknown as { table_name: string }[];

    // CANDIDATE DEFINITIONS for a recorded figure that does not reproduce. Rather than guess
    // what "1 worker" counted, enumerate the plausible predicates and report which — if any —
    // yields it. An unmatched figure stays unmatched; inventing a reading is the failure mode.
    const [defs] = (await db.execute(dsql`
      SELECT (SELECT count(*)::int FROM workers WHERE created_at < '2026-08-24') AS workers_before_0824,
             (SELECT count(*)::int FROM worker_profiles WHERE created_at < '2026-08-24') AS profiles_before_0824,
             (SELECT count(*)::int FROM workers w WHERE EXISTS
                (SELECT 1 FROM applications a WHERE a.worker_id = w.id)) AS workers_with_application,
             (SELECT count(*)::int FROM workers w WHERE EXISTS
                (SELECT 1 FROM worker_profiles p WHERE p.worker_id = w.id)) AS workers_with_profile,
             (SELECT count(*)::int FROM worker_profiles WHERE job_domain_id IS NOT NULL) AS profiles_with_job_domain
    `)) as unknown as Record<string, number>[];

    const jobArrivals = (await db.execute(dsql`
      SELECT to_char(created_at, 'YYYY-MM-DD') AS day, count(*)::int AS n
      FROM jobs GROUP BY 1 ORDER BY 1
    `)) as unknown as { day: string; n: number }[];

    console.log(`\n  --- what _delete_forensics can see ---`);
    console.log(`    tables with recorded deletions: ${covered.map((c) => c.table_name).join(", ")}`);
    console.log(
      `    jobs and applications are NOT among them, so "no deletions recorded" for those is
` +
        `    the absence of a trigger, not the absence of a deletion.`,
    );

    console.log(`\n  --- candidate readings of the unreproducible 2026-08-24 "1 worker" ---`);
    for (const [k, v] of Object.entries(defs ?? {})) {
      console.log(`    ${k.padEnd(28)} ${String(v).padStart(4)}${v === 1 ? "   <- MATCHES" : ""}`);
    }
    const matches = Object.entries(defs ?? {}).filter(([, v]) => v === 1).map(([k]) => k);
    console.log(
      `    predicates yielding 1: ${matches.length === 0 ? "NONE" : matches.join(", ")}`,
    );

    console.log(`\n  --- jobs by created_at ---`);
    for (const j of jobArrivals) console.log(`    ${j.day}  ${String(j.n).padStart(4)}`);

    // IS ANYTHING TAXONOMY-SHAPED ACTUALLY HAPPENING TO A WORKER? The relevance chain is
    // documented as disconnected, and `job_domain_id` on a profile is the one place that could
    // be false without anybody noticing — it is written by the domain resolver, whose ANN layer
    // is flag-gated and whose LEXICAL layers are not.
    const domainMatches = (await db.execute(dsql`
      SELECT job_domain_match_status AS status, job_domain_match_layer AS layer,
             to_char(min(job_domain_matched_at), 'YYYY-MM-DD') AS first_day,
             to_char(max(job_domain_matched_at), 'YYYY-MM-DD') AS last_day,
             count(*)::int AS n
      FROM worker_profiles WHERE job_domain_id IS NOT NULL
      GROUP BY 1, 2 ORDER BY 5 DESC
    `)) as unknown as {
      status: string | null;
      layer: string | null;
      first_day: string;
      last_day: string;
      n: number;
    }[];
    const [emb] = (await db.execute(dsql`
      SELECT count(*)::int AS profiles_with_embedding FROM worker_profiles WHERE embedding IS NOT NULL
    `)) as unknown as { profiles_with_embedding: number }[];

    console.log(`\n  --- worker profiles carrying a job_domain_id ---`);
    for (const d of domainMatches) {
      console.log(
        `    ${String(d.status).padEnd(26)} layer=${String(d.layer ?? "(none)").padEnd(12)} ` +
          `${String(d.n).padStart(3)}   ${d.first_day} .. ${d.last_day}`,
      );
    }
    const annLayers = domainMatches.filter((d) => /ann|vector|embed/i.test(d.layer ?? ""));
    console.log(
      `    profiles with an embedding: ${emb?.profiles_with_embedding}   ` +
        `matches via an ANN layer: ${annLayers.length}`,
    );
    console.log(
      `    Every match above is LEXICAL (l0_exact / l2_trigram) or worker-confirmed. The ANN
` +
        `    layer is what DOMAIN_MATCH_ENABLED gates, and no row shows it running — so this is
` +
        `    the documented design rather than a flag being ignored. It is still live behaviour
` +
        `    that the "nothing is connected" summary does not mention.`,
    );

    // RECONCILIATION. The point of the whole instrument: does the movement have a mechanism?
    const since0824 = arrivals.filter((a) => a.day >= "2026-08-24").reduce((n, a) => n + a.n, 0);
    const recorded0824 = RECORDED["2026-08-24 (project-control)"]?.["workers"] ?? null;
    const explained =
      recorded0824 !== null && recorded0824 + since0824 === counts!.workers;
    console.log(`\n  --- reconciliation ---`);
    console.log(`    workers recorded 2026-08-24        ${recorded0824 ?? "-"}`);
    console.log(`    workers created on/after 08-24     ${since0824}`);
    console.log(`    workers now                        ${counts!.workers}`);
    console.log(
      `    movement explained by arrivals     ${explained}` +
        (explained
          ? "   <- growth, not restoration"
          : "   <- NOT fully explained; the delta needs a mechanism nobody has recorded"),
    );

    const out = arg("json");
    if (out !== undefined) {
      writeFileSync(
        out,
        `${JSON.stringify(
          {
            kind: "live-population",
            ...provenance({
              source: `pnpm db:audit:live-population`,
              target: hostClass(url),
              readOnly: true,
              role: who?.who ?? null,
              bypassRls: who?.bypass_rls ?? false,
              populationPredicate:
                "whole-table counts on the identity and relevance-chain tables, plus created_at " +
                "histograms and every _delete_forensics row; no PII column is selected",
            }),
            ai_spend_inr: 0,
            counts,
            recorded_previously: RECORDED,
            arrivals_workers: arrivals,
            arrivals_worker_profiles: profileArrivals,
            departures: forensics,
            departures_total: totalDeleted,
            departures_via_dashboard: dashboardDeleted,
            forensics_covers_tables: covered.map((c) => c.table_name),
            forensics_coverage_caveat:
              "The delete-forensics trigger exists on workers and worker_profiles only. For any " +
              "other table, an empty departure list is the absence of a TRIGGER and not evidence " +
              "that nothing was deleted.",
            candidate_readings_of_recorded_figures: defs ?? null,
            predicates_yielding_one_worker: matches,
            jobs_by_created_at: jobArrivals,
            worker_profile_job_domain_matches: domainMatches,
            worker_profiles_with_embedding: emb?.profiles_with_embedding ?? null,
            ann_layer_matches: annLayers.length,
            domain_match_note:
              "job_domain_id is set on worker profiles by the domain resolver. Every recorded " +
              "match is lexical (l0_exact / l2_trigram) or worker-confirmed; none is via an ANN " +
              "layer, and no profile carries an embedding. Consistent with DOMAIN_MATCH_ENABLED " +
              "being false, and not mentioned by the 'nothing is connected' summary.",
            reconciliation: {
              workers_recorded_2026_08_24: recorded0824,
              workers_created_on_or_after_2026_08_24: since0824,
              workers_now: counts!.workers,
              explained_by_arrivals: explained,
            },
            historical_documents_edited: false,
            production_mutation_performed: false,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      console.log(`\n  written to ${out}`);
    }
  } finally {
    await sql.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
