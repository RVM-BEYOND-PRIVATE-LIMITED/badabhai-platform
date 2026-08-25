/**
 * One deprecation crosswalk, traced hop by hop, against production. READ-ONLY, zero AI spend.
 *
 * ===========================================================================
 * THE MISTAKE THIS INSTRUMENT EXISTS TO PREVENT
 * ===========================================================================
 * A crosswalk is written `skill -> skill`. A match claim is acquired `skill -> mskill_*`, and
 * ONLY through `ATTRIBUTE_TO_MATCH_SKILLS`. Collapsing the two — reading
 * `skill_chassis_fitting.replaced_by` as though it pointed at `mskill_fitter` — makes the
 * widening invisible, because it hides the hop where the claim is actually created:
 *
 *   skill_chassis_fitting  --replaced_by-->  skill_mechanical_assembly   (taxonomy replacement)
 *   skill_mechanical_assembly  --bridge-->   mskill_fitter               (matching equivalence)
 *
 * **Semantic replacement is not matching equivalence.** The first says two concepts are the
 * same trade knowledge; the second says a worker may be offered a Fitter's vacancy. A
 * crosswalk author decides the first and, without noticing, also decides the second.
 *
 * So this prints every hop separately and refuses to summarise them into one arrow.
 *
 *   pnpm db:audit:crosswalk-chain [--skill=<id>] [--json=<out>]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sql as dsql } from "drizzle-orm";
import { config } from "dotenv";

import { ATTRIBUTE_TO_MATCH_SKILLS, SKILL_CORPUS } from "@badabhai/taxonomy";

import { createDbClient } from "./client";
import { provenance } from "./evidence-provenance";
import { hostClass } from "./ops-guard";

config({ path: "../../.env" });
config();

const SCRIPT = "audit:crosswalk-chain";
const DEFAULT_SKILL = "skill_chassis_fitting";

function arg(n: string): string | undefined {
  return process.argv.find((x) => x.startsWith(`--${n}=`))?.slice(n.length + 3);
}

interface SkillRow {
  skill_id: string;
  status: string;
  replaced_by: string | null;
  kind: string;
  source: string | null;
  domain_id: string | null;
  aliases: string;
  embedded: string;
  edges: string;
}

const ONE = async (
  db: { execute: (q: ReturnType<typeof dsql>) => Promise<unknown> },
  id: string,
): Promise<SkillRow | undefined> => {
  const rows = (await db.execute(dsql`
    SELECT s.skill_id, s.status, s.replaced_by, s.kind, s.source, s.domain_id,
           (SELECT count(*) FROM skill_alias a WHERE a.skill_id = s.skill_id) AS aliases,
           (SELECT count(*) FROM skill_alias a WHERE a.skill_id = s.skill_id AND a.embedding IS NOT NULL) AS embedded,
           (SELECT count(*) FROM job_domain_skill e WHERE e.skill_id = s.skill_id) AS edges
    FROM skill s WHERE s.skill_id = ${id}
  `)) as unknown as SkillRow[];
  return rows[0];
};

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);
  const subjectId = arg("skill") ?? DEFAULT_SKILL;

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

    const subject = await ONE(db, subjectId);
    if (subject === undefined) throw new Error(`[${SCRIPT}] ${subjectId} is not in production`);

    /*
     * Successor resolution, production FIRST and the corpus as a declared fallback.
     *
     * The interesting cases are exactly the drifted ones: the corpus marks a skill deprecated
     * with a successor and production still has it `active` with `replaced_by` NULL. Refusing
     * to analyse those would blind the instrument to D-7A and D-7C, which are entirely made of
     * that shape.
     */
    const corpusSuccessor =
      SKILL_CORPUS.find((c) => c.skillId === subjectId)?.replacedBy ??
      readFileSync(join(__dirname, "..", "data", "taxonomy", "skills.jsonl"), "utf8")
        .split(/\r?\n/)
        .filter((l) => l.trim() !== "" && !l.startsWith("#"))
        .map((l) => JSON.parse(l) as { skill_id: string; replaced_by?: string | null })
        .find((r) => r.skill_id === subjectId)?.replaced_by ??
      null;
    const successorId = subject.replaced_by ?? corpusSuccessor;
    const successorSource: "production" | "corpus" | "none" =
      subject.replaced_by !== null ? "production" : corpusSuccessor !== null ? "corpus" : "none";
    const successor = successorId === null ? undefined : await ONE(db, successorId);

    // HOP 3 is CODE, not data: the bridge is a TypeScript constant, never a table.
    const bridge = ATTRIBUTE_TO_MATCH_SKILLS as Readonly<Record<string, readonly string[]>>;
    const corpusIds = new Set(SKILL_CORPUS.map((s) => s.skillId));
    const subjectMatch = bridge[subjectId] ?? null;
    const successorMatch = successorId === null ? null : (bridge[successorId] ?? null);

    // Stored worker-side references — the population a retag would actually move.
    const [refs] = (await db.execute(dsql`
      SELECT (SELECT count(*) FROM worker_skill w WHERE w.skill_id IN (${subjectId}, ${successorId ?? ""})) AS worker_skill,
             (SELECT count(*) FROM worker_skill) AS worker_skill_total,
             (SELECT count(*) FROM job_reach) AS job_reach_total
    `)) as unknown as Array<{ worker_skill: string; worker_skill_total: string; job_reach_total: string }>;

    // What the retag runner's own predicate returns right now.
    const crosswalk = (await db.execute(dsql`
      SELECT skill_id, replaced_by FROM skill
      WHERE status = 'deprecated' AND replaced_by IS NOT NULL ORDER BY skill_id
    `)) as unknown as Array<{ skill_id: string; replaced_by: string }>;

    const gained = (successorMatch ?? []).filter((m) => !(subjectMatch ?? []).includes(m));
    const widening = gained.length > 0;

    /*
     * HOP 0 — the one that makes the rest urgent.
     *
     * The obvious story is "a retag rewrites a stored id, and THAT confers the claim". It is
     * wrong, and measuring it is what shows why: retrieval never reads `replaced_by`. It
     * filters `s.status='active'`, which EXCLUDES the deprecated subject's own exact-match
     * alias and hands the query to the nearest ACTIVE neighbour — which is the successor,
     * which is bridged.
     *
     * So the guard everyone describes as the protection is the mechanism. Deprecation alone
     * is sufficient; the retag was never necessary. Scored with the subject's own stored
     * alias vectors, so this costs nothing to re-run.
     */
    const reachability: Array<{
      alias: string;
      job_domain_id: string;
      top_skill: string;
      score: number;
      above_floor: boolean;
    }> = [];
    const FLOOR = 0.75;
    const subjectAliases = (await db.execute(dsql`
      SELECT text FROM skill_alias WHERE skill_id = ${subjectId} AND embedding IS NOT NULL
    `)) as unknown as Array<{ text: string }>;

    for (const a of subjectAliases) {
      const rows = (await db.execute(dsql`
        WITH q AS (SELECT embedding FROM skill_alias WHERE skill_id = ${subjectId} AND text = ${a.text}),
        scored AS (
          SELECT jds.job_domain_id, sa.skill_id,
                 1 - (sa.embedding <=> (SELECT embedding FROM q)) AS score,
                 row_number() OVER (PARTITION BY jds.job_domain_id
                                    ORDER BY sa.embedding <=> (SELECT embedding FROM q)) AS rn
          FROM skill_alias sa
          JOIN skill s ON s.skill_id = sa.skill_id
          JOIN job_domain_skill jds ON jds.skill_id = sa.skill_id
          WHERE jds.status = 'active' AND s.status = 'active' AND sa.embedding IS NOT NULL)
        SELECT job_domain_id, skill_id, score FROM scored
        WHERE rn = 1 AND score >= ${FLOOR} ORDER BY score DESC
      `)) as unknown as Array<{ job_domain_id: string; skill_id: string; score: number }>;
      for (const r of rows) {
        reachability.push({
          alias: a.text,
          job_domain_id: r.job_domain_id,
          top_skill: r.skill_id,
          score: Number(r.score.toFixed(4)),
          above_floor: true,
        });
      }
    }
    const liveNow = reachability.filter((r) => r.top_skill === successorId);

    /*
     * If the subject is ACTIVE today, deprecating it is what would trigger the HOP-0 route.
     * Simulate by excluding the subject from the candidate set — the exact effect of the
     * `s.status='active'` filter once the status flips.
     */
    const ifDeprecated: Array<{ alias: string; job_domain_id: string; top_skill: string; score: number }> = [];
    if (subject.status === "active") {
      for (const a of subjectAliases) {
        const rows = (await db.execute(dsql`
          WITH q AS (SELECT embedding FROM skill_alias WHERE skill_id = ${subjectId} AND text = ${a.text}),
          scored AS (
            SELECT jds.job_domain_id, sa.skill_id,
                   1 - (sa.embedding <=> (SELECT embedding FROM q)) AS score,
                   row_number() OVER (PARTITION BY jds.job_domain_id
                                      ORDER BY sa.embedding <=> (SELECT embedding FROM q)) AS rn
            FROM skill_alias sa
            JOIN skill s ON s.skill_id = sa.skill_id
            JOIN job_domain_skill jds ON jds.skill_id = sa.skill_id
            WHERE jds.status = 'active' AND s.status = 'active' AND sa.embedding IS NOT NULL
              AND sa.skill_id <> ${subjectId})
          SELECT job_domain_id, skill_id, score FROM scored
          WHERE rn = 1 AND score >= ${FLOOR} ORDER BY score DESC
        `)) as unknown as Array<{ job_domain_id: string; skill_id: string; score: number }>;
        for (const r of rows) {
          ifDeprecated.push({
            alias: a.text,
            job_domain_id: r.job_domain_id,
            top_skill: r.skill_id,
            score: Number(r.score.toFixed(4)),
          });
        }
      }
    }

    console.log(`[${SCRIPT}] READ-ONLY. No write path, no provider call.`);
    console.log(`  target                 = ${hostClass(url)}`);
    console.log(`  role                   = ${who?.who} (bypassrls=${String(who?.bypass_rls)})`);

    console.log(`\n  === HOP 1 — the subject (taxonomy) ===`);
    console.log(`  ${subject.skill_id}  status=${subject.status}  replaced_by=${subject.replaced_by ?? "NULL"}`);
    console.log(`  kind=${subject.kind}  domain_id=${subject.domain_id ?? "NULL"}  source=${subject.source ?? "NULL"}`);
    console.log(`  aliases=${subject.aliases} (embedded ${subject.embedded})  job_domain_skill edges=${subject.edges}`);
    console.log(`  in SKILL_CORPUS = ${corpusIds.has(subjectId)}   bridge mapping = ${JSON.stringify(subjectMatch)}`);

    console.log(`\n  === HOP 2 — replaced_by (taxonomy replacement, NOT a match claim) ===`);
    if (successor === undefined) {
      console.log(`  no successor — the chain stops here`);
    } else {
      console.log(`  ${successor.skill_id}  status=${successor.status}  replaced_by=${successor.replaced_by ?? "NULL"}`);
      console.log(`  aliases=${successor.aliases} (embedded ${successor.embedded})  edges=${successor.edges}`);
      console.log(`  in SKILL_CORPUS = ${corpusIds.has(successor.skill_id)}`);
    }

    console.log(`\n  === HOP 3 — ATTRIBUTE_TO_MATCH_SKILLS (matching equivalence) ===`);
    console.log(`  THIS HOP IS CODE, NOT DATA. The bridge is a TypeScript constant.`);
    console.log(`  ${subjectId} -> ${JSON.stringify(subjectMatch)}`);
    console.log(`  ${successorId ?? "(none)"} -> ${JSON.stringify(successorMatch)}`);
    console.log(`  claim GAINED by re-tagging = ${JSON.stringify(gained)}`);

    console.log(`\n  === HOP 4 — stored references a retag would move ===`);
    console.log(`  worker_skill rows on either skill = ${refs?.worker_skill ?? "?"}`);
    console.log(`  worker_skill total                = ${refs?.worker_skill_total ?? "?"}`);
    console.log(`  job_reach total                   = ${refs?.job_reach_total ?? "?"}`);

    console.log(`\n  === the retag predicate, as it stands today ===`);
    for (const c of crosswalk) console.log(`     ${c.skill_id.padEnd(34)} -> ${c.replaced_by}`);
    console.log(`  rows the runner would act on = ${crosswalk.length}`);

    console.log(`
  === HOP 0 — is the successor ALREADY reachable from the subject's own language? ===`);
    console.log(`  Retrieval never reads replaced_by. It filters s.status='active', which excludes`);
    console.log(`  the deprecated subject's own exact match and promotes the nearest ACTIVE neighbour.`);
    if (reachability.length === 0) {
      console.log(`  No job domain puts any skill above the floor for the subject's aliases.`);
    } else {
      for (const r of reachability) {
        const flag = r.top_skill === successorId ? "   <- THE SUCCESSOR, ALREADY" : "";
        console.log(`     "${r.alias}" @ ${r.job_domain_id.padEnd(20)} -> ${r.top_skill.padEnd(28)} ${r.score}${flag}`);
      }
    }
    console.log(`  domains where the SUCCESSOR is already assigned = ${liveNow.length}`);
    if (subject.status === "active") {
      console.log(`
  === IF THIS SUBJECT WERE DEPRECATED (simulated, nothing changed) ===`);
      if (ifDeprecated.length === 0) {
        console.log(`  nothing would clear the floor — the phrase would fail closed to UNRESOLVED`);
      } else {
        for (const r of ifDeprecated) {
          const b = bridge[r.top_skill] ?? [];
          const note = b.length > 0 ? `  -> BRIDGED ${JSON.stringify(b)}  *** WIDENING ***` : "  -> bridge [] (no claim)";
          console.log(`     "${r.alias}" @ ${r.job_domain_id.padEnd(20)} -> ${r.top_skill.padEnd(26)} ${r.score}${note}`);
        }
      }
    }
    if (liveNow.length > 0) {
      console.log(
        `
  !! The claim does NOT wait for a retag. Deprecation alone already routes the
` +
          `     subject's own phrase onto the bridged successor, above the floor. Forbidding
` +
          `     db:retag:skills does not contain this.`,
      );
    }

    console.log(
      `\n  WIDENING = ${String(widening).toUpperCase()}` +
        (widening
          ? `\n  Re-tagging would CREATE ${JSON.stringify(gained)} for anyone carrying ${subjectId}.\n` +
            `  Nothing is lost; a posting-level claim is invented. Semantic replacement is not\n` +
            `  matching equivalence, and only a human can say whether this one is intended.`
          : `\n  The successor implies no match skill the subject did not already imply.`),
    );

    const out = arg("json");
    if (out !== undefined) {
      writeFileSync(
        out,
        `${JSON.stringify(
          {
            kind: "crosswalk-chain",
            ...provenance({
              source: `pnpm db:audit:crosswalk-chain --skill=${subjectId}`,
              target: hostClass(url),
              readOnly: true,
              role: who?.who ?? null,
              bypassRls: who?.bypass_rls ?? false,
              populationPredicate: `skill.skill_id = '${subjectId}' and its replaced_by chain`,
            }),
            skill_id: subject.skill_id,
            status: subject.status,
            replaced_by: subject.replaced_by,
            successor_id: successorId,
            successor_source: successorSource,
            if_deprecated_above_floor: ifDeprecated,
            successor_status: successor?.status ?? null,
            successor_in_skill_corpus: successor === undefined ? null : corpusIds.has(successor.skill_id),
            subject_match_skills: subjectMatch,
            successor_match_skills: successorMatch,
            match_skills_gained_by_retag: gained,
            crosswalk_widening: widening,
            successor_already_reachable_domains: liveNow.length,
            reachability_above_floor: reachability,
            subject_aliases: Number(subject.aliases),
            subject_edges: Number(subject.edges),
            successor_aliases: successor === undefined ? null : Number(successor.aliases),
            successor_edges: successor === undefined ? null : Number(successor.edges),
            stored_worker_skill_rows_on_chain: Number(refs?.worker_skill ?? 0),
            worker_skill_total: Number(refs?.worker_skill_total ?? 0),
            job_reach_total: Number(refs?.job_reach_total ?? 0),
            retag_predicate_rows: crosswalk,
            production_mutation_required: true,
            owner_decision_required: widening,
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
