/**
 * The skill / skill-alias lifecycle, measured end to end. READ-ONLY, ₹0.
 *
 * ===========================================================================
 * WHAT THIS ANSWERS THAT A COUNT DOES NOT
 * ===========================================================================
 * "336 skill aliases" is true and tells nobody whether the number can grow. This runner walks
 * the whole spine — occupation catalogue, skill catalogue, both alias tables, the bridge, the
 * miss queue, and the three consumption tables — and reports each stage beside **the thing that
 * would have to happen for the next stage to fill**.
 *
 * Three transitions turn out to be the whole story, and none of them is visible in a row count:
 *
 *   1. `job_domain_skill` covers 28 of 3,885 selectable occupations, and its only writer is a
 *      seeder fed by a 28-row hand-picked file. The Path A canonicalization scope is therefore
 *      bounded by that file, not by the catalogue.
 *   2. Every queued miss sits at `count = 1` or `2`, under a promotion floor of 3, so both
 *      growth loops would emit zero proposals if they ran.
 *   3. Both growth loops refuse to start when `NODE_ENV=production`, which is what the only
 *      environment holding the credentials sets.
 *
 * ===========================================================================
 * IT ALSO CHECKS THAT THE MODEL IS STILL TRUE
 * ===========================================================================
 * `skill-lifecycle.ts` declares the paths; this runner re-derives the writer set from the
 * source tree and refuses to report if the two disagree. A dependency map that contradicts
 * itself is worse than none — it reads authoritative.
 *
 * SCOPE NOTE, stated because it is a real limit: the writer scan covers `packages/db/src` only.
 * `unresolved_phrase` also has a RUNTIME writer in `apps/api/src/skills/skills.repository.ts`,
 * which is why the queue fills without any runner being invoked. That writer is declared in the
 * lifecycle model as a RUNTIME step and is deliberately outside the scan's reach.
 *
 * PRIVACY: counts, ids from closed sets, and timestamps. No phrase text, no worker data.
 *
 *   pnpm db:audit:skill-lifecycle [--json=<out>]
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { sql as dsql } from "drizzle-orm";
import { config } from "dotenv";

import { createDbClient } from "./client";
import { provenance } from "./evidence-provenance";
import { crossVocabularyWriters, scanWriters, type SpineTable } from "./lifecycle-writer-scan";
import { hostClass } from "./ops-guard";
import {
  LIFECYCLE,
  automaticPrefix,
  fullyAutomaticPaths,
  humanGates,
  reachesProductAutomatically,
  trafficDrivenPaths,
  validateLifecycle,
} from "./skill-lifecycle";

config({ path: "../../.env" });
config();

const SCRIPT = "audit:skill-lifecycle";
const SRC = __dirname;

function arg(n: string): string | undefined {
  return process.argv.find((x) => x.startsWith(`--${n}=`))?.slice(n.length + 3);
}

/** One measured stage of the spine, and what gates the next one. */
interface Stage {
  readonly stage: string;
  readonly n: number;
  readonly of: number | null;
  readonly note: string;
}

interface Population {
  jd_total: number;
  jd_selectable_active: number;
  jda_total: number;
  jda_searchable: number;
  jda_embedded: number;
  jds_edges: number;
  jds_domains: number;
  jds_skills: number;
  jds_domains_with_active_skill: number;
  skill_total: number;
  skill_active_attr: number;
  skill_provisional_attr: number;
  skill_deprecated: number;
  skill_match: number;
  sa_total: number;
  sa_normalized: number;
  sa_embedded: number;
  sa_slug: number;
  sa_pathb: number;
  sa_patha: number;
  up_skill: number;
  up_occupation: number;
  up_at_floor: number;
  chat_inbound: number;
  chat_sessions: number;
  worker_skill: number;
  worker_profile_skill: number;
  job_posting_skill: number;
}

/** The growth promotion floor both loops apply. Mirrors `skill_growth_min_total_count` = 3. */
const GROWTH_FLOOR = 3;

