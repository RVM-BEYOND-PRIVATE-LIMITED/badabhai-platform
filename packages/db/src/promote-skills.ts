/**
 * Skill promotion runner (Phase 7 Gate E) — `provisional` -> `active`.
 *
 *   pnpm db:promote:skills --batch <dir>              # PLAN. Default. Changes nothing.
 *   pnpm db:promote:skills --batch <dir> --apply      # promote, writing an audit report
 *   pnpm db:promote:skills --revert <report.json>     # put them back
 *
 * ===========================================================================
 * WHY PROMOTION IS A GATE AND NOT A FLAG FLIP
 * ===========================================================================
 * Since Phase 7 Gate A, `skill.status = 'active'` is what makes a skill retrievable at all:
 * `SkillsRepository.canonicalAliasRows` filters on it, so a provisional skill cannot reach a
 * worker's profile. That is the safety property, and this runner is the only thing that
 * removes it. It therefore has to be harder to run than an UPDATE, and every run has to
 * leave behind enough evidence to answer "why is this skill live?" months later.
 *
 * The design follows `retag-skills.ts`, which solved the same problem for the same layer:
 * DRY-RUN BY DEFAULT, a production guard, optimistic concurrency on apply, and a
 * git-tracked report as the audit artifact. That last point is deliberate and worth
 * restating — a `packages/db` runner has NO event pipeline (there is no request, no actor,
 * no correlation id), so emitting a spine event from here would mean inventing an actor.
 * The committed report is the audit record; commit it with the run.
 *
 * ===========================================================================
 * THE CRITERIA, AND WHY EACH ONE IS THERE
 * ===========================================================================
 * Every criterion is evaluated for every candidate and reported individually, whether it
 * passed or not. A single "eligible: true/false" would hide which rule did the work, and
 * the interesting question at review time is always which rule was the binding one.
 *
 *   C1 GATE_ACCEPTED   — the skill is in a batch's `accepted-skills.jsonl`. It passed the
 *                        Phase 3 quality gate. A skill from a BLOCKED batch has no accepted
 *                        file at all, so pointing `--batch` at one is refused outright.
 *   C2 IS_PROVISIONAL  — currently `provisional`. Promoting an `active` skill is a no-op and
 *                        promoting a `deprecated` one would resurrect something a human
 *                        retired; both are refused rather than skipped quietly.
 *   C3 ACTIVE_EDGE     — at least one `job_domain_skill` row with `status = 'active'`.
 *                        Retrieval scopes through that join, so a skill with no active edge
 *                        is unreachable and promoting it changes nothing except the audit
 *                        trail's honesty.
 *   C4 FULLY_EMBEDDED  — every alias has a non-NULL embedding, none is the mock sentinel,
 *                        and they all carry the SAME model. A partially-embedded active
 *                        skill is the worst of both worlds: live, and findable only through
 *                        whichever aliases happen to have vectors.
 *   C5 EVAL_COVERED    — the skill appears as an `expected_skill_id` or an
 *                        `acceptable_skill_ids` entry in the evaluation fixture. This is the
 *                        strict one: it means we only promote what we have actually
 *                        MEASURED. On the current corpus it admits 61 of 98 and blocks 37,
 *                        so it is the criterion most likely to be argued about — which is
 *                        exactly why it is a named, waivable rule (`--waive EVAL_COVERED`)
 *                        that records the waiver in the report, rather than a silent
 *                        default either way.
 *
 * FAIL-CLOSED: `--apply` promotes NOTHING unless every selected skill passes every
 * non-waived criterion. A partial promotion is how a corpus ends up in a state nobody
 * described, and "it did most of them" is not a state you can reason about later.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { config } from "dotenv";
import { and, eq, inArray } from "drizzle-orm";

import { createDbClient } from "./client";
import { skills } from "./schema";
import { batchScopeSkillIds, hasFlag, requiredArg } from "./embed-skill-aliases";
import { loadEvalFixture } from "./taxonomy-eval-fixture";
import { DEFAULT_FIXTURE, MOCK_MODEL_TAG } from "./taxonomy-retrieval-eval";

config({ path: "../../.env" });

const SCRIPT = "promote:skills";
/**
 * Where audit reports land. Git-tracked: the report IS the audit record.
 *
 * Resolved from `__dirname`, NOT from the process cwd, and for a concrete reason: the first
 * run of this runner was launched from `packages/db` and quietly created a whole
 * `packages/db/docs/registers/` tree. An audit artifact that lands wherever the operator
 * happened to be standing is not an audit trail — it is a file nobody will find. Same
 * convention as `retag-skills.ts` and `TAXONOMY_DATA_DIR`.
 */
