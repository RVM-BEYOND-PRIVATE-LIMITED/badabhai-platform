/**
 * The match-vocabulary gap, measured against LIVE demand. READ-ONLY, ₹0.
 *
 * Q1 left 62 promotable skills in trade families with no `mskill_*`. This asks the question that
 * decides whether that is a gap to fill or a boundary to respect: **can any job the platform is
 * able to accept ever require such a concept?**
 *
 * The answer is bounded by `TRADE_KEYS`, a closed 15-value union validated on the posting path,
 * and by `TRADE_TO_MATCH_SKILL`, which is total over it. Everything below reads those two plus
 * the live `jobs` table; nothing is invented and no mapping is written.
 *
 *   pnpm db:audit:vocabulary-gap [--json=<out>]
 */
import { writeFileSync } from "node:fs";

import { sql as dsql } from "drizzle-orm";
import { config } from "dotenv";

import {
  ATTRIBUTE_TO_MATCH_SKILLS,
  MATCH_SKILLS,
  TRADE_KEYS,
  TRADE_TO_MATCH_SKILL,
} from "@badabhai/taxonomy";

import { createDbClient } from "./client";
import { provenance } from "./evidence-provenance";
import { hostClass } from "./ops-guard";
import { FAMILIES, Q1_TRIAGE } from "./q1-disposition-triage";
import {
  demandReachableMatchSkills,
  familyGaps,
  newVocabularyRequired,
  unreachableMatchSkills,
} from "./vocabulary-gap";

config({ path: "../../.env" });
config();

const SCRIPT = "audit:vocabulary-gap";

/**
 * Which trade keys can express demand in each triage family. **ANALYTICAL, NOT RATIFIED.**
 *
 * Held here, visible, rather than derived by a helper, because attributing `assembly_technician`
 * to the `assembly` family is a judgement and a reader must be able to disagree with it. Every
 * one of the 15 keys is placed; a test asserts the placement is exhaustive, so a 16th trade key
 * cannot be silently unattributed.
 *
 * Note `assembly_technician`: the trade exists, so the `assembly` family HAS postable demand —
 * and `TRADE_TO_MATCH_SKILL` already routes it to `mskill_fitter`. The family looks unrepresented
 * from the attribute side and is served from the demand side. That is the shape of this whole
 * question.
 */
const TRADE_KEYS_BY_FAMILY: Readonly<Record<string, readonly string[]>> = {
  "machining-support": [
    "cnc_operator",
    "vmc_operator",
    "cnc_vmc_setter",
    "cnc_programmer",
    "vmc_programmer",
    "tool_room_technician",
    "machine_operator",
    "production_engineer",
    "cad_designer",
    "solidworks_designer",
    "autocad_draftsman",
  ],
  quality: ["quality_inspector"],
  "mech-maintenance": ["maintenance_technician", "fitter"],
  assembly: ["assembly_technician"],
  battery: [],
  "auto-service": [],
  masonry: [],
  electrical: [],
  "sheet-metal": [],
  hvac: [],
  plumbing: [],
  warehouse: [],
  "welding-support": [],
};

