/**
 * Measure a proposed deprecation set through HOP 0 — the retrieval hop — against production.
 * READ-ONLY, zero AI spend.
 *
 * The rule this instrument applies lives in `deprecation-hop0.ts`; read the header there for
 * why a bridge subtraction is not an answer. This file supplies the two things the rule needs
 * and only a database has: where each phrase lands TODAY, and where it would land IF THE
 * DEPRECATIONS WERE SEEDED.
 *
 * ZERO SPEND. The query vector for a phrase is that phrase's OWN stored embedding, so the
 * measurement costs nothing and is maximally favourable to the phrase — cosine 1.0 against
 * itself. A phrase that cannot reach a skill under this input cannot reach it under a
 * re-embedded one either, which makes a miss definitive rather than suggestive.
 *
 * BOTH SCOPES ARE MEASURED, because the shipped retrieval has two and they disagree:
 *   legacy     `skill_alias.domain_id = <slug>`            — the anchor/legacy path
 *   canonical  `job_domain_skill.job_domain_id = <jd_*>`   — the canonical path
 * A skill with zero canonical edges is unreachable on the canonical path entirely, and a
 * skill's nearest neighbour differs per job domain. Measuring one scope and reporting "the"
 * landing hides both.
 *
 * The subjects are excluded TOGETHER, not one at a time: they would be seeded in one run, so
 * a phrase must not be allowed to land on another skill that is also on its way out.
 *
 *   pnpm db:audit:deprecation-hop0 [--skills=a,b,c] [--json=<out>]
 */
import { writeFileSync } from "node:fs";

import { sql as dsql } from "drizzle-orm";
import { config } from "dotenv";

import { ATTRIBUTE_TO_MATCH_SKILLS, SKILL_CORPUS } from "@badabhai/taxonomy";

import { createDbClient } from "./client";
import {
  classifyLanding,
  D7C_NEUTRAL_SUBJECTS,
  D7C_SEED_EXCLUSIONS,
  summarizeHop0,
  type Hop0Input,
  type Hop0Observation,
} from "./deprecation-hop0";
import { provenance } from "./evidence-provenance";
import { hostClass } from "./ops-guard";
import { CANONICALIZATION_FLOOR } from "./promote-skills";

config({ path: "../../.env" });
config();

const SCRIPT = "audit:deprecation-hop0";

/** The D-7C set. `skill_boring` is absent by decision, not by oversight — see D7C_SEED_EXCLUSIONS. */
const DEFAULT_SUBJECTS = D7C_NEUTRAL_SUBJECTS;

function arg(n: string): string | undefined {
  return process.argv.find((x) => x.startsWith(`--${n}=`))?.slice(n.length + 3);
}

const bridge = (id: string | null | undefined): readonly string[] =>
  id === null || id === undefined ? [] : (ATTRIBUTE_TO_MATCH_SKILLS[id] ?? []);

interface LandingRow {
  subj: string;
  phrase: string;
  scope: string;
  hit: string;
  score: string;
}

/**
 * Key the landings so the two sides of the comparison can be joined.
 *
 * The separator is NUL and not a space, because phrases contain spaces ("dimensional
 * inspection") and a space-joined key could in principle collide across fields. Written as the
 * escape rather than the raw byte — a raw 0x00 makes ripgrep classify the file as binary and
 * skip it, so every later grep over this file would silently return nothing.
 */