export const PROMOTION_REPORT_DIR = join(
  __dirname,
  "..",
  "..",
  "..",
  "docs",
  "registers",
  "skill-promotions",
);

/** The closed set of promotion criteria. */
export const CRITERIA = [
  "GATE_ACCEPTED",
  "IS_PROVISIONAL",
  "ACTIVE_EDGE",
  "FULLY_EMBEDDED",
  "EVAL_COVERED",
  "RESOLVABLE_ABOVE_FLOOR",
  "NO_REGRESSION",
] as const;
export type Criterion = (typeof CRITERIA)[number];

/**
 * The canonicalization floor a candidate must be able to clear.
 *
 * Mirrors `skill_canonicalize_floor` in the ai-service. Gate C re-measured it against the
 * complete corpus and RECOMMENDED KEEPING IT: 0.75 already yields 100% precision, and the
 * only cheaper option (0.72) buys two resolutions while cutting the margin over a known
 * failure from 0.047 to 0.017. Promotion is judged against the floor that is actually
 * running, not against one somebody hopes to move to.
 */
export const CANONICALIZATION_FLOOR = 0.75;

/**
 * The regression reference, and it is deliberately NOT a tolerance band.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO ALLOWANCE
 * ---------------------------------------------------------------------------
 * The obvious shape for this gate is "block if Recall@1 drops more than X". Every value of
 * X is an invention: nobody has established what size of regression is acceptable for a
 * worker's profile, and a number chosen to let the current corpus through is not a safety
 * gate, it is a rubber stamp with arithmetic on it.
 *
 * So the reference is the measured Phase 6 corrected-evaluation result — Recall@1 1.0000 and
 * MRR 1.0000, evaluator v2, fixture v2 — and ANY shortfall blocks and is REPORTED FOR REVIEW.
 * A human can then decide that a specific regression is acceptable and say so explicitly, in
 * a waiver that is recorded. That is a different act from a threshold quietly absorbing it.
 *
 * This gate is expected to FIRE on the current corpus, and that is the point. Gate B embedded
 * the shipped catalogue, which put `skill_turning` (5 aliases, previously unembedded) into
 * competition inside `jd_nco_7223_6002` and cost case GP-04 — Recall@1 1.0000 -> 0.9912. That
 * is a real, causally-attributed regression, and promotion should stop on it rather than
 * proceed while a number nobody chose says it is small enough.
 */
export const REGRESSION_BASELINE = {
  recall_at_1: 1.0,
  mrr: 1.0,
  source: "EXP-EVAL-CORRECTION eval-taxonomy-retrieval-v1-v2-e2-2026-08-17T06:33:38.652Z",
  evaluator_version: 2,
  fixture_version: 2,
} as const;

export function isCriterion(v: string): v is Criterion {
  return (CRITERIA as readonly string[]).includes(v);
}

/**
 * Best CORRECT resolution score per skill, read out of a Gate C floor-sweep record.
 *
 * Only `correct` resolutions count. A skill that scores 0.9 while being the WRONG answer has
 * demonstrated it can be confidently mis-assigned, which is an argument against promoting it,
 * not for it.
 */
export function bestCorrectScores(sweepRecord: unknown): Map<string, number> {
  const detail = (sweepRecord as { detail?: { per_case?: unknown[] } }).detail;
  const cases = (detail?.per_case ?? []) as {
    top_skill_id: string | null;
    score: number | null;
    correct: boolean;
  }[];
  const out = new Map<string, number>();
  for (const c of cases) {
    if (!c.correct || c.score === null || c.top_skill_id === null) continue;
    const seen = out.get(c.top_skill_id);
    if (seen === undefined || c.score > seen) out.set(c.top_skill_id, c.score);
  }
  return out;
}

export interface RegressionVerdict {
  passed: boolean;
  detail: string;
  observed_recall_at_1: number | null;
  observed_mrr: number | null;
  delta_recall_at_1: number | null;
  delta_mrr: number | null;
}