async function main(): Promise<void> {
  // FAIL CLOSED ON A MODEL THAT NO LONGER MATCHES THE CODE. Reported before the connection is
  // opened, so a stale model cannot be dressed up in fresh numbers.
  const scan = scanWriters(SRC);
  const problems = validateLifecycle(LIFECYCLE, scan.writers);
  if (problems.length > 0) {
    throw new Error(
      `[${SCRIPT}] the lifecycle model disagrees with the source tree:\n` +
        problems.map((p) => `  - ${p.id}: ${p.problem}`).join("\n"),
    );
  }
  const crossVocab = crossVocabularyWriters(SRC);

  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);
  const { db, sql } = createDbClient(url, { max: 1 });

  try {
    await db.execute(dsql`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`);
    const [ro] = (await db.execute(dsql`SHOW default_transaction_read_only`)) as unknown as {
      default_transaction_read_only: string;
    }[];
    if (ro?.default_transaction_read_only !== "on") {
      throw new Error(`[${SCRIPT}] session is not read-only; refusing to measure`);
    }
    // A ZERO FROM A ROLE WITHOUT BYPASSRLS IS NOT EVIDENCE — every table below is FORCE RLS
    // with no policies, so "0 aliases" would be indistinguishable from "not permitted to look".
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

    const [p] = (await db.execute(dsql`
      SELECT
        (SELECT count(*)::int FROM job_domain)                                    AS jd_total,
        (SELECT count(*)::int FROM job_domain WHERE selectable AND status='active') AS jd_selectable_active,
        (SELECT count(*)::int FROM job_domain_alias)                              AS jda_total,
        (SELECT count(*)::int FROM job_domain_alias WHERE is_searchable)          AS jda_searchable,
        (SELECT count(*)::int FROM job_domain_alias WHERE embedding IS NOT NULL)  AS jda_embedded,
        (SELECT count(*)::int FROM job_domain_skill)                              AS jds_edges,
        (SELECT count(DISTINCT job_domain_id)::int FROM job_domain_skill)         AS jds_domains,
        (SELECT count(DISTINCT skill_id)::int FROM job_domain_skill)              AS jds_skills,
        -- The LIVE Path A surface: an edge only answers if its skill is active AND embedded.
        (SELECT count(DISTINCT jds.job_domain_id)::int
           FROM job_domain_skill jds
           JOIN skill s ON s.skill_id = jds.skill_id
          WHERE jds.status='active' AND s.status='active'
            AND EXISTS (SELECT 1 FROM skill_alias sa
                         WHERE sa.skill_id = s.skill_id AND sa.embedding IS NOT NULL))
                                                                                  AS jds_domains_with_active_skill,
        (SELECT count(*)::int FROM skill)                                         AS skill_total,
        (SELECT count(*)::int FROM skill WHERE status='active' AND kind='attribute')      AS skill_active_attr,
        (SELECT count(*)::int FROM skill WHERE status='provisional' AND kind='attribute') AS skill_provisional_attr,
        (SELECT count(*)::int FROM skill WHERE status='deprecated')               AS skill_deprecated,
        (SELECT count(*)::int FROM skill WHERE kind='match_skill')                AS skill_match,
        (SELECT count(*)::int FROM skill_alias)                                   AS sa_total,
        (SELECT count(*)::int FROM skill_alias WHERE text_norm IS NOT NULL)       AS sa_normalized,
        (SELECT count(*)::int FROM skill_alias WHERE embedding IS NOT NULL)       AS sa_embedded,
        (SELECT count(*)::int FROM skill_alias WHERE domain_id IS NOT NULL)       AS sa_slug,
        (SELECT count(*)::int FROM skill_alias sa JOIN skill s ON s.skill_id=sa.skill_id
          WHERE s.status='active' AND sa.embedding IS NOT NULL AND sa.domain_id IS NOT NULL)
                                                                                  AS sa_pathb,
        (SELECT count(*)::int FROM skill_alias sa JOIN skill s ON s.skill_id=sa.skill_id
          JOIN job_domain_skill jds ON jds.skill_id=sa.skill_id
          WHERE s.status='active' AND sa.embedding IS NOT NULL AND jds.status='active')
                                                                                  AS sa_patha,
        (SELECT count(*)::int FROM unresolved_phrase WHERE scope='skill')         AS up_skill,
        (SELECT count(*)::int FROM unresolved_phrase WHERE scope='occupation')    AS up_occupation,
        (SELECT count(*)::int FROM unresolved_phrase WHERE count >= ${GROWTH_FLOOR}) AS up_at_floor,
        (SELECT count(*)::int FROM chat_messages WHERE direction='inbound' AND body_text IS NOT NULL)
                                                                                  AS chat_inbound,
        (SELECT count(DISTINCT session_id)::int FROM chat_messages WHERE direction='inbound')
                                                                                  AS chat_sessions,
        (SELECT count(*)::int FROM worker_skill)                                  AS worker_skill,
        (SELECT count(*)::int FROM worker_profile_skill)                          AS worker_profile_skill,
        (SELECT count(*)::int FROM job_posting_skill)                             AS job_posting_skill
    `)) as unknown as Population[];
    const pop = p!;

    // The scopes a canonicalization request can name, and whether the scope has any vocabulary.
    const slugs = (await db.execute(dsql`
      SELECT domain_id, count(*)::int AS aliases,
             count(*) FILTER (WHERE embedding IS NOT NULL)::int AS embedded
      FROM skill_alias WHERE domain_id IS NOT NULL GROUP BY 1 ORDER BY 2 DESC
    `)) as unknown as { domain_id: string; aliases: number; embedded: number }[];

    // Scopes that were actually REQUESTED in production, from the miss queue. A scope that was
    // asked about and holds no vocabulary is an unresolvable-by-construction scope, and that is
    // a different defect from "the floor was too high".
    const requested = (await db.execute(dsql`
      SELECT domain_id, count(*)::int AS misses,
             to_char(min(first_seen),'YYYY-MM-DD') AS first_seen,
             to_char(max(last_seen),'YYYY-MM-DD')  AS last_seen
      FROM unresolved_phrase WHERE scope='skill' AND domain_id IS NOT NULL
      GROUP BY 1 ORDER BY 2 DESC
    `)) as unknown as { domain_id: string; misses: number; first_seen: string; last_seen: string }[];

    const withVocab = new Set(slugs.filter((s) => s.embedded > 0).map((s) => s.domain_id));
    const emptyScopes = requested.filter((r) => !withVocab.has(r.domain_id));

    // -----------------------------------------------------------------------
    console.log(`[${SCRIPT}] READ-ONLY, ZERO SPEND, NO PHRASE TEXT SELECTED.`);
    console.log(`  target = ${hostClass(url)}  role=${who?.who}  bypassrls=${who?.bypass_rls}\n`);

    console.log(`  === the model, checked against the source tree ===`);
    console.log(`  lifecycle paths declared        = ${LIFECYCLE.length}  (coherent)`);
    for (const [t, files] of scan.byTable) {
      console.log(`    ${(t as SpineTable).padEnd(20)} writers ${String(files.size).padStart(2)}  ${[...files].join(", ")}`);
    }
    console.log(
      `  cross-vocabulary writers        = ${crossVocab.length}` +
        `${crossVocab.length === 0 ? "  (job_domain_alias never feeds skill_alias)" : `  ${crossVocab.join(", ")}`}`,
    );

    console.log(`\n  === how far each path travels without a person ===`);
    for (const path of LIFECYCLE) {
      const auto = automaticPrefix(path);
      const gates = humanGates(path);
      console.log(
        `    ${path.id.padEnd(24)} auto ${String(auto.length).padStart(1)}/${path.steps.length} step(s), ` +
          `${gates.length} human gate(s)  -> ` +
          (reachesProductAutomatically(path)
            ? `PRODUCES ${path.produces} UNATTENDED`
            : `stops before producing ${path.produces}`),
      );
    }
    console.log(
      `  fully automatic paths           = ${fullyAutomaticPaths().length}  ` +
        `(traffic-driven paths: ${trafficDrivenPaths().length})`,
    );

    const stages: Stage[] = [
      { stage: "occupation catalogue", n: pop.jd_selectable_active, of: pop.jd_total, note: "selectable + active" },
      { stage: "occupation aliases", n: pop.jda_searchable, of: pop.jda_total, note: "is_searchable — the partial HNSW index" },
      { stage: "  ...embedded", n: pop.jda_embedded, of: pop.jda_total, note: "one model throughout" },
      { stage: "BRIDGE job_domain_skill", n: pop.jds_domains, of: pop.jd_selectable_active, note: "domains with ANY edge" },
      { stage: "  ...that can answer", n: pop.jds_domains_with_active_skill, of: pop.jd_selectable_active, note: "edge active AND skill active AND alias embedded" },
      { stage: "skill catalogue", n: pop.skill_active_attr, of: pop.skill_total, note: `active attribute; ${pop.skill_provisional_attr} provisional, ${pop.skill_match} match_skill, ${pop.skill_deprecated} deprecated` },
      { stage: "skill aliases", n: pop.sa_total, of: pop.sa_total, note: `${pop.sa_normalized} normalized, ${pop.sa_embedded} embedded` },
      { stage: "  ...reachable via Path B", n: pop.sa_pathb, of: pop.sa_total, note: "legacy slug scope" },
      { stage: "  ...reachable via Path A", n: pop.sa_patha, of: pop.sa_total, note: "job_domain_skill scope" },
      { stage: "miss queue (skill)", n: pop.up_skill, of: pop.up_skill + pop.up_occupation, note: "written at runtime by the api" },
      { stage: "miss queue (occupation)", n: pop.up_occupation, of: pop.up_skill + pop.up_occupation, note: "written at runtime by the api" },
      { stage: "  ...at the growth floor", n: pop.up_at_floor, of: pop.up_skill + pop.up_occupation, note: `count >= ${GROWTH_FLOOR}` },
      { stage: "mining input", n: pop.chat_inbound, of: pop.chat_inbound, note: `${pop.chat_sessions} distinct sessions` },
      { stage: "CONSUMPTION worker_skill", n: pop.worker_skill, of: null, note: "what canonicalization is for" },
      { stage: "CONSUMPTION worker_profile_skill", n: pop.worker_profile_skill, of: null, note: "" },
      { stage: "CONSUMPTION job_posting_skill", n: pop.job_posting_skill, of: null, note: "the demand side" },
    ];

    console.log(`\n  === the measured spine ===`);
    for (const s of stages) {
      const of = s.of === null ? "" : ` / ${String(s.of).padStart(5)}`;
      console.log(`    ${s.stage.padEnd(33)} ${String(s.n).padStart(5)}${of.padEnd(9)}  ${s.note}`);
    }

    console.log(`\n  === canonicalization scopes: vocabulary present vs vocabulary requested ===`);
    for (const s of slugs) {
      console.log(`    HAS VOCAB  ${s.domain_id.padEnd(20)} aliases ${String(s.aliases).padStart(3)}  embedded ${String(s.embedded).padStart(3)}`);
    }
    for (const r of emptyScopes) {
      console.log(
        `    NO VOCAB   ${r.domain_id.padEnd(20)} misses  ${String(r.misses).padStart(3)}  ` +
          `${r.first_seen}..${r.last_seen}  <- unresolvable by construction, at any floor`,
      );
    }

    const out = arg("json");
    if (out !== undefined) {
      writeFileSync(
        out,
        `${JSON.stringify(
          {
            kind: "skill-lifecycle",
            ...provenance({
              source: `pnpm db:audit:skill-lifecycle`,
              target: hostClass(url),
              readOnly: true,
              role: who?.who ?? null,
              bypassRls: who?.bypass_rls === true,
              populationPredicate:
                "every table on the taxonomy spine (job_domain, job_domain_alias, " +
                "job_domain_skill, skill, skill_alias, unresolved_phrase) plus the three " +
                "consumption tables and the mining input, counted whole with no sampling",
            }),
            ai_spend_inr: 0,
            production_mutation_performed: false,
            growth_floor: GROWTH_FLOOR,
            population: pop,
            stages,
            writers: Object.fromEntries([...scan.byTable].map(([t, f]) => [t, [...f].sort()])),
            writer_scan_scope: "packages/db/src only — the runtime unresolved_phrase writer lives in apps/api",
            cross_vocabulary_writers: crossVocab,
            paths: LIFECYCLE.map((path) => ({
              id: path.id,
              title: path.title,
              origin: path.origin,
              produces: path.produces,
              steps: path.steps.length,
              automatic_prefix: automaticPrefix(path).length,
              human_gates: humanGates(path).length,
              reaches_product_automatically: reachesProductAutomatically(path),
              ever_completed: path.everCompleted,
            })),
            fully_automatic_paths: fullyAutomaticPaths().map((x) => x.id),
            scopes_with_vocabulary: slugs,
            scopes_requested_with_no_vocabulary: emptyScopes,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      console.log(`\n  written to ${join(out)}`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
