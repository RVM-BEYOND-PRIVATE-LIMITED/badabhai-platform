/**
 * PROMOTION GATE AUDIT — what `db:promote:skills` WOULD say, without being able to say it.
 *
 * ===========================================================================
 * WHY THIS EXISTS SEPARATELY FROM THE RUNNER
 * ===========================================================================
 * The runner's plan mode already answers this. But its plan mode also refuses to start until
 * `--sweep` and `--eval` evidence exists, which means the one question an operator most wants
 * answered BEFORE commissioning those runs — "if I go and produce that evidence, will anything
 * actually promote?" — is the question the runner cannot answer.
 *
 * That ordering costs real money and real time: producing a floor sweep and an evaluation are
 * provider-calling experiment runs. Discovering afterwards that 90 of 98 candidates were going
 * to fail `EVAL_COVERED` anyway is an expensive way to learn it.
 *
 * ===========================================================================
 * IT DOES NOT RE-IMPLEMENT THE POLICY
 * ===========================================================================
 * It calls the runner's own exported `judge()` with the runner's own `CandidateFacts`, built
 * from the same reads. The two cannot drift, because there is only one copy of the rules. What
 * this file adds is the OPTIMISTIC posture: the two evidence-backed gates are reported as
 * "pending evidence" rather than blocking, so the remaining five are visible underneath them.
 *
 * READ-ONLY. No write path, no provider call, no `--apply`. It cannot promote anything.
 *
 *   pnpm db:audit:promotion-gates --batch <dir> [--json=<out>]
 */
import { existsSync, writeFileSync } from "node:fs";

import { sql as dsql } from "drizzle-orm";
import { config } from "dotenv";

import { createDbClient } from "./client";
import { hostClass } from "./ops-guard";
import { loadEvalFixture } from "./taxonomy-eval-fixture";
import {
  CRITERIA,
  evalCoverage,
  judge,
  type CandidateFacts,
  type Criterion,
  type Verdict,
} from "./promote-skills";

config({ path: "../../.env" });
config();

const SCRIPT = "audit:promotion-gates";

/** `IN (…)`: interpolating a JS array into a drizzle sql tag renders a tuple, not an array. */
const inList = (xs: readonly string[]) =>
  dsql`(${dsql.join(xs.map((x) => dsql`${x}`), dsql`, `)})`;
const DEFAULT_FIXTURE = "data/taxonomy/eval/retrieval-v2.jsonl";

/** The two gates that need an artifact this audit deliberately does not produce. */
const EVIDENCE_GATES: readonly Criterion[] = ["RESOLVABLE_ABOVE_FLOOR", "NO_REGRESSION"];

interface Row {
  skill_id: string;
  status: string;
  active_edges: number;
  aliases: number;
  unembedded_aliases: number;
  embedding_models: string[];
  reachable_aliases: number;
}

function arg(n: string): string | undefined {
  return process.argv.find((x) => x.startsWith(`--${n}=`))?.slice(n.length + 3);
}

