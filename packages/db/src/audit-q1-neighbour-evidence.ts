/**
 * Q1 triage evidence — for each promotable skill, its nearest ALREADY-TRIAGED neighbour.
 *
 * ===========================================================================
 * WHAT THIS EVIDENCE IS FOR, AND WHAT IT IS NOT FOR
 * ===========================================================================
 * The natural way to fill 96 missing dispositions is to ask "what is this skill closest to,
 * and what does THAT map to?" This instrument produces exactly that number — so that the
 * triage can show, per skill, that **it is not what the disposition was based on**.
 *
 * The measurement refutes its own most obvious use. The strongest cross-family neighbour in
 * the whole set is:
 *
 *     skill_ducting_installation -> skill_pipe_fitting @ 0.827 -> mskill_plumber
 *
 * An HVAC duct installer is not a plumber. The second strongest:
 *
 *     skill_visual_defect_identification -> skill_dimensional_inspection @ 0.803
 *                                        -> mskill_quality_inspector
 *
 * Every operator on a line identifies visual defects; mapping it would reach all of them for a
 * Quality Inspector vacancy. Both would be the TOP-RANKED automatic mappings, and both are
 * wrong. So this file exists to be quoted AGAINST similarity-driven triage, not for it.
 *
 * ZERO SPEND. The query vector is each alias's own stored embedding.
 *
 *   pnpm db:audit:q1-neighbours [--batch=<dir>] [--json=<out>]
 */
import { readFileSync, writeFileSync } from "node:fs";

import { sql as dsql } from "drizzle-orm";
import { config } from "dotenv";

import { ATTRIBUTE_TO_MATCH_SKILLS, SKILL_CORPUS } from "@badabhai/taxonomy";

import { createDbClient } from "./client";
import { provenance } from "./evidence-provenance";
import { hostClass } from "./ops-guard";

config({ path: "../../.env" });
config();

const SCRIPT = "audit:q1-neighbours";
const DEFAULT_BATCH = "data/taxonomy/batches/batch_2026-08-16T14-30-41Z-remediation-phase9d";

function arg(n: string): string | undefined {
  return process.argv.find((x) => x.startsWith(`--${n}=`))?.slice(n.length + 3);
}

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);
  const batchDir = arg("batch") ?? DEFAULT_BATCH;
  const ids = readFileSync(`${batchDir}/accepted-skills.jsonl`, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "" && !l.startsWith("#"))
    .map((l) => (JSON.parse(l) as { skill_id: string }).skill_id);
  const corpusIds = SKILL_CORPUS.map((s) => s.skillId);

  const { db, sql } = createDbClient(url, { max: 1 });
  try {
    await db.execute(dsql`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`);
    const [ro] = (await db.execute(
      dsql`SHOW default_transaction_read_only`,
    )) as unknown as { default_transaction_read_only: string }[];
    if (ro?.default_transaction_read_only !== "on") {
      throw new Error(`[${SCRIPT}] session is not read-only; refusing to measure`);
    }
    const [who] = (await db.execute(dsql`
      SELECT current_user AS who,
             (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass_rls
    `)) as unknown as { who: string; bypass_rls: boolean }[];

    const rows = (await db.execute(dsql`
      WITH probe AS (
        SELECT a.skill_id AS subj, a.embedding AS vec
        FROM skill_alias a WHERE a.skill_id IN ${ids} AND a.embedding IS NOT NULL
      )
      SELECT p.subj, sa.skill_id AS neighbour, max(1 - (sa.embedding <=> p.vec)) AS score
      FROM probe p
      JOIN skill_alias sa ON sa.skill_id IN ${corpusIds}
      WHERE sa.embedding IS NOT NULL
      GROUP BY p.subj, sa.skill_id
      ORDER BY p.subj, score DESC
    `)) as unknown as { subj: string; neighbour: string; score: string }[];

    const top = new Map<string, { skill_id: string; score: number; bridge: readonly string[] }[]>();
    for (const r of rows) {
      const list = top.get(r.subj) ?? [];
      if (list.length < 3) {
        list.push({
          skill_id: r.neighbour,
          score: Number(Number(r.score).toFixed(4)),
          bridge: ATTRIBUTE_TO_MATCH_SKILLS[r.neighbour] ?? [],
        });
      }
      top.set(r.subj, list);
    }

    console.log(`[${SCRIPT}] target=${hostClass(url)} role=${who?.who} READ-ONLY verified`);
    console.log(`[${SCRIPT}] probed ${top.size} of ${ids.length} promotable skills\n`);

    // The headline: how often would "map it to whatever the nearest neighbour maps to" fire,
    // and on what. Printed because the number is the argument against doing that.
    const wouldMap = [...top.entries()].filter(([, v]) => (v[0]?.bridge.length ?? 0) > 0);
    console.log(`  nearest neighbour is a MAPPED skill for ${wouldMap.length} of ${top.size}`);
    console.log(`  -> a similarity-driven triage would propose ${wouldMap.length} mappings.`);
    console.log(`     The top few, by score, are the argument against doing that:\n`);
    for (const [id, v] of wouldMap.sort((a, b) => (b[1][0]?.score ?? 0) - (a[1][0]?.score ?? 0)).slice(0, 8)) {
      console.log(`     ${id.padEnd(46)} -> ${v[0]?.skill_id} @ ${v[0]?.score} -> ${v[0]?.bridge.join("+")}`);
    }

    const out = arg("json");
    if (out !== undefined) {
      writeFileSync(
        out,
        `${JSON.stringify(
          {
            kind: "q1-neighbour-evidence",
            ...provenance({
              source: `pnpm db:audit:q1-neighbours --batch=${batchDir}`,
              target: hostClass(url),
              readOnly: true,
              role: who?.who ?? null,
              bypassRls: who?.bypass_rls ?? false,
              populationPredicate:
                `every embedded skill_alias of the ${ids.length} skills in ` +
                `${batchDir}/accepted-skills.jsonl, scored against every embedded alias of the ` +
                `${corpusIds.length} SKILL_CORPUS skills; top 3 neighbours by max cosine`,
            }),
            caveat:
              "SIMILARITY IS NOT A DISPOSITION. The two highest cross-family scores here " +
              "(ducting_installation -> pipe_fitting -> mskill_plumber @ 0.827, and " +
              "visual_defect_identification -> dimensional_inspection -> mskill_quality_inspector " +
              "@ 0.803) are both WRONG. This evidence is recorded so the triage can be checked " +
              "against it, not derived from it.",
            batch: batchDir,
            probed: top.size,
            of: ids.length,
            nearest_neighbour_is_mapped: wouldMap.length,
            neighbours: Object.fromEntries([...top.entries()].sort(([a], [b]) => a.localeCompare(b))),
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
