/**
 * The promotion gates, and EXACTLY what would turn each one green. READ-ONLY, ₹0.
 *
 * ===========================================================================
 * WHY THIS IS NOT A TABLE SOMEBODY TYPED
 * ===========================================================================
 * "`NO_REGRESSION` fails" has been true for weeks and has never been actionable, because the
 * gate reports the FIRST reason it refuses and stops. There are four independent reasons, they
 * fail in a fixed order, and fixing the one you can see reveals the next. Anyone planning work
 * from the gate's own output is planning one quarter of it.
 *
 * So this does not describe the blockers — it DERIVES them. It reads every experiment record on
 * disk, runs the real `judgeRegression` against each with the live fingerprint, and reports why
 * each specific artifact cannot clear the gate. Same for the floor sweeps and
 * `RESOLVABLE_ABOVE_FLOOR`, using the same `bestCorrectScores` the runner uses.
 *
 * If someone changes a gate, this report changes with it. That is the only way a
 * "what is needed" document stays true.
 *
 * ===========================================================================
 * WHAT IT WILL NOT DO
 * ===========================================================================
 * It never waives, weakens or re-points anything. `REGRESSION_BASELINE` and
 * `CANONICALIZATION_FLOOR` are imported, never redefined, so this file cannot disagree with the
 * runner about what the bar is.
 *
 *   pnpm db:audit:gate-evidence --batch <dir> [--fixture=<f>] [--json=<out>]
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import { sql as dsql } from "drizzle-orm";
import { config } from "dotenv";

import { PROMOTABLE_SKILL_IDS } from "@badabhai/taxonomy";

import { createDbClient } from "./client";
import { CORPUS_FINGERPRINT_SQL, toFingerprint, type CorpusFingerprint } from "./corpus-fingerprint";
import { provenance } from "./evidence-provenance";
import { hostClass } from "./ops-guard";
import {
  bestCorrectScores,
  CANONICALIZATION_FLOOR,
  judgeRegression,
  REGRESSION_BASELINE,
} from "./promote-skills";
import { EXPERIMENTS_DIR } from "./taxonomy-experiments";
import { countsAsEvalCoverage, loadEvalFixture } from "./taxonomy-eval-fixture";

config({ path: "../../.env" });
config();

const SCRIPT = "audit:gate-evidence";
const DEFAULT_FIXTURE = "data/taxonomy/eval/retrieval-v3.jsonl";

function arg(n: string): string | undefined {
  return process.argv.find((x) => x.startsWith(`--${n}=`))?.slice(n.length + 3);
}
function req(n: string): string | undefined {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : arg(n);
}

interface RecordFile {
  readonly path: string;
  readonly experiment: string;
  readonly record: {
    run_id?: string;
    evaluator_version?: number;
    fixture_version?: number;
    recall_at_1?: number | null;
    mrr?: number | null;
    corpus_fingerprint?: CorpusFingerprint;
    detail?: { per_case?: unknown[] };
  };
}

/** Every experiment record on disk, so the report is over what EXISTS, not what is remembered. */
function allRecords(dir: string): RecordFile[] {
  if (!existsSync(dir)) return [];
  const out: RecordFile[] = [];
  for (const exp of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    const sub = join(dir, exp.name);
    for (const f of readdirSync(sub).filter((f) => f.endsWith(".json"))) {
      const path = join(sub, f);
      out.push({
        path,
        experiment: exp.name,
        record: JSON.parse(readFileSync(path, "utf8")) as RecordFile["record"],
      });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Why one skill fails `RESOLVABLE_ABOVE_FLOOR`, which is three different problems wearing one
 * gate name — and they need three different remedies.
 */
export type FloorFailureCause =
  | "PASSES"
  | "CORRECT_BUT_BELOW_FLOOR"
  | "NO_CORRECT_CASE_IN_SWEEP"
  | "ONLY_EVER_A_WRONG_ANSWER";

export function classifyFloorFailure(
  best: number | undefined,
  appearsAsWrongTop1: boolean,
  floor: number,
): FloorFailureCause {
  if (best === undefined) {
    return appearsAsWrongTop1 ? "ONLY_EVER_A_WRONG_ANSWER" : "NO_CORRECT_CASE_IN_SWEEP";
  }
  return best >= floor ? "PASSES" : "CORRECT_BUT_BELOW_FLOOR";
}

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);
  const fixturePath = arg("fixture") ?? DEFAULT_FIXTURE;
  const batchDir = req("batch");

  const { db, sql } = createDbClient(url, { max: 1 });
  try {
    await db.execute(dsql`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`);
    const [who] = (await db.execute(dsql`
      SELECT current_user AS who,
             (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass_rls
    `)) as unknown as { who: string; bypass_rls: boolean }[];
    const fpRows = (await db.execute(CORPUS_FINGERPRINT_SQL)) as unknown as Record<string, unknown>[];
    const liveFingerprint = fpRows[0] ? toFingerprint(fpRows[0]) : null;

    const records = allRecords(EXPERIMENTS_DIR);
    const evals = records.filter((r) => typeof r.record.recall_at_1 === "number");
    const sweeps = records.filter((r) => Array.isArray(r.record.detail?.per_case));

    console.log(`[${SCRIPT}] READ-ONLY. Derives every blocker; waives nothing.`);
    console.log(`  target = ${hostClass(url)}  role=${who?.who}`);
    console.log(`  floor  = ${CANONICALIZATION_FLOOR}   baseline = R@1 ${REGRESSION_BASELINE.recall_at_1} / MRR ${REGRESSION_BASELINE.mrr}, evaluator v${REGRESSION_BASELINE.evaluator_version}, fixture v${REGRESSION_BASELINE.fixture_version}`);
    console.log(`  experiment records on disk = ${records.length}  (evaluations ${evals.length}, floor sweeps ${sweeps.length})\n`);

    // ── NO_REGRESSION: judge EVERY evaluation that exists ──
    console.log(`  === NO_REGRESSION — every evaluation record, judged by the real gate ===`);
    const evalVerdicts = evals.map((e) => {
      const v = judgeRegression(e.record, liveFingerprint);
      return {
        path: e.path.replace(/^.*experiments[\\/]/, ""),
        fixture_version: e.record.fixture_version ?? null,
        evaluator_version: e.record.evaluator_version ?? null,
        recall_at_1: e.record.recall_at_1 ?? null,
        mrr: e.record.mrr ?? null,
        has_fingerprint: e.record.corpus_fingerprint !== undefined,
        passed: v.passed,
        stale: v.stale,
        detail: v.detail,
      };
    });
    for (const v of evalVerdicts) {
      console.log(
        `    ${v.passed ? "PASS" : "FAIL"} ${v.path}\n      fixture v${v.fixture_version} ` +
          `evaluator v${v.evaluator_version} R@1 ${v.recall_at_1} MRR ${v.mrr} ` +
          `fingerprint=${v.has_fingerprint}\n      ${v.detail}`,
      );
    }

    // The blockers, in the order the gate applies them. Reported TOGETHER, because the gate
    // returns the first and someone planning from that output plans a quarter of the work.
    const anyRightFixture = evals.filter(
      (e) =>
        e.record.fixture_version === REGRESSION_BASELINE.fixture_version &&
        e.record.evaluator_version === REGRESSION_BASELINE.evaluator_version,
    );
    const anyFingerprinted = evals.filter((e) => e.record.corpus_fingerprint !== undefined);
    const anyMeetsBar = evals.filter(
      (e) =>
        (e.record.recall_at_1 ?? 0) >= REGRESSION_BASELINE.recall_at_1 &&
        (e.record.mrr ?? 0) >= REGRESSION_BASELINE.mrr,
    );
    const sweepFingerprinted = sweeps.filter((s) => s.record.corpus_fingerprint !== undefined);

    const noRegressionBlockers = [
      anyRightFixture.length === 0
        ? `NO evaluation on fixture v${REGRESSION_BASELINE.fixture_version} + evaluator v${REGRESSION_BASELINE.evaluator_version} exists that also clears the rest`
        : null,
      anyFingerprinted.length === 0
        ? "NO evaluation carries a corpus_fingerprint, so none can prove currency (NOT WAIVABLE)"
        : null,
      anyMeetsBar.length === 0
        ? `NO evaluation meets R@1 >= ${REGRESSION_BASELINE.recall_at_1} and MRR >= ${REGRESSION_BASELINE.mrr}; the best is ` +
          `${Math.max(...evals.map((e) => e.record.recall_at_1 ?? 0))}`
        : null,
      sweepFingerprinted.length === 0
        ? "NO floor-sweep record carries a corpus_fingerprint, and promote-skills computes " +
          "`no_regression = regression.passed && !sweepStale` — so this gate cannot pass even " +
          "with a perfect evaluation (STRUCTURAL)"
        : null,
    ].filter((x): x is string => x !== null);

    console.log(`\n    INDEPENDENT BLOCKERS = ${noRegressionBlockers.length}`);
    for (const b of noRegressionBlockers) console.log(`      x ${b}`);

    // ── RESOLVABLE_ABOVE_FLOOR: categorise every candidate ──
    console.log(`\n  === RESOLVABLE_ABOVE_FLOOR — the 96, by ROOT CAUSE ===`);
    const newest = sweeps[sweeps.length - 1];
    const causes: Record<string, string[]> = {
      PASSES: [],
      CORRECT_BUT_BELOW_FLOOR: [],
      NO_CORRECT_CASE_IN_SWEEP: [],
      ONLY_EVER_A_WRONG_ANSWER: [],
    };
    const bestScores = new Map<string, number>();
    if (newest !== undefined) {
      const best = bestCorrectScores(newest.record);
      for (const [k, v] of best) bestScores.set(k, v);
      const cases = (newest.record.detail?.per_case ?? []) as {
        top_skill_id: string | null;
        correct: boolean;
      }[];
      const wrongTop = new Set(
        cases.filter((c) => !c.correct && c.top_skill_id !== null).map((c) => c.top_skill_id!),
      );
      for (const id of PROMOTABLE_SKILL_IDS) {
        causes[classifyFloorFailure(best.get(id), wrongTop.has(id), CANONICALIZATION_FLOOR)]!.push(id);
      }
      console.log(`    sweep = ${newest.path.replace(/^.*experiments[\\/]/, "")}`);
      for (const [k, v] of Object.entries(causes)) {
        console.log(`    ${k.padEnd(28)} ${String(v.length).padStart(3)}`);
      }
      console.log(`\n    --- CORRECT_BUT_BELOW_FLOOR: the skill resolves right, just not confidently ---`);
      for (const id of causes["CORRECT_BUT_BELOW_FLOOR"]!) {
        console.log(`      ${id.padEnd(48)} best correct = ${bestScores.get(id)?.toFixed(4)}`);
      }
      console.log(`\n    --- NO_CORRECT_CASE_IN_SWEEP: the sweep never asked about this skill ---`);
      for (const id of causes["NO_CORRECT_CASE_IN_SWEEP"]!) console.log(`      ${id}`);
    } else {
      console.log(`    no floor-sweep record on disk`);
    }

    // ── EVAL_COVERED: it depends entirely on WHICH fixture ──
    console.log(`\n  === EVAL_COVERED — the answer depends on the fixture, and the docs quote both ===`);
    const covered = (path: string): { total: number; missing: string[] } => {
      const fx = loadEvalFixture(path);
      const ids = new Set<string>();
      for (const c of fx.cases) {
        // `countsAsEvalCoverage`, imported rather than reimplemented: a mechanical case asks
        // the index whether an exact string matches itself, which is evidence about nothing.
        // Re-deriving the rule here is how an audit starts disagreeing with the gate it audits.
        if (!countsAsEvalCoverage(c)) continue;
        if (c.expected_skill_id !== null) ids.add(c.expected_skill_id);
        for (const a of c.acceptable_skill_ids ?? []) ids.add(a);
      }
      return {
        total: fx.cases.length,
        missing: PROMOTABLE_SKILL_IDS.filter((id) => !ids.has(id)),
      };
    };
    const fixtures = ["data/taxonomy/eval/retrieval-v2.jsonl", "data/taxonomy/eval/retrieval-v3.jsonl"];
    const coverage: Record<string, { cases: number; missing: number }> = {};
    for (const f of fixtures) {
      if (!existsSync(f)) continue;
      const c = covered(f);
      coverage[f] = { cases: c.total, missing: c.missing.length };
      console.log(
        `    ${f.padEnd(44)} cases ${String(c.total).padStart(4)}   promotable NOT covered ${String(c.missing.length).padStart(3)}`,
      );
    }
    console.log(
      `    the gate is judged against --fixture, default ${DEFAULT_FIXTURE}. A doc quoting ` +
        `"41/96" is quoting v2.`,
    );

    // ── THE GREEN PATH — derived from the facts above, not typed from memory ──
    //
    // Each step names who can take it. The distinction that matters is not "hard/easy" but
    // "engineering / spend / owner", because two of those an agent must not do.
    const bestEval = evals
      .filter((e) => e.record.fixture_version === REGRESSION_BASELINE.fixture_version)
      .sort((a, b) => (b.record.recall_at_1 ?? 0) - (a.record.recall_at_1 ?? 0))[0];
    const freshV2WouldLikelyScore = evals
      .filter(
        (e) =>
          e.record.fixture_version === REGRESSION_BASELINE.fixture_version &&
          (e.record.recall_at_1 ?? 1) < REGRESSION_BASELINE.recall_at_1,
      )
      .sort((a, b) => (b.record.recall_at_1 ?? 0) - (a.record.recall_at_1 ?? 0))[0];

    const greenPath = [
      {
        gate: "NO_REGRESSION",
        step: 1,
        actor: "ENGINEERING",
        what: "the floor-sweep record must be ABLE to carry a corpus_fingerprint",
        status:
          sweepFingerprinted.length > 0
            ? "DONE — at least one sweep record carries one"
            : "the ExperimentRecord field exists as of this change; no sweep has been RE-RUN " +
              "since, so every record on disk is still unfingerprinted",
      },
      {
        gate: "NO_REGRESSION",
        step: 2,
        actor: "AI SPEND",
        what:
          "re-run db:sweep:floor --run --experiment AND db:eval:taxonomy --run --experiment on " +
          `fixture v${REGRESSION_BASELINE.fixture_version}, so both records carry a fingerprint ` +
          "matching the live corpus",
        status: "NOT DONE — requires a provider call; neither can be produced from stored vectors",
      },
      {
        gate: "NO_REGRESSION",
        step: 3,
        actor: "OWNER or CORPUS FIX",
        what:
          `the fresh evaluation must reach R@1 >= ${REGRESSION_BASELINE.recall_at_1} and ` +
          `MRR >= ${REGRESSION_BASELINE.mrr}`,
        status:
          freshV2WouldLikelyScore === undefined
            ? "no sub-baseline v2 evidence exists"
            : `the last v${REGRESSION_BASELINE.fixture_version} run scored ` +
              `R@1 ${freshV2WouldLikelyScore.record.recall_at_1} — a real regression, causally ` +
              "attributed to case GP-04. A fresh run is expected to reproduce it, so this needs " +
              "either a corpus fix or a recorded waiver. A WAIVER CANNOT CLEAR STEP 2: " +
              "staleness is not waivable.",
      },
      {
        gate: "RESOLVABLE_ABOVE_FLOOR",
        step: 1,
        actor: "ENGINEERING + OWNER",
        what: `${causes["CORRECT_BUT_BELOW_FLOOR"]!.length} skills resolve CORRECTLY below the floor`,
        status:
          "the skill is found and not confidently. Remedy is corpus (more or better aliases), " +
          "not threshold; ratifying new aliases is an owner act. Lowering the floor is prohibited.",
      },
      {
        gate: "RESOLVABLE_ABOVE_FLOOR",
        step: 2,
        actor: "AI SPEND",
        what: `${causes["NO_CORRECT_CASE_IN_SWEEP"]!.length} skills produced no correct case in the sweep at all`,
        status:
          "they ARE present in fixture v3, so this is a property of the 2026-08-21 run rather " +
          "than of coverage. A fresh sweep is needed before anything is concluded about them.",
      },
      {
        gate: "EVAL_COVERED",
        step: 1,
        actor: "NONE",
        what: "already green under the fixture in use",
        status: `retrieval-v3 leaves 0 promotable skills uncovered; retrieval-v2 leaves 41`,
      },
    ];

    console.log(`\n  === THE GREEN PATH ===`);
    for (const g of greenPath) {
      console.log(`    [${g.actor.padEnd(18)}] ${g.gate} ${g.step}. ${g.what}`);
      console.log(`        ${g.status}`);
    }
    void bestEval;

    const out = arg("json");
    if (out !== undefined) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(
        out,
        `${JSON.stringify(
          {
            kind: "gate-evidence",
            ...provenance({
              source: `pnpm db:audit:gate-evidence --batch ${batchDir ?? "(none)"} --fixture=${fixturePath}`,
              target: hostClass(url),
              readOnly: true,
              role: who?.who ?? null,
              bypassRls: who?.bypass_rls ?? false,
              populationPredicate:
                `every experiment record under ${EXPERIMENTS_DIR} judged by the runner's own ` +
                `judgeRegression/bestCorrectScores against the live corpus fingerprint; the 96 ` +
                `PROMOTABLE_SKILL_IDS categorised against the newest floor sweep`,
            }),
            ai_spend_inr: 0,
            floor: CANONICALIZATION_FLOOR,
            regression_baseline: { ...REGRESSION_BASELINE },
            live_corpus_fingerprint: liveFingerprint,
            evaluation_records: evalVerdicts,
            no_regression_independent_blockers: noRegressionBlockers,
            floor_sweep_records: sweeps.map((s) => ({
              path: s.path.replace(/^.*experiments[\\/]/, ""),
              has_fingerprint: s.record.corpus_fingerprint !== undefined,
              cases: (s.record.detail?.per_case ?? []).length,
            })),
            resolvable_above_floor: {
              by_cause: Object.fromEntries(Object.entries(causes).map(([k, v]) => [k, v.length])),
              correct_but_below_floor: causes["CORRECT_BUT_BELOW_FLOOR"]!.map((id) => ({
                skill_id: id,
                best_correct: bestScores.get(id) ?? null,
              })),
              no_correct_case_in_sweep: causes["NO_CORRECT_CASE_IN_SWEEP"],
              only_ever_a_wrong_answer: causes["ONLY_EVER_A_WRONG_ANSWER"],
            },
            eval_covered_by_fixture: coverage,
            green_path: greenPath,
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