const index = (rows: readonly LandingRow[]): Map<string, LandingRow> => {
  const m = new Map<string, LandingRow>();
  for (const r of rows) m.set(`${r.subj}\u0000${r.phrase}\u0000${r.scope}`, r);
  return m;
};

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);
  const subjects = (arg("skills") ?? DEFAULT_SUBJECTS.join(",")).split(",").map((s) => s.trim());

  // FAIL CLOSED. A held skill must not be measured as though it were a candidate — the
  // artifact would then read as clearance for seeding it.
  for (const s of subjects) {
    const why = D7C_SEED_EXCLUSIONS[s];
    if (why !== undefined) throw new Error(`[${SCRIPT}] ${s} is excluded from this set.\n  ${why}`);
  }

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

    console.log(`[${SCRIPT}] target=${hostClass(url)} role=${who?.who} bypassrls=${who?.bypass_rls}`);
    console.log(`[${SCRIPT}] READ-ONLY session verified. floor=${CANONICALIZATION_FLOOR}`);
    console.log(`[${SCRIPT}] subjects: ${subjects.join(", ")}\n`);

    const state = (await db.execute(dsql`
      SELECT s.skill_id, s.status, s.replaced_by, s.domain_id,
             (SELECT count(*) FROM skill_alias a WHERE a.skill_id = s.skill_id) AS aliases,
             (SELECT count(*) FROM job_domain_skill e
               WHERE e.skill_id = s.skill_id AND e.status = 'active') AS edges
      FROM skill s WHERE s.skill_id IN ${subjects} ORDER BY s.skill_id
    `)) as unknown as {
      skill_id: string;
      status: string;
      replaced_by: string | null;
      domain_id: string | null;
      aliases: string;
      edges: string;
    }[];

    const today = index(
      (await db.execute(dsql`
        WITH probe AS (
          SELECT a.skill_id AS subj, a.text AS phrase, a.embedding AS vec, a.domain_id AS scope
          FROM skill_alias a WHERE a.skill_id IN ${subjects} AND a.embedding IS NOT NULL
        ), scored AS (
          SELECT p.subj, p.phrase, p.scope, sa.skill_id AS hit,
                 1 - (sa.embedding <=> p.vec) AS score,
                 row_number() OVER (PARTITION BY p.subj, p.phrase ORDER BY sa.embedding <=> p.vec) AS rn
          FROM probe p
          JOIN skill_alias sa ON sa.domain_id = p.scope
          JOIN skill s ON s.skill_id = sa.skill_id
          WHERE s.status = 'active' AND sa.embedding IS NOT NULL
        )
        SELECT subj, phrase, scope, hit, score::text FROM scored WHERE rn = 1
      `)) as unknown as LandingRow[],
    );

    const seeded = index(
      (await db.execute(dsql`
        WITH probe AS (
          SELECT a.skill_id AS subj, a.text AS phrase, a.embedding AS vec, a.domain_id AS scope
          FROM skill_alias a WHERE a.skill_id IN ${subjects} AND a.embedding IS NOT NULL
        ), scored AS (
          SELECT p.subj, p.phrase, p.scope, sa.skill_id AS hit,
                 1 - (sa.embedding <=> p.vec) AS score,
                 row_number() OVER (PARTITION BY p.subj, p.phrase ORDER BY sa.embedding <=> p.vec) AS rn
          FROM probe p
          JOIN skill_alias sa ON sa.domain_id = p.scope
          JOIN skill s ON s.skill_id = sa.skill_id
          WHERE s.status = 'active' AND sa.embedding IS NOT NULL
            AND sa.skill_id NOT IN ${subjects}
        )
        SELECT subj, phrase, scope, hit, score::text FROM scored WHERE rn = 1
      `)) as unknown as LandingRow[],
    );

    const todayC = index(
      (await db.execute(dsql`
        WITH probe AS (
          SELECT a.skill_id AS subj, a.text AS phrase, a.embedding AS vec, e.job_domain_id AS scope
          FROM skill_alias a
          JOIN job_domain_skill e ON e.skill_id = a.skill_id AND e.status = 'active'
          WHERE a.skill_id IN ${subjects} AND a.embedding IS NOT NULL
        ), scored AS (
          SELECT p.subj, p.phrase, p.scope, sa.skill_id AS hit,
                 1 - (sa.embedding <=> p.vec) AS score,
                 row_number() OVER (PARTITION BY p.subj, p.phrase, p.scope
                                    ORDER BY sa.embedding <=> p.vec) AS rn
          FROM probe p
          JOIN job_domain_skill jds ON jds.job_domain_id = p.scope AND jds.status = 'active'
          JOIN skill_alias sa ON sa.skill_id = jds.skill_id
          JOIN skill s ON s.skill_id = sa.skill_id
          WHERE s.status = 'active' AND sa.embedding IS NOT NULL
        )
        SELECT subj, phrase, scope, hit, score::text FROM scored WHERE rn = 1
      `)) as unknown as LandingRow[],
    );

    const seededC = index(
      (await db.execute(dsql`
        WITH probe AS (
          SELECT a.skill_id AS subj, a.text AS phrase, a.embedding AS vec, e.job_domain_id AS scope
          FROM skill_alias a
          JOIN job_domain_skill e ON e.skill_id = a.skill_id AND e.status = 'active'
          WHERE a.skill_id IN ${subjects} AND a.embedding IS NOT NULL
        ), scored AS (
          SELECT p.subj, p.phrase, p.scope, sa.skill_id AS hit,
                 1 - (sa.embedding <=> p.vec) AS score,
                 row_number() OVER (PARTITION BY p.subj, p.phrase, p.scope
                                    ORDER BY sa.embedding <=> p.vec) AS rn
          FROM probe p
          JOIN job_domain_skill jds ON jds.job_domain_id = p.scope AND jds.status = 'active'
          JOIN skill_alias sa ON sa.skill_id = jds.skill_id
          JOIN skill s ON s.skill_id = sa.skill_id
          WHERE s.status = 'active' AND sa.embedding IS NOT NULL
            AND sa.skill_id NOT IN ${subjects}
        )
        SELECT subj, phrase, scope, hit, score::text FROM scored WHERE rn = 1
      `)) as unknown as LandingRow[],
    );

    const build = (
      t: Map<string, LandingRow>,
      s: Map<string, LandingRow>,
      kind: "legacy" | "canonical",
    ): Hop0Observation[] =>
      [...t.entries()].map(([k, r]) => {
        const after = s.get(k);
        return {
          subject: r.subj,
          phrase: r.phrase,
          scope: r.scope,
          scopeKind: kind,
          today: { skillId: r.hit, score: Number(r.score) },
          ifSeeded: after === undefined ? null : { skillId: after.hit, score: Number(after.score) },
        };
      });

    const observations = [
      ...build(today, seeded, "legacy"),
      ...build(todayC, seededC, "canonical"),
    ].sort(
      (a, b) =>
        a.subject.localeCompare(b.subject) ||
        a.scopeKind.localeCompare(b.scopeKind) ||
        a.scope.localeCompare(b.scope) ||
        a.phrase.localeCompare(b.phrase),
    );

    // The successor comes from the CORPUS: production still has these rows active with
    // replaced_by NULL, which is the drift the seed would resolve.
    const successorOf = new Map<string, string | null>(
      subjects.map((s) => [
        s,
        SKILL_CORPUS.find((c) => c.skillId === s)?.replacedBy ?? null,
      ]),
    );

    const inputs: Hop0Input[] = observations.map((o) => ({
      observation: o,
      successorId: successorOf.get(o.subject) ?? null,
      subjectBridge: bridge(o.subject),
      landingBridge: bridge(o.ifSeeded?.skillId),
    }));
    const summary = summarizeHop0(inputs, CANONICALIZATION_FLOOR);

    console.log("--- production state (the drift the seed would resolve) ---");
    for (const r of state) {
      console.log(
        `  ${r.skill_id.padEnd(32)} status=${r.status.padEnd(11)} replaced_by=${
          String(r.replaced_by).padEnd(24)
        } corpus_successor=${successorOf.get(r.skill_id) ?? "-"}  aliases=${r.aliases} edges=${r.edges}`,
      );
    }

    console.log("\n--- HOP 0: where each phrase lands, before and after ---");
    for (const i of inputs) {
      const o = i.observation;
      const v = classifyLanding(o, i.successorId, CANONICALIZATION_FLOOR);
      const after =
        o.ifSeeded === null
          ? "(nothing else in scope)"
          : `${o.ifSeeded.skillId} @ ${o.ifSeeded.score.toFixed(4)}`;
      const flag = v === "LANDS_ELSEWHERE_ABOVE_FLOOR" ? "  <-- MISASSIGNMENT" : "";
      console.log(
        `  [${o.scopeKind[0]}] ${o.scope.padEnd(18)} ${o.phrase.padEnd(40)} ` +
          `${o.today.skillId} -> ${after.padEnd(46)} ${v}${flag}`,
      );
    }

    console.log("\n--- verdict ---");
    console.log(`  observations              = ${summary.total}`);
    console.log(`  MATCH-SET NEUTRAL         = ${summary.matchSetNeutral ? "YES" : "NO"}`);
    console.log(`  match skills gained       = ${summary.gainedMatchSkills.join(", ") || "none"}`);
    console.log(`  misassignments            = ${summary.misassignments.length}`);
    console.log(`  coverage losses           = ${summary.coverageLosses.length}`);
    console.log(`  neutral only via floor    = ${summary.neutralOnlyViaFloor}`);

    const out = arg("json");
    if (out !== undefined) {
      writeFileSync(
        out,
        `${JSON.stringify(
          {
            ...provenance({
              source: `pnpm db:audit:deprecation-hop0 --skills=${subjects.join(",")}`,
              target: hostClass(url),
              readOnly: true,
              role: who?.who ?? null,
              bypassRls: who?.bypass_rls ?? false,
              populationPredicate:
                `every embedded skill_alias row of {${subjects.join(", ")}}, scored in each ` +
                `retrieval scope it is reachable in (legacy skill_alias.domain_id and every ` +
                `canonical job_domain_skill.job_domain_id), with all subjects excluded together`,
            }),
            floor: CANONICALIZATION_FLOOR,
            subjects,
            excluded: D7C_SEED_EXCLUSIONS,
            production_state: state.map((r) => ({
              skill_id: r.skill_id,
              status: r.status,
              replaced_by: r.replaced_by,
              domain_id: r.domain_id,
              aliases: Number(r.aliases),
              active_edges: Number(r.edges),
              corpus_successor: successorOf.get(r.skill_id) ?? null,
            })),
            observations: inputs.map((i) => ({
              ...i.observation,
              successor_id: i.successorId,
              verdict: classifyLanding(i.observation, i.successorId, CANONICALIZATION_FLOOR),
              subject_bridge: i.subjectBridge,
              landing_bridge: i.landingBridge,
            })),
            summary: {
              total: summary.total,
              match_set_neutral: summary.matchSetNeutral,
              gained_match_skills: summary.gainedMatchSkills,
              misassignments: summary.misassignments.length,
              coverage_losses: summary.coverageLosses.length,
              neutral_only_via_floor: summary.neutralOnlyViaFloor,
            },
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