function arg(n: string): string | undefined {
  return process.argv.find((x) => x.startsWith(`--${n}=`))?.slice(n.length + 3);
}

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);

  const { db, sql } = createDbClient(url, { max: 1 });
  try {
    await db.execute(dsql`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`);
    const [who] = (await db.execute(dsql`
      SELECT current_user AS who,
             (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass_rls
    `)) as unknown as { who: string; bypass_rls: boolean }[];

    const jobs = (await db.execute(dsql`
      SELECT j.trade_key, j.status, count(*)::int AS jobs,
             (SELECT count(*)::int FROM applications a
               JOIN jobs j2 ON j2.id = a.job_id
              WHERE j2.trade_key = j.trade_key) AS applications
      FROM jobs j GROUP BY j.trade_key, j.status ORDER BY j.trade_key, j.status
    `)) as unknown as { trade_key: string; status: string; jobs: number; applications: number }[];

    const [chain] = (await db.execute(dsql`
      SELECT (SELECT count(*)::int FROM job_posting_skill) AS job_posting_skill,
             (SELECT count(*)::int FROM worker_skill)      AS worker_skill,
             (SELECT count(*)::int FROM job_reach)         AS job_reach,
             (SELECT count(*)::int FROM skill WHERE kind = 'match_skill') AS match_skill_rows
    `)) as unknown as { job_posting_skill: number; worker_skill: number; job_reach: number; match_skill_rows: number }[];

    const byFamily = new Map<string, string[]>();
    for (const t of Q1_TRIAGE) byFamily.set(t.family, [...(byFamily.get(t.family) ?? []), t.skillId]);
    const gaps = familyGaps(
      Object.entries(FAMILIES).map(([family, f]) => ({
        family,
        label: f.label,
        skillIds: byFamily.get(family) ?? [],
      })),
      ATTRIBUTE_TO_MATCH_SKILLS,
      TRADE_KEYS_BY_FAMILY,
    );
    const required = newVocabularyRequired(gaps);
    const reachable = demandReachableMatchSkills();
    const unreachable = unreachableMatchSkills();

    console.log(`[${SCRIPT}] READ-ONLY, ZERO SPEND.`);
    console.log(`  target = ${hostClass(url)}  role=${who?.who}\n`);

    console.log(`  --- the demand surface is CLOSED ---`);
    console.log(`    TRADE_KEYS                       ${TRADE_KEYS.length}  (a validated union; a job cannot carry anything else)`);
    console.log(`    distinct mskills they reach      ${reachable.size}`);
    console.log(`    MATCH_SKILLS defined             ${MATCH_SKILLS.length}`);
    console.log(`    mskills NO job can ever require  ${unreachable.length}`);
    console.log(`      ${unreachable.join(", ")}`);
    console.log(
      `    -> the vocabulary is WIDER than the demand surface, not narrower.`,
    );

    console.log(`\n  --- every trade family ---`);
    console.log(
      `    ${"family".padEnd(20)} ${"skills".padStart(6)} ${"matched".padStart(7)} ` +
        `${"unmatched".padStart(9)}  ${"trades".padStart(6)}  ${"mskills (attribute side)".padEnd(26)} mskills (demand side)`,
    );
    for (const g of gaps) {
      console.log(
        `    ${g.family.padEnd(20)} ${String(g.promotableSkills).padStart(6)} ` +
          `${String(g.matched).padStart(7)} ${String(g.intentionallyUnmatched).padStart(9)}  ` +
          `${String(g.tradeKeys.length).padStart(6)}  ` +
          `${(g.attributeSideMatchSkills.length > 0 ? g.attributeSideMatchSkills : ["-"]).join(", ").padEnd(26)} ` +
          `${(g.demandSideMatchSkills.length > 0 ? g.demandSideMatchSkills : ["-"]).join(", ")}` +
          (g.tradeKeys.length === 0 ? "   <- no job can be posted here" : ""),
      );
    }

    const noDemand = gaps.filter((g) => g.tradeKeys.length === 0 && g.promotableSkills > 0);
    console.log(
      `\n    families with promotable supply and NO postable demand: ${noDemand.length}, ` +
        `covering ${noDemand.reduce((n, g) => n + g.promotableSkills, 0)} skills`,
    );

    console.log(`\n  --- is new mskill vocabulary REQUIRED? ---`);
    if (required.length === 0) {
      console.log(
        `    NO. Every family that can receive a job posting already reaches an mskill.\n` +
          `    A new concept for any other family would satisfy the Q1 tripwire and be\n` +
          `    consulted by nothing, because no trade_key can require it. The prior decision\n` +
          `    is the TRADE taxonomy (Phase-1 alpha, 15 keys), which is a product question.`,
      );
    } else {
      for (const g of required) {
        console.log(`    ${g.family}: ${g.promotableSkills} skills, trades ${g.tradeKeys.join(", ")}, NO mskill`);
      }
    }

    console.log(`\n  --- live demand, by trade ---`);
    for (const j of jobs) {
      const ms = TRADE_TO_MATCH_SKILL[j.trade_key as keyof typeof TRADE_TO_MATCH_SKILL];
      console.log(
        `    ${j.trade_key.padEnd(24)} ${j.status.padEnd(7)} jobs ${String(j.jobs).padStart(2)}  ` +
          `applications ${String(j.applications).padStart(2)}  -> ${ms ?? "!! UNMAPPED"}`,
      );
    }
    const unmapped = jobs.filter(
      (j) => TRADE_TO_MATCH_SKILL[j.trade_key as keyof typeof TRADE_TO_MATCH_SKILL] === undefined,
    );
    console.log(`    trade keys on live jobs with NO match skill = ${unmapped.length}`);

    console.log(`\n  --- and none of it is connected anyway ---`);
    console.log(`    job_posting_skill rows  ${chain?.job_posting_skill}`);
    console.log(`    worker_skill rows       ${chain?.worker_skill}`);
    console.log(`    job_reach rows          ${chain?.job_reach}`);
    console.log(
      `    A match skill is consulted when a POSTING requires it and a WORKER carries it.\n` +
        `    Both sides are empty, so the gap costs nothing measurable today — and would cost\n` +
        `    something the moment step 4 and step 6 of the relevance chain are connected.`,
    );

    const out = arg("json");
    if (out !== undefined) {
      writeFileSync(
        out,
        `${JSON.stringify(
          {
            kind: "vocabulary-gap",
            ...provenance({
              source: `pnpm db:audit:vocabulary-gap`,
              target: hostClass(url),
              readOnly: true,
              role: who?.who ?? null,
              bypassRls: who?.bypass_rls ?? false,
              populationPredicate:
                `the 96 promotable skills grouped by their Q1 triage family, crossed with ` +
                `ATTRIBUTE_TO_MATCH_SKILLS, TRADE_KEYS (closed union of ${TRADE_KEYS.length}), ` +
                `TRADE_TO_MATCH_SKILL and every row of the live jobs table`,
            }),
            ai_spend_inr: 0,
            trade_key_attribution_is_analytical:
              "TRADE_KEYS_BY_FAMILY is an analytical placement by the audit author, not a " +
              "ratified mapping. It affects which families are reported as having postable " +
              "demand and nothing else; no runtime path reads it.",
            trade_keys: TRADE_KEYS.length,
            match_skills_defined: MATCH_SKILLS.length,
            match_skills_reachable_by_any_job: [...reachable].sort(),
            match_skills_unreachable: unreachable,
            families: gaps,
            families_without_postable_demand: noDemand.map((g) => g.family),
            skills_in_families_without_postable_demand: noDemand.reduce(
              (n, g) => n + g.promotableSkills,
              0,
            ),
            new_vocabulary_required: required.map((g) => g.family),
            live_jobs_by_trade: jobs.map((j) => ({
              ...j,
              match_skill: TRADE_TO_MATCH_SKILL[j.trade_key as keyof typeof TRADE_TO_MATCH_SKILL] ?? null,
            })),
            live_trade_keys_without_match_skill: unmapped.map((j) => j.trade_key),
            relevance_chain: chain ?? null,
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