/**
 * Compare an evaluation record against the regression reference. NO tolerance.
 *
 * Refuses an evaluation taken with a DIFFERENT instrument. Comparing a v1-evaluator number
 * with the v2 reference would be comparing two different questions, and the delta would be a
 * measurement artifact presented as a safety verdict — precisely the defect Phase 6 existed
 * to remove.
 */
export function judgeRegression(evalRecord: unknown, corpusChangedAt: Date | null = null): RegressionVerdict {
  const r = evalRecord as {
    recall_at_1?: number | null;
    mrr?: number | null;
    evaluator_version?: number;
    fixture_version?: number | null;
  };
  const none = (detail: string): RegressionVerdict => ({
    passed: false,
    detail,
    observed_recall_at_1: r?.recall_at_1 ?? null,
    observed_mrr: r?.mrr ?? null,
    delta_recall_at_1: null,
    delta_mrr: null,
  });
  if (r === null || typeof r !== "object") return none("no evaluation record supplied");
  if (r.evaluator_version !== REGRESSION_BASELINE.evaluator_version) {
    return none(
      `evaluation used evaluator v${String(r.evaluator_version)} but the reference is ` +
        `v${REGRESSION_BASELINE.evaluator_version}; the numbers answer different questions`,
    );
  }
  if (r.fixture_version !== REGRESSION_BASELINE.fixture_version) {
    return none(
      `evaluation used fixture v${String(r.fixture_version)} but the reference is ` +
        `v${REGRESSION_BASELINE.fixture_version}`,
    );
  }
  if (typeof r.recall_at_1 !== "number" || typeof r.mrr !== "number") {
    return none("evaluation record carries no recall_at_1/mrr — nothing to compare");
  }
  // STALENESS. An evaluation taken before the corpus last changed describes a corpus that no
  // longer exists, and pointing the gate at one is the easiest way to defeat it without
  // touching any code. Caught in review of this very gate: the first demonstration run passed
  // NO_REGRESSION using the PRE-Gate-B record, while the live corpus had already regressed to
  // 0.9912 — the gate reported PASS on evidence that could not have seen the regression.
  if (corpusChangedAt !== null) {
    const taken = Date.parse(String((r as { recorded_at?: string }).recorded_at ?? ""));
    if (!Number.isFinite(taken)) {
      return none("evaluation record has no parsable recorded_at — cannot prove it is current");
    }
    if (taken < corpusChangedAt.getTime()) {
      return none(
        `evaluation was recorded ${new Date(taken).toISOString()} but the corpus last changed ` +
          `${corpusChangedAt.toISOString()} — this evidence PREDATES the corpus it is being used ` +
          `to clear. Re-run db:eval:taxonomy --run --experiment and use the fresh record.`,
      );
    }
  }
  const d1 = Math.round((r.recall_at_1 - REGRESSION_BASELINE.recall_at_1) * 10_000) / 10_000;
  const dm = Math.round((r.mrr - REGRESSION_BASELINE.mrr) * 10_000) / 10_000;
  // Strictly below. No epsilon: an allowance is a number nobody chose.
  const passed = r.recall_at_1 >= REGRESSION_BASELINE.recall_at_1 && r.mrr >= REGRESSION_BASELINE.mrr;
  return {
    passed,
    detail: passed
      ? `R@1 ${r.recall_at_1} / MRR ${r.mrr} meets the reference (${REGRESSION_BASELINE.recall_at_1} / ${REGRESSION_BASELINE.mrr})`
      : `REGRESSION vs the reference: R@1 ${r.recall_at_1} (${d1 >= 0 ? "+" : ""}${d1}), ` +
        `MRR ${r.mrr} (${dm >= 0 ? "+" : ""}${dm}). Reported for review — promotion does not ` +
        `absorb this silently.`,
    observed_recall_at_1: r.recall_at_1,
    observed_mrr: r.mrr,
    delta_recall_at_1: d1,
    delta_mrr: dm,
  };
}

/** What the runner knows about one candidate, before any judgement. */
export interface CandidateFacts {
  skill_id: string;
  status: string | null;
  in_accepted_batch: boolean;
  active_edges: number;
  aliases: number;
  unembedded_aliases: number;
  embedding_models: string[];
  eval_covered: boolean;
  /** Best score at which a VALIDATED query resolved to this skill CORRECTLY, from a Gate C
   *  floor sweep. null = the sweep never resolved to it at all. */
  best_correct_score: number | null;
  /** Batch-level: does the supplied evaluation still meet the regression reference?
   *  Identical for every candidate — promotion is all-or-nothing for a batch. */
  no_regression: boolean;
  /** Human-readable regression detail, carried so the report explains itself. */
  regression_detail: string;
}

