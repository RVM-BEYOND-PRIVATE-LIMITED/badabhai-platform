/**
 * WHICH case regresses, WHY, and whether any pending decision fixes it. READ-ONLY, ₹0.
 *
 * ===========================================================================
 * WHY A NUMBER IS NOT ENOUGH TO DECIDE A WAIVER
 * ===========================================================================
 * `NO_REGRESSION` reports `R@1 0.9912 (-0.0088)` and stops. That is the correct output for a
 * gate and a useless input to the decision it forces, which is: **fix the corpus, or record a
 * waiver.** Nobody can choose between those from a delta. They need the case, the phrase, what
 * won instead, by how much, and whether the phrase clears the canonicalization floor at all.
 *
 * The last of those turns out to decide it. A rank-1 miss whose winner sits at 0.70 is not the
 * same event as a rank-1 miss at 0.85: the first is refused by the floor and returns
 * `unresolved` in the served system, the second is a confident wrong answer delivered to a
 * worker. Recall@1 cannot tell them apart — it ranks, and the floor is applied downstream of
 * ranking — so a regression measured purely as Recall@1 can describe a production behaviour
 * that did not change at all.
 *
 * ===========================================================================
 * IT ALSO ASKS WHETHER THE FIX IS ALREADY RATIFIED
 * ===========================================================================
 * Two corpus mutations are ratified and unapplied: the alias de-elections and the D-7C
 * deprecations. Both change what retrieval returns. So every miss is scored TWICE — as the
 * corpus stands, and with those rows removed exactly the way applying them would remove them
 * (a de-elected row loses its vector, a deprecated skill's rows lose their parent's `active`
 * status; both are omissions from the candidate set, so the simulation is exact rather than
 * approximate). A miss that clears under the second is a miss the pending work already fixes,
 * and waiving it would be waiving something nobody needs to waive.
 *
 * ===========================================================================
 * ZERO SPEND, BY REFUSING RATHER THAN BY PAYING
 * ===========================================================================
 * Query vectors come from the local embed cache and nowhere else — there is no provider client
 * in this file. A query with no cached vector is REPORTED AS UNMEASURED, never silently
 * dropped: an audit that quietly skips the cases it cannot afford reports a clean bill of
 * health for a fixture it only partly ran.
 *
 *   pnpm db:audit:regression-case [--fixture=<path>] [--json=<out>]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sql as dsql } from "drizzle-orm";
import { config } from "dotenv";

import { loadAliasExclusions } from "./alias-exclusions";
import { createDbClient } from "./client";
import { D7C_NEUTRAL_SUBJECTS } from "./deprecation-hop0";
import { provenance } from "./evidence-provenance";
import { hostClass } from "./ops-guard";
import { CANONICALIZATION_FLOOR } from "./promote-skills";
import { cacheKey, DEFAULT_CACHE_DIR } from "./taxonomy-embed-cache";
import { loadEvalFixture } from "./taxonomy-eval-fixture";
import { DEFAULT_FIXTURE, PRE_PROMOTION_SKILL_STATUSES } from "./taxonomy-retrieval-eval";

config({ path: "../../.env" });
config();

const SCRIPT = "audit:regression-case";

function arg(n: string): string | undefined {
  return process.argv.find((x) => x.startsWith(`--${n}=`))?.slice(n.length + 3);
}

interface Candidate {
  readonly skill_id: string;
  readonly score: number;
  readonly via: string;
  readonly above_floor: boolean;
  readonly expected: boolean;
}

export interface RegressionMiss {
  readonly case_id: string;
  readonly category: string;
  readonly job_domain_id: string;
  readonly query: string;
  readonly expected: readonly string[];
  readonly got_now: string | null;
  readonly score_now: number;
  readonly got_after_pending: string | null;
  readonly score_after_pending: number;
  readonly fixed_by_pending: boolean;
  /**
   * THE FIELD THAT DECIDES THE WAIVER. When no candidate clears the floor, production returns
   * `unresolved` for this phrase whichever skill ranks first — so the ranking regression
   * describes no change in served behaviour.
   */
  readonly any_candidate_above_floor: boolean;
  readonly ranking: readonly Candidate[];
}