async function main(): Promise<void> {
  const batchIdx = process.argv.indexOf("--batch");
  const batchDir = batchIdx >= 0 ? process.argv[batchIdx + 1] : undefined;
  if (batchDir === undefined) throw new Error(`[${SCRIPT}] --batch <dir> is required`);
  const acceptedPath = `${batchDir}/accepted-skills.jsonl`;
  if (!existsSync(acceptedPath)) {
    throw new Error(`[${SCRIPT}] ${acceptedPath} not found — a BLOCKED batch has no accepted set`);
  }
  const accepted = new Set(
    (await import("node:fs")).readFileSync(acceptedPath, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => (JSON.parse(l) as { skill_id: string }).skill_id),
  );

  const fixture = loadEvalFixture(arg("fixture") ?? DEFAULT_FIXTURE);
  const { covered } = evalCoverage(fixture);

  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);
  const { db, sql } = createDbClient(url, { max: 1 });
  try {
    const rows = (await db.execute(dsql`
      SELECT s.skill_id, s.status,
             (SELECT count(*)::int FROM job_domain_skill j
               WHERE j.skill_id = s.skill_id AND j.status = 'active') AS active_edges,
             (SELECT count(*)::int FROM skill_alias a WHERE a.skill_id = s.skill_id) AS aliases,
             (SELECT count(*)::int FROM skill_alias a
               WHERE a.skill_id = s.skill_id AND a.embedding IS NULL) AS unembedded_aliases,
             coalesce((SELECT array_agg(DISTINCT a.embedding_model) FROM skill_alias a
               WHERE a.skill_id = s.skill_id AND a.embedding_model IS NOT NULL), '{}') AS embedding_models,
             (SELECT count(*)::int FROM skill_alias a
               WHERE a.skill_id = s.skill_id AND a.embedding IS NOT NULL) AS reachable_aliases
      FROM skill s
      WHERE s.skill_id IN ${inList([...accepted])}
      ORDER BY s.skill_id`)) as unknown as Row[];

    // Optimistic on the two evidence gates ONLY. Everything else is judged for real.
    const waived = new Set<Criterion>(EVIDENCE_GATES);
    const verdicts: Verdict[] = rows.map((r) =>
      judge(
        {
          skill_id: r.skill_id,
          status: r.status,
          in_accepted_batch: accepted.has(r.skill_id),
          active_edges: r.active_edges,
          aliases: r.aliases,
          unembedded_aliases: r.unembedded_aliases,
          embedding_models: r.embedding_models,
          eval_covered: covered.has(r.skill_id),
          best_correct_score: null,
          no_regression: true,
          regression_detail: "not evaluated by this audit — evidence gate",
          evidence_stale: false,
          reachable_aliases: r.reachable_aliases,
        } satisfies CandidateFacts,
        waived,
      ),
    );

    const missing = [...accepted].filter((id) => !rows.some((r) => r.skill_id === id));

    console.log(`[${SCRIPT}] READ-ONLY. Cannot promote. Two evidence gates reported as PENDING.`);
    console.log(`  target                   = ${hostClass(url)}`);
    console.log(`  batch                    = ${batchDir}`);
    console.log(`  accepted in batch        = ${accepted.size}`);
    console.log(`  found in database        = ${rows.length}${missing.length > 0 ? `  (MISSING ${missing.length}: ${missing.slice(0, 5).join(", ")})` : ""}`);

    const perGate = new Map<Criterion, { pass: number; fail: number }>();
    for (const c of CRITERIA) perGate.set(c, { pass: 0, fail: 0 });
    for (const v of verdicts) {
      for (const c of v.criteria) {
        const g = perGate.get(c.criterion);
        if (g === undefined) continue;
        if (c.passed) g.pass += 1;
        else g.fail += 1;
      }
    }

    console.log(`\n  === every gate, over ${rows.length} candidate(s) ===`);
    for (const c of CRITERIA) {
      const g = perGate.get(c);
      if (g === undefined) continue;
      const pend = EVIDENCE_GATES.includes(c) ? "   <- PENDING EVIDENCE (not judged here)" : "";
      console.log(`  ${c.padEnd(24)} pass=${String(g.pass).padStart(4)}  fail=${String(g.fail).padStart(4)}${pend}`);
    }

    const eligible = verdicts.filter((v) => v.eligible);
    console.log(`\n  eligible IF the two evidence gates pass = ${eligible.length} of ${rows.length}`);

    const hist = new Map<string, number>();
    for (const v of verdicts) {
      for (const b of v.blocking) hist.set(b, (hist.get(b) ?? 0) + 1);
    }
    if (hist.size > 0) {
      console.log(`\n  === what is actually blocking, counted ===`);
      for (const [k, n] of [...hist.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${k.padEnd(24)} blocks ${n} skill(s)`);
      }
    }

    const sample = verdicts.filter((v) => !v.eligible).slice(0, 12);
    if (sample.length > 0) {
      console.log(`\n  === sample of held-back skills ===`);
      for (const v of sample) {
        console.log(`  ${v.skill_id.padEnd(38)} blocked by ${v.blocking.join(", ")}`);
      }
    }

    const out = arg("json");
    if (out !== undefined) {
      writeFileSync(out, `${JSON.stringify({ batch: batchDir, candidates: rows.length, verdicts }, null, 2)}\n`, "utf8");
      console.log(`\n  written to ${out}`);
    }

    console.log(
      `\n  NOTE: this audit does not produce the floor sweep or the evaluation. It answers\n` +
        `  "is it worth commissioning them", which the runner cannot answer because it\n` +
        `  refuses to start without them.`,
    );
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