export interface CriterionResult {
  criterion: Criterion;
  passed: boolean;
  waived: boolean;
  detail: string;
}

export interface Verdict {
  skill_id: string;
  eligible: boolean;
  facts: CandidateFacts;
  criteria: CriterionResult[];
  /** Criteria that failed and were NOT waived — the reason this skill is held back. */
  blocking: Criterion[];
}

/**
 * Judge one candidate. PURE — no database, no clock, no filesystem.
 *
 * Separated from the query so the policy can be tested exhaustively without a database, and
 * so a reviewer can read the rules in one place rather than inferring them from SQL.
 */
export function judge(facts: CandidateFacts, waived: ReadonlySet<Criterion> = new Set()): Verdict {
  const results: CriterionResult[] = [];
  const add = (criterion: Criterion, passed: boolean, detail: string): void => {
    results.push({ criterion, passed, waived: waived.has(criterion), detail });
  };

  add(
    "GATE_ACCEPTED",
    facts.in_accepted_batch,
    facts.in_accepted_batch ? "in the batch's accepted-skills.jsonl" : "not in any accepted batch",
  );
  add(
    "IS_PROVISIONAL",
    facts.status === "provisional",
    facts.status === null ? "skill row not found" : `status = ${facts.status}`,
  );
  add(
    "ACTIVE_EDGE",
    facts.active_edges > 0,
    `${facts.active_edges} active job_domain_skill edge(s)`,
  );

  // FULLY_EMBEDDED is three conditions, reported as one criterion with a detail that says
  // which of them failed — "not fully embedded" alone sends an operator to the wrong place.
  const embedded = facts.aliases > 0 && facts.unembedded_aliases === 0;
  const mock = facts.embedding_models.includes(MOCK_MODEL_TAG);
  const mixed = facts.embedding_models.length > 1;
  add(
    "FULLY_EMBEDDED",
    embedded && !mock && !mixed,
    facts.aliases === 0
      ? "no aliases at all"
      : facts.unembedded_aliases > 0
        ? `${facts.unembedded_aliases} of ${facts.aliases} aliases unembedded`
        : mock
          ? `embedding_model is the '${MOCK_MODEL_TAG}' sentinel`
          : mixed
            ? `aliases span ${facts.embedding_models.length} models (${facts.embedding_models.join(", ")})`
            : `${facts.aliases} alias(es), model ${facts.embedding_models[0] ?? "(unstamped)"}`,
  );
  add(
    "EVAL_COVERED",
    facts.eval_covered,
    facts.eval_covered ? "exercised by the evaluation fixture" : "never exercised by any eval case",
  );

  // A skill can pass every other criterion and still be unreachable in production: the
  // canonicalization floor rejects any match below CANONICALIZATION_FLOOR, so a skill whose
  // best validated resolution sits under it is promoted into a state where it is live,
  // correct, and never assigned. Gate C measured 13 of 112 correct answers below 0.75.
  add(
    "RESOLVABLE_ABOVE_FLOOR",
    facts.best_correct_score !== null && facts.best_correct_score >= CANONICALIZATION_FLOOR,
    facts.best_correct_score === null
      ? "no validated query ever resolved to this skill correctly"
      : facts.best_correct_score >= CANONICALIZATION_FLOOR
        ? `best validated resolution ${facts.best_correct_score} >= floor ${CANONICALIZATION_FLOOR}`
        : `best validated resolution ${facts.best_correct_score} is BELOW the ${CANONICALIZATION_FLOOR} floor — ` +
          `promoting it would make it live but unassignable`,
  );

  add("NO_REGRESSION", facts.no_regression, facts.regression_detail);

  const blocking = results.filter((r) => !r.passed && !r.waived).map((r) => r.criterion);
  return { skill_id: facts.skill_id, eligible: blocking.length === 0, facts, criteria: results, blocking };
}