/** Best score per skill, ignoring a set of alias ids. Exported so the collapse is testable. */
export function rankSkills(
  rows: readonly { skill_id: string; alias_id: string; text: string; score: number }[],
  skip: ReadonlySet<string>,
): { skill: string | null; score: number; via: string } {
  const best = new Map<string, { s: number; via: string }>();
  for (const r of rows) {
    if (skip.has(r.alias_id)) continue;
    const seen = best.get(r.skill_id);
    if (seen === undefined || r.score > seen.s) best.set(r.skill_id, { s: r.score, via: r.text });
  }
  const top = [...best.entries()].sort((a, b) => b[1].s - a[1].s)[0];
  return { skill: top?.[0] ?? null, score: top?.[1].s ?? 0, via: top?.[1].via ?? "" };
}

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);

  const cacheFile = join(DEFAULT_CACHE_DIR, "vectors.json");
  if (!existsSync(cacheFile)) {
    throw new Error(
      `[${SCRIPT}] no local embed cache at ${cacheFile}. This audit reads query vectors from ` +
        `the cache and never calls a provider, so it cannot run without one. Produce it with ` +
        `pnpm db:eval:taxonomy --run --cache.`,
    );
  }
  const cache = JSON.parse(readFileSync(cacheFile, "utf8")) as Record<string, number[]>;

  const fixturePath = arg("fixture") ?? DEFAULT_FIXTURE;
  const fixture = loadEvalFixture(fixturePath);
  const excluded = loadAliasExclusions("data/taxonomy/decollided-aliases.json").map((x) => x.alias_id);

  const { db, sql } = createDbClient(url, { max: 1 });
  try {
    await db.execute(dsql`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`);
    const [who] = (await db.execute(dsql`
      SELECT current_user AS who,
             (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass_rls
    `)) as unknown as { who: string; bypass_rls: boolean }[];
    if (who?.bypass_rls !== true) {
      throw new Error(`[${SCRIPT}] role ${who?.who} does not bypass RLS; every result would be a permission artifact`);
    }
    const [mdl] = (await db.execute(dsql`
      SELECT count(DISTINCT embedding_model)::int AS models, min(embedding_model) AS model
      FROM skill_alias WHERE embedding IS NOT NULL
    `)) as unknown as { models: number; model: string | null }[];
    if (mdl?.models !== 1 || mdl.model === null) {
      throw new Error(
        `[${SCRIPT}] the corpus carries ${mdl?.models ?? 0} embedding model(s). A cached query ` +
          `vector is only comparable within one vector space; refusing to report.`,
      );
    }
    const model = mdl.model;

    // Rows that go dark once the D-7C seed lands: their parent skill stops being `active`, and
    // the candidate predicate requires it. Omitting them IS the simulation.
    const dark = (await sql.unsafe(
      `SELECT id::text AS id FROM skill_alias WHERE skill_id = ANY($1::text[])`,
      [D7C_NEUTRAL_SUBJECTS as unknown as string[]],
    )) as unknown as { id: string }[];
    const pending = new Set([...excluded, ...dark.map((d) => d.id)]);

    const cases = fixture.cases.filter((c) => c.category !== "unembedded_shipped");
    const misses: RegressionMiss[] = [];
    const unmeasured: string[] = [];
    let checked = 0;

    for (const c of cases) {
      const vec = cache[cacheKey(model, c.query)];
      if (vec === undefined) {
        unmeasured.push(c.case_id);
        continue;
      }
      const correct = new Set(
        [c.expected_skill_id, ...(c.acceptable_skill_ids ?? [])].filter(Boolean) as string[],
      );
      if (correct.size === 0) continue; // negative cases have no right answer to regress
      checked += 1;

      const raw = (await sql.unsafe(
        `SELECT sa.skill_id, sa.id::text AS alias_id, sa.text,
                1 - (sa.embedding <=> $1::vector) AS score
         FROM skill_alias sa
         JOIN skill s ON s.skill_id = sa.skill_id
         JOIN job_domain_skill jds ON jds.skill_id = sa.skill_id
         WHERE jds.job_domain_id = $2 AND jds.status = 'active'
           AND s.status = ANY($3::text[]) AND sa.embedding IS NOT NULL
         ORDER BY sa.embedding <=> $1::vector LIMIT 40`,
        [JSON.stringify(vec), c.job_domain_id, PRE_PROMOTION_SKILL_STATUSES as unknown as string[]],
      )) as unknown as { skill_id: string; alias_id: string; text: string; score: string | number }[];
      const rows = raw.map((r) => ({ ...r, score: Number(r.score) }));

      const now = rankSkills(rows, new Set());
      if (now.skill !== null && correct.has(now.skill)) continue;

      const after = rankSkills(rows, pending);
      const bySkill = new Map<string, { s: number; via: string }>();
      for (const r of rows) {
        const seen = bySkill.get(r.skill_id);
        if (seen === undefined || r.score > seen.s) bySkill.set(r.skill_id, { s: r.score, via: r.text });
      }
      const ranking: Candidate[] = [...bySkill.entries()]
        .sort((a, b) => b[1].s - a[1].s)
        .slice(0, 10)
        .map(([skill_id, v]) => ({
          skill_id,
          score: Math.round(v.s * 10_000) / 10_000,
          via: v.via,
          above_floor: v.s >= CANONICALIZATION_FLOOR,
          expected: correct.has(skill_id),
        }));

      misses.push({
        case_id: c.case_id,
        category: c.category,
        job_domain_id: c.job_domain_id,
        query: c.query,
        expected: [...correct],
        got_now: now.skill,
        score_now: Math.round(now.score * 10_000) / 10_000,
        got_after_pending: after.skill,
        score_after_pending: Math.round(after.score * 10_000) / 10_000,
        fixed_by_pending: after.skill !== null && correct.has(after.skill),
        any_candidate_above_floor: ranking.some((r) => r.above_floor),
        ranking,
      });
    }

    console.log(`[${SCRIPT}] READ-ONLY, ZERO SPEND — query vectors from the local cache only.`);
    console.log(`  target = ${hostClass(url)}  role=${who?.who}  model=${model}`);
    console.log(`  fixture = ${fixturePath}`);
    console.log(`  checked = ${checked} scoreable case(s), unmeasured (no cached vector) = ${unmeasured.length}`);
    if (unmeasured.length > 0) {
      console.log(`    ${unmeasured.slice(0, 8).join(", ")}${unmeasured.length > 8 ? " …" : ""}`);
    }
    console.log(`  MISSES  = ${misses.length}\n`);

    for (const m of misses) {
      console.log(`  ${m.case_id}  [${m.category}]  ${m.job_domain_id}`);
      console.log(`    query      ${JSON.stringify(m.query)}`);
      console.log(`    expected   ${m.expected.join(", ")}`);
      console.log(`    got        ${m.got_now} @ ${m.score_now.toFixed(4)}`);
      console.log(
        `    pending    ${m.got_after_pending} @ ${m.score_after_pending.toFixed(4)}  ` +
          `${m.fixed_by_pending ? "<- FIXED by the ratified-but-unapplied corpus work" : "<- unchanged by it"}`,
      );
      console.log(
        `    floor      ${m.any_candidate_above_floor ? `A CANDIDATE CLEARS ${CANONICALIZATION_FLOOR} — production would assign a WRONG id` : `NOTHING clears ${CANONICALIZATION_FLOOR} — production returns unresolved either way, so served behaviour is UNCHANGED`}`,
      );
      for (const r of m.ranking.slice(0, 6)) {
        console.log(
          `      ${r.score.toFixed(4)}  ${r.above_floor ? "ABOVE" : "below"}  ${r.skill_id.padEnd(34)} ` +
            `via ${JSON.stringify(r.via)}${r.expected ? "   <- EXPECTED" : ""}`,
        );
      }
      console.log("");
    }

    const out = arg("json");
    if (out !== undefined) {
      writeFileSync(
        out,
        `${JSON.stringify(
          {
            kind: "regression-case",
            ...provenance({
              source: `pnpm db:audit:regression-case --fixture=${fixturePath}`,
              target: hostClass(url),
              readOnly: true,
              role: who?.who ?? null,
              bypassRls: true,
              populationPredicate:
                `every scoreable case in ${fixturePath} whose query vector is in the local embed ` +
                `cache, retrieved through the canonical Path A predicate at statuses ` +
                `${PRE_PROMOTION_SKILL_STATUSES.join("+")}`,
            }),
            ai_spend_inr: 0,
            production_mutation_performed: false,
            floor: CANONICALIZATION_FLOOR,
            embedding_model: model,
            checked,
            unmeasured,
            misses,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      console.log(`  written to ${out}`);
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