/** The audit artifact. Committed; `--revert` reads it back. */
export interface PromotionReport {
  script: string;
  mode: "PLAN" | "APPLY";
  generated_at: string;
  batch_dir: string;
  fixture: string;
  waived: Criterion[];
  floor: number;
  regression_baseline: typeof REGRESSION_BASELINE;
  regression: RegressionVerdict;
  sweep_record: string | null;
  eval_record: string | null;
  candidates: number;
  eligible: number;
  blocked: number;
  /** Populated on APPLY only: the skills whose status actually moved. */
  promoted: string[];
  /** Rows the optimistic-concurrency guard skipped because they moved under us. */
  skipped_concurrent: string[];
  verdicts: Verdict[];
  notes: string[];
}

/** Tally which criterion blocked how many candidates — the summary a reviewer wants. */
export function blockingHistogram(verdicts: readonly Verdict[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of verdicts) for (const c of v.blocking) out[c] = (out[c] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

export function reportPath(stamp: string, baseDir: string = PROMOTION_REPORT_DIR): string {
  return join(baseDir, `promotion-${stamp.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

/** Write the audit artifact. REFUSES to overwrite — a report is evidence, not a scratch file. */
export function writeReport(report: PromotionReport, path: string): string {
  if (existsSync(path)) {
    throw new Error(`[${SCRIPT}] ${path} already exists; promotion reports are immutable evidence.`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return path;
}

// ===========================================================================
// CLI
// ===========================================================================

async function main(): Promise<void> {
  // GUARDED, as retag-skills.ts and seed-skills.ts are. Promotion is what makes a skill
  // publishable; the production run is a deliberate, separately-gated step.
  if (process.env.NODE_ENV === "production") {
    throw new Error(`[${SCRIPT}] refusing to promote in production (promotion is a gated ops action).`);
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);
  const argv = process.argv;

  const waivedRaw = requiredArg(argv, "--waive");
  const waived = new Set<Criterion>();
  for (const w of (waivedRaw ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    if (!isCriterion(w)) throw new Error(`[${SCRIPT}] --waive ${w} is not a criterion. One of: ${CRITERIA.join(", ")}`);
    waived.add(w);
  }

  const { db, sql } = createDbClient(url, { max: 1 });
  try {
    // ── revert ────────────────────────────────────────────────────────────
    const revertPath = requiredArg(argv, "--revert");
    if (revertPath !== null) {
      const prior = JSON.parse(readFileSync(revertPath, "utf8")) as PromotionReport;
      if (prior.mode !== "APPLY" || prior.promoted.length === 0) {
        throw new Error(`[${SCRIPT}] ${revertPath} promoted nothing; there is nothing to revert.`);
      }
      console.log(`[${SCRIPT}] REVERT — ${prior.promoted.length} skill(s) from ${revertPath}`);
      if (!hasFlag(argv, "--apply")) {
        console.log(`  (PLAN — pass --apply to perform the revert)`);
        for (const id of prior.promoted) console.log(`    would set ${id} -> provisional`);
        return;
      }
      // Optimistic: only move rows that are STILL active. A skill promoted here and then
      // deliberately re-promoted or deprecated by someone else must not be silently reset.
      const reverted = await db
        .update(skills)
        .set({ status: "provisional", updatedAt: new Date() })
        .where(and(inArray(skills.skillId, prior.promoted), eq(skills.status, "active")))
        .returning({ id: skills.skillId });
      console.log(`[${SCRIPT}] reverted ${reverted.length} / ${prior.promoted.length} to provisional`);
      const missed = prior.promoted.filter((id) => !reverted.some((r) => r.id === id));
      if (missed.length > 0) console.log(`  NOT reverted (no longer 'active'): ${missed.join(", ")}`);
      return;
    }

    // ── plan / apply ──────────────────────────────────────────────────────
    const batchDir = requiredArg(argv, "--batch");
    if (batchDir === null) {
      throw new Error(
        `[${SCRIPT}] --batch <dir> is required. Promotion is always scoped to the skills one ` +
          `quality-gated batch ACCEPTED; an unscoped promotion has no reviewable boundary.`,
      );
    }
    const scope = batchScopeSkillIds(batchDir); // throws for a BLOCKED batch
    // The two new gates are EVIDENCE-BACKED: they read recorded experiment artifacts rather
    // than re-deriving anything here. That keeps the runner file+DB only, and it makes the
    // basis for a promotion auditable long after the run.
    const sweepPath = requiredArg(argv, "--sweep");
    const evalPath = requiredArg(argv, "--eval");
    const waivedFloor = waived.has("RESOLVABLE_ABOVE_FLOOR");
    const waivedRegression = waived.has("NO_REGRESSION");
    if (sweepPath === null && !waivedFloor) {
      throw new Error(
        `[${SCRIPT}] --sweep <floor-sweep record> is required for RESOLVABLE_ABOVE_FLOOR. ` +
          `Produce one with db:sweep:floor --run --experiment, or waive the criterion explicitly.`,
      );
    }
    if (evalPath === null && !waivedRegression) {
      throw new Error(
        `[${SCRIPT}] --eval <evaluation record> is required for NO_REGRESSION. Produce one with ` +
          `db:eval:taxonomy --run --experiment, or waive the criterion explicitly.`,
      );
    }
    // When the corpus last changed. Any evaluation older than this cannot have observed the
    // current state, whatever its numbers say.
    const changedRows = (await sql.unsafe(
      `SELECT max(embedded_at) AS at FROM skill_alias WHERE embedding IS NOT NULL`,
    )) as unknown as { at: string | null }[];
    const corpusChangedAt = changedRows[0]?.at ? new Date(changedRows[0].at as string) : null;

    const bestScores =
      sweepPath === null ? new Map<string, number>() : bestCorrectScores(JSON.parse(readFileSync(sweepPath, "utf8")));
    const regression =
      evalPath === null
        ? { passed: false, detail: "no evaluation supplied", observed_recall_at_1: null, observed_mrr: null, delta_recall_at_1: null, delta_mrr: null }
        : judgeRegression(JSON.parse(readFileSync(evalPath, "utf8")), corpusChangedAt);

    const fixturePath = requiredArg(argv, "--fixture") ?? DEFAULT_FIXTURE;
    const fixture = loadEvalFixture(fixturePath);
    const covered = new Set<string>();
    for (const c of fixture.cases) {
      if (c.expected_skill_id !== null) covered.add(c.expected_skill_id);
      for (const a of c.acceptable_skill_ids ?? []) covered.add(a);
    }

    const rows = (await sql.unsafe(
      `SELECT s.skill_id,
              s.status,
              (SELECT count(*) FROM job_domain_skill j WHERE j.skill_id = s.skill_id AND j.status = 'active')::int AS active_edges,
              (SELECT count(*) FROM skill_alias a WHERE a.skill_id = s.skill_id)::int AS aliases,
              (SELECT count(*) FROM skill_alias a WHERE a.skill_id = s.skill_id AND a.embedding IS NULL)::int AS unembedded,
              COALESCE((SELECT array_agg(DISTINCT a.embedding_model)
                        FROM skill_alias a
                        WHERE a.skill_id = s.skill_id AND a.embedding IS NOT NULL AND a.embedding_model IS NOT NULL),
                       '{}')::text[] AS models
       FROM skill s WHERE s.skill_id = ANY($1::text[])`,
      [scope],
    )) as unknown as {
      skill_id: string;
      status: string;
      active_edges: number;
      aliases: number;
      unembedded: number;
      models: string[];
    }[];
    const byId = new Map(rows.map((r) => [r.skill_id, r]));

    const verdicts = scope.map((id) => {
      const r = byId.get(id);
      return judge(
        {
          skill_id: id,
          status: r?.status ?? null,
          in_accepted_batch: true, // scope IS the accepted list; a missing row fails IS_PROVISIONAL
          active_edges: r?.active_edges ?? 0,
          aliases: r?.aliases ?? 0,
          unembedded_aliases: r?.unembedded ?? 0,
          embedding_models: [...(r?.models ?? [])].sort(),
          eval_covered: covered.has(id),
          best_correct_score: bestScores.get(id) ?? null,
          no_regression: regression.passed,
          regression_detail: regression.detail,
        },
        waived,
      );
    });

    const eligible = verdicts.filter((v) => v.eligible);
    const blocked = verdicts.filter((v) => !v.eligible);
    const apply = hasFlag(argv, "--apply");

    console.log(`[${SCRIPT}] ${apply ? "APPLY" : "PLAN"} — batch ${batchDir}`);
    console.log(`  fixture                  = ${fixturePath}`);
    console.log(`  waived criteria          = ${waived.size === 0 ? "(none)" : [...waived].join(", ")}`);
    console.log(`  floor sweep              = ${sweepPath ?? "(waived)"}`);
    console.log(`  evaluation               = ${evalPath ?? "(waived)"}`);
    console.log(`  corpus last changed      = ${corpusChangedAt?.toISOString() ?? "(never embedded)"}`);
    console.log(`  regression verdict       = ${regression.passed ? "PASS" : "BLOCK"} — ${regression.detail}`);
    console.log(`  candidates               = ${verdicts.length}`);
    console.log(`  eligible                 = ${eligible.length}`);
    console.log(`  blocked                  = ${blocked.length}`);
    console.log(`  blocking criteria        = ${JSON.stringify(blockingHistogram(verdicts))}`);
    for (const v of blocked.slice(0, 15)) {
      console.log(`    ${v.skill_id.padEnd(52)} ${v.blocking.join(", ")}`);
    }
    if (blocked.length > 15) console.log(`    ... and ${blocked.length - 15} more`);

    const stamp = new Date().toISOString();
    const report: PromotionReport = {
      script: SCRIPT,
      mode: apply ? "APPLY" : "PLAN",
      generated_at: stamp,
      batch_dir: batchDir,
      fixture: fixturePath,
      waived: [...waived],
      floor: CANONICALIZATION_FLOOR,
      regression_baseline: { ...REGRESSION_BASELINE },
      regression: regression,
      sweep_record: sweepPath,
      eval_record: evalPath,
      candidates: verdicts.length,
      eligible: eligible.length,
      blocked: blocked.length,
      promoted: [],
      skipped_concurrent: [],
      verdicts,
      notes: [
        "Promotion moves skill.status provisional -> active. Since Phase 7 Gate A that is " +
          "what makes a skill retrievable by SkillsRepository.canonicalAliasRows, so this " +
          "report is the record of why each skill became publishable.",
        "This runner emits no spine event: a packages/db runner has no request, actor or " +
          "correlation id, so an event from here would have to invent one. The committed " +
          "report is the audit artifact — commit it with the run (same convention as " +
          "retag-skills.ts).",
        "Reversible: `--revert <this file> --apply` sets the promoted ids back to " +
          "provisional, skipping any row that is no longer 'active'.",
      ],
    };

    if (!apply) {
      console.log(`[${SCRIPT}] PLAN ONLY — nothing was written to the database.`);
      const path = reportPath(`plan-${stamp}`);
      console.log(`  report -> ${writeReport(report, path)}`);
      return;
    }

    // FAIL-CLOSED. A partial promotion leaves a state nobody described.
    if (blocked.length > 0) {
      console.error(
        `[${SCRIPT}] REFUSING TO PROMOTE. ${blocked.length} of ${verdicts.length} candidate(s) fail a ` +
          `non-waived criterion (${JSON.stringify(blockingHistogram(verdicts))}). Promotion is ` +
          `all-or-nothing for a batch: promoting the passing subset would leave the corpus half ` +
          `live, with no single description of what is retrievable. Fix the blockers, or waive a ` +
          `criterion explicitly with --waive and re-run so the waiver is recorded.`,
      );
      process.exitCode = 1;
      return;
    }
    if (eligible.length === 0) {
      console.log(`[${SCRIPT}] nothing to promote.`);
      return;
    }

    // Optimistic concurrency: only rows STILL provisional move. A skill someone else
    // deprecated between plan and apply must not be dragged back to active.
    const ids = eligible.map((v) => v.skill_id);
    const promoted = await db
      .update(skills)
      .set({ status: "active", updatedAt: new Date() })
      .where(and(inArray(skills.skillId, ids), eq(skills.status, "provisional")))
      .returning({ id: skills.skillId });
    report.promoted = promoted.map((r) => r.id);
    report.skipped_concurrent = ids.filter((id) => !report.promoted.includes(id));

    console.log(`[${SCRIPT}] promoted ${report.promoted.length} / ${ids.length} to active`);
    if (report.skipped_concurrent.length > 0) {
      console.log(`  SKIPPED (moved since planning): ${report.skipped_concurrent.join(", ")}`);
    }
    const path = reportPath(stamp);
    console.log(`  audit report -> ${writeReport(report, path)}`);
    console.log(`  COMMIT THIS REPORT. It is the audit record for the promotion.`);
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && /promote-skills\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
