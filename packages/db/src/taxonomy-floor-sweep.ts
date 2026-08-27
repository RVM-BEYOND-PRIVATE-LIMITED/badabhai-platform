/**
 * Canonicalization-floor sweep (Phase 7 Gate C) — query→alias, over the COMPLETE corpus.
 *
 *   pnpm db:sweep:floor --run [--include-provisional] [--experiment EXP-...]
 *
 *   --cache --offline        cached query vectors ONLY. A miss THROWS instead of calling the
 *                            provider, so the run either costs exactly ZERO or fails loudly.
 *                            The way to re-measure under a standing "no unauthorised spend"
 *                            instruction without having to trust an estimate afterwards.
 *
 * ===========================================================================
 * WHAT DECISION THIS INFORMS
 * ===========================================================================
 * `skill_canonicalize_floor` is the minimum cosine similarity at which a worker's phrase is
 * ASSIGNED a canonical skill id. Below it the phrase is recorded UNRESOLVED. It is therefore
 * the single number standing between "we understood you" and "we put the wrong skill on your
 * profile", and it is currently 0.75 — calibrated on 2026-07-14 against the TAX-5 wedge set,
 * a different and much smaller corpus.
 *
 * This sweep measures the two distributions that actually decide a threshold:
 *
 *   TP — the top-1 score when the top-1 answer is CORRECT. The floor must sit BELOW these,
 *        or real matches are thrown away (false negatives, silent under-resolution).
 *   FP — the top-1 score when the top-1 answer is WRONG. The floor must sit ABOVE these, or
 *        wrong ids are assigned (false positives, a wrong skill on a worker's profile).
 *
 * A threshold is only safe where those two distributions separate. Where they overlap there
 * is no safe threshold, and the honest output is to say so rather than to pick the value
 * that maximises some blended score.
 *
 * ===========================================================================
 * WHY A DEDICATED SWEEP AND NOT THE EVALUATION HARNESS
 * ===========================================================================
 * `db:eval:taxonomy` answers "is the right skill ranked first". That is rank, and it is
 * threshold-blind: a case where the right skill wins at 0.62 is a Recall@1 hit and a floor
 * REJECTION at the same time. Phase 5/6 measured Recall@1 100% while, as it turns out, a
 * large share of those wins sit below 0.75. Both statements are true, and only this one
 * bears on the floor.
 *
 * ===========================================================================
 * WHAT AN EARLIER, CHEAPER MEASUREMENT GOT WRONG
 * ===========================================================================
 * Gate C's preparatory pass compared alias↔alias similarity and found the distributions
 * overlapping almost completely (TP min 0.5123, FP max 0.8473). That number is EVIDENCE ONLY
 * and must not be used to pick a threshold, for a specific reason: its "true positive" was
 * the best score between two aliases OF THE SAME SKILL, and a skill's aliases are
 * deliberately diverse — including across languages. Scoring an English alias against its
 * Hindi sibling measures translation distance, not the resolution decision the floor makes.
 *
 * This sweep uses the operational pair instead: a real worker phrasing from the reviewed
 * fixture, embedded through the same provider path production uses, against the stored alias
 * vectors through the same scoped query.
 *
 * NO DATABASE WRITES. Query embeddings are not persisted; nothing in `skill`, `skill_alias`
 * or `job_domain_skill` is touched.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { config } from "dotenv";
import { sql as dsql } from "drizzle-orm";

import { createDbClient } from "./client";
import { CORPUS_FINGERPRINT_SQL, toFingerprint, type CorpusFingerprint } from "./corpus-fingerprint";
import { parseEmbedResponse } from "./embed-response";
import { createEmbedCache, type EmbedCache } from "./taxonomy-embed-cache";
import { loadEvalFixture, type EvalCase } from "./taxonomy-eval-fixture";
import {
  ALIAS_OVERFETCH,
  CANONICAL_RETRIEVAL_SQL,
  DEFAULT_FIXTURE,
  EVAL_QUERY_UUID,
  PRE_PROMOTION_SKILL_STATUSES,
  PRODUCTION_SKILL_STATUSES,
  langfuseStatus,
} from "./taxonomy-retrieval-eval";
import {
  UNKNOWN_ANN,
  isExperimentId,
  writeExperimentRecord,
  type ExperimentId,
  type ExperimentRecord,
} from "./taxonomy-experiments";

config({ path: "../../.env" });

const SCRIPT = "sweep:floor";
/** The floor in production today, and the value this sweep is judged against. */
export const CURRENT_FLOOR = 0.75;

/** One case's outcome at the top of the ranked list — the only rank the floor ever sees. */
export interface Top1 {
  case_id: string;
  category: string;
  job_domain_id: string;
  /** null when retrieval returned nothing at all — no decision to threshold. */
  score: number | null;
  top_skill_id: string | null;
  /** Was the top-1 skill one of the case's correct answers? */
  correct: boolean;
}

/** Precision/recall of the ASSIGNMENT decision at one candidate threshold. */
export interface ThresholdPoint {
  threshold: number;
  /** Correct answers accepted (top-1 correct AND score >= t). */
  true_positives: number;
  /** WRONG ids assigned (top-1 wrong AND score >= t) — the harmful outcome. */
  false_positives: number;
  /** Correct answers thrown away (top-1 correct AND score < t). */
  false_negatives: number;
  /** Wrong answers correctly withheld (top-1 wrong AND score < t). */
  true_negatives: number;
  /** Of everything ASSIGNED, the share that was right. */
  precision: number | null;
  /** Of everything that COULD have been right, the share assigned. */
  recall: number | null;
  /** Share of cases that got any id at all. */
  assignment_rate: number;
}

/**
 * Sweep a threshold grid.
 *
 * Precision is `null`, not 1.0, when a threshold assigns NOTHING. A threshold so high that
 * it resolves nothing is not perfectly precise — it is inapplicable, and reporting 100%
 * there is how a sweep recommends a useless value.
 */
export function sweep(rows: readonly Top1[], thresholds: readonly number[]): ThresholdPoint[] {
  const decided = rows.filter((r) => r.score !== null);
  return thresholds.map((threshold) => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;
    for (const r of decided) {
      const assigned = (r.score as number) >= threshold;
      if (assigned && r.correct) tp += 1;
      else if (assigned && !r.correct) fp += 1;
      else if (!assigned && r.correct) fn += 1;
      else tn += 1;
    }
    const assignedTotal = tp + fp;
    const r4 = (x: number): number => Math.round(x * 10_000) / 10_000;
    return {
      threshold,
      true_positives: tp,
      false_positives: fp,
      false_negatives: fn,
      true_negatives: tn,
      precision: assignedTotal === 0 ? null : r4(tp / assignedTotal),
      recall: tp + fn === 0 ? null : r4(tp / (tp + fn)),
      assignment_rate: decided.length === 0 ? 0 : r4(assignedTotal / decided.length),
    };
  });
}

export interface Distribution {
  n: number;
  min: number | null;
  p05: number | null;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export function describe(scores: readonly number[]): Distribution {
  if (scores.length === 0) return { n: 0, min: null, p05: null, p50: null, p95: null, max: null };
  const s = [...scores].sort((a, b) => a - b);
  const at = (p: number): number =>
    Math.round((s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] as number) * 10_000) / 10_000;
  return { n: s.length, min: at(0), p05: at(5), p50: at(50), p95: at(95), max: at(100) };
}

/**
 * The highest threshold that admits every true positive, and the lowest that excludes every
 * false positive. When the first is BELOW the second there is a safe band between them; when
 * it is above, the distributions overlap and no threshold is clean.
 */
export function safeBand(tp: readonly number[], fp: readonly number[]): {
  admits_all_tp_below: number | null;
  excludes_all_fp_at_or_above: number | null;
  separable: boolean;
} {
  const tpMin = tp.length === 0 ? null : Math.min(...tp);
  const fpMax = fp.length === 0 ? null : Math.max(...fp);
  return {
    admits_all_tp_below: tpMin === null ? null : Math.round(tpMin * 10_000) / 10_000,
    excludes_all_fp_at_or_above: fpMax === null ? null : Math.round(fpMax * 10_000) / 10_000,
    // Separable when every correct answer outscores every wrong one.
    separable: tpMin !== null && fpMax !== null ? tpMin > fpMax : false,
  };
}

const THRESHOLDS = [0.5, 0.55, 0.6, 0.65, 0.7, 0.72, 0.75, 0.78, 0.8, 0.82, 0.85, 0.88, 0.9, 0.95];

function arg(argv: readonly string[], flag: string): string | null {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq !== undefined) {
    const v = eq.slice(flag.length + 1);
    if (v.length === 0) throw new Error(`[${SCRIPT}] ${flag}= was given with no value.`);
    return v;
  }
  const i = argv.indexOf(flag);
  if (i < 0) return null;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`[${SCRIPT}] ${flag} requires a value.`);
  return v;
}

async function main(): Promise<void> {
  const argv = process.argv;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);
  const fixturePath = arg(argv, "--fixture") ?? DEFAULT_FIXTURE;
  const includeProvisional = argv.includes("--include-provisional");
  const statuses = includeProvisional ? [...PRE_PROMOTION_SKILL_STATUSES] : [...PRODUCTION_SKILL_STATUSES];
  const k = Number(arg(argv, "--k") ?? 5);
  const experimentRaw = arg(argv, "--experiment");
  if (experimentRaw !== null && !isExperimentId(experimentRaw)) {
    throw new Error(`[${SCRIPT}] --experiment ${experimentRaw} is not a known experiment`);
  }
  const experiment = experimentRaw as ExperimentId | null;

  const fixture = loadEvalFixture(fixturePath);
  const { db, sql } = createDbClient(url, { max: 1 });
  try {
    const corpus = (await db.execute(
      dsql`SELECT count(*)::int AS embedded,
                  count(DISTINCT skill_id)::int AS skills,
                  count(DISTINCT embedding_model)::int AS models,
                  min(embedding_model) AS model
           FROM skill_alias WHERE embedding IS NOT NULL`,
    )) as unknown as { embedded: number; skills: number; models: number; model: string | null }[];
    const c = corpus[0] as { embedded: number; skills: number; models: number; model: string | null };
    // The corpus's OWN model, read rather than assumed. Used as the query-cache key so cached
    // query vectors and stored alias vectors are guaranteed to share a space; `null` when the
    // corpus mixes models or stamps none, which disables the cache rather than guessing.
    const sweepEmbeddingModel = c.models === 1 ? c.model : null;

    console.log(`[${SCRIPT}] canonicalization-floor sweep (query -> alias)`);
    console.log(`  fixture                  = ${fixturePath} (${fixture.cases.length} cases)`);
    console.log(`  corpus embedded aliases  = ${c.embedded} across ${c.skills} skills, ${c.models} model(s)`);
    console.log(`  skill statuses retrieved = ${statuses.join(", ")}`);
    console.log(`  current production floor = ${CURRENT_FLOOR}`);
    console.log(`  langfuse                 = ${langfuseStatus()}`);
    if (!argv.includes("--run")) {
      console.log(`[${SCRIPT}] no --run: nothing embedded, nothing measured.`);
      return;
    }

    const aiBase = process.env.AI_SERVICE_URL ?? "http://localhost:8000";
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (process.env.AI_INTERNAL_TOKEN) headers["x-ai-internal-token"] = process.env.AI_INTERNAL_TOKEN;

    const started = Date.now();
    const rows: Top1[] = [];
    let errors = 0;
    /** Cases skipped because `--offline` refused to buy a vector. NOT errors — see the loop. */
    const unmeasuredOffline: string[] = [];
    let estCost = 0;

    // Coverage-probe cases are excluded: they exist to ask "is this reachable at all", and a
    // deliberately-unreachable case contributes a null decision, not a threshold data point.
    const cases = fixture.cases.filter((x) => x.category !== "unembedded_shipped");

    // -- THE QUERY-EMBED CACHE, same contract as the evaluator's ------------------------
    //
    // The sweep embeds exactly the same fixture queries the evaluator does, one provider
    // request each, so it has exactly the same cost and exactly the same reason to memoise:
    // the embedder is deterministic for a given model, and the model is part of the key so a
    // model change misses rather than mixing two vector spaces.
    //
    // A MISS STILL GOES THROUGH `embedViaProvider`, so the mock guard and the cost accounting
    // apply to it unchanged. OPT-IN via `--cache`; without the flag this runner behaves
    // exactly as it always has.
    const embedViaProvider = async (text: string): Promise<number[] | null> => {
      const resp = await fetch(`${aiBase}/embeddings/skill-alias`, {
        method: "POST",
        headers,
        body: JSON.stringify({ items: [{ alias_id: EVAL_QUERY_UUID, text }] }),
      });
      if (!resp.ok) return null;
      const data = parseEmbedResponse(await resp.json(), new Set([EVAL_QUERY_UUID]));
      estCost += data.estimated_cost_inr;
      if (data.is_mock) throw new Error(`[${SCRIPT}] the ai-service returned a MOCK vector — refusing to sweep.`);
      return data.results[0]?.vector ?? null;
    };

    const queryCache: EmbedCache | null =
      argv.includes("--cache") && sweepEmbeddingModel !== null
        ? createEmbedCache({
            model: sweepEmbeddingModel,
            // `--offline` turns a miss into a THROW. An estimate printed after the fact cannot
            // un-spend anything; this is the only form of "this run will not cost money" that
            // is checkable BEFORE the provider is called.
            offline: argv.includes("--offline"),
            fetchVector: async (text: string) => {
              const v = await embedViaProvider(text);
              if (v === null) throw new Error(`[${SCRIPT}] provider returned no vector`);
              return v;
            },
          })
        : null;

    for (const cse of cases as EvalCase[]) {
      let vec: number[] | null;
      if (queryCache === null) {
        vec = await embedViaProvider(cse.query);
      } else {
        try {
          vec = await queryCache.embed(cse.query);
        } catch (e) {
          // AN OFFLINE REFUSAL IS NOT A PROVIDER FAILURE, and collapsing the two is how a
          // partial sweep gets reported as a complete one. `--offline` declines to BUY a
          // vector: a deliberate, recoverable, priced gap in coverage, and the run has to name
          // the cases it therefore did not measure. Everything else is a real error.
          if (String((e as Error).message).includes("[embed-cache] OFFLINE")) {
            unmeasuredOffline.push(cse.case_id);
          } else {
            errors += 1;
          }
          continue;
        }
      }
      if (vec === null) {
        errors += 1;
        continue;
      }
      const got = (await sql.unsafe(CANONICAL_RETRIEVAL_SQL, [
        JSON.stringify(vec),
        cse.job_domain_id,
        k * ALIAS_OVERFETCH,
        statuses,
      ])) as unknown as { skill_id: string; score: number | string }[];

      // Dedupe to skills, keeping each skill's best score — the same collapse the metrics
      // module does, because production consumes SKILLS and thresholds the best alias score.
      const best = new Map<string, number>();
      for (const r of got) {
        const s = Number(r.score);
        const seen = best.get(r.skill_id);
        if (seen === undefined || s > seen) best.set(r.skill_id, s);
      }
      const ranked = [...best.entries()].sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0] < b[0] ? -1 : 1));
      const top = ranked[0];
      const correctIds = new Set(
        [cse.expected_skill_id, ...(cse.acceptable_skill_ids ?? [])].filter(Boolean) as string[],
      );
      rows.push({
        case_id: cse.case_id,
        category: cse.category,
        job_domain_id: cse.job_domain_id,
        score: top === undefined ? null : Math.round(top[1] * 10_000) / 10_000,
        top_skill_id: top?.[0] ?? null,
        // A NEGATIVE case has no correct answer, so ANY assignment is a false positive.
        correct: top !== undefined && correctIds.size > 0 && correctIds.has(top[0]),
      });
    }

    // PERSIST THE MISSES, or the cache is read-only and every run pays the same queries again.
    // Learned the hard way: the first two sweeps after `--cache` landed each paid for the same
    // 41 uncached v3 queries, because the vectors were memoised in memory and never written.
    // A cache that only ever hits on what something ELSE put there is not a cache.
    if (queryCache !== null) {
      queryCache.flush();
      const st = queryCache.stats();
      console.log(`  query embeds             = ${st.hits} cached, ${st.misses} paid`);
    }

    const decided = rows.filter((r) => r.score !== null);
    const tpScores = decided.filter((r) => r.correct).map((r) => r.score as number);
    const fpScores = decided.filter((r) => !r.correct).map((r) => r.score as number);
    const tp = describe(tpScores);
    const fp = describe(fpScores);
    const band = safeBand(tpScores, fpScores);
    const points = sweep(rows, THRESHOLDS);

    console.log(`\n[${SCRIPT}] RESULTS  (${decided.length} of ${cases.length} decided, ${errors} errors, ${unmeasuredOffline.length} UNMEASURED, ${Math.round((Date.now() - started) / 1000)}s)`);
    if (unmeasuredOffline.length > 0) {
      // NO SILENT CAPS. Every figure below describes the DECIDED subset, and a reader who is
      // not told the size of the gap will read "100% precision" as a claim about the whole
      // fixture. The remedy is priced: one provider embed per named case.
      console.log(
        `  UNMEASURED (--offline, no cached vector) = ${unmeasuredOffline.length} of ${cases.length}. ` +
          `EVERY figure below is over the ${decided.length} decided cases ONLY.`,
      );
      console.log(`    ${unmeasuredOffline.slice(0, 12).join(", ")}${unmeasuredOffline.length > 12 ? ", ..." : ""}`);
    }
    console.log(`  TRUE-POSITIVE  top-1 scores (correct answer won):`);
    console.log(`    n=${tp.n}  min=${tp.min}  p05=${tp.p05}  p50=${tp.p50}  p95=${tp.p95}  max=${tp.max}`);
    console.log(`  FALSE-POSITIVE top-1 scores (wrong answer won):`);
    console.log(`    n=${fp.n}  min=${fp.min}  p05=${fp.p05}  p50=${fp.p50}  p95=${fp.p95}  max=${fp.max}`);
    console.log(`  separable = ${band.separable}  (every TP above every FP?)`);
    console.log(`    lowest correct score  = ${band.admits_all_tp_below}`);
    console.log(`    highest wrong score   = ${band.excludes_all_fp_at_or_above}`);

    console.log(`\n  threshold   TP    FP    FN    TN   precision   recall   assigned`);
    for (const p of points) {
      const mark = p.threshold === CURRENT_FLOOR ? "  <- CURRENT FLOOR" : "";
      console.log(
        `  ${p.threshold.toFixed(2).padStart(8)} ${String(p.true_positives).padStart(5)} ` +
          `${String(p.false_positives).padStart(5)} ${String(p.false_negatives).padStart(5)} ` +
          `${String(p.true_negatives).padStart(5)}   ${(p.precision === null ? "  n/a" : (p.precision * 100).toFixed(1) + "%").padStart(8)} ` +
          `${((p.recall ?? 0) * 100).toFixed(1).padStart(7)}% ${((p.assignment_rate) * 100).toFixed(1).padStart(8)}%${mark}`,
      );
    }

    const worst = decided.filter((r) => !r.correct).sort((a, b) => (b.score as number) - (a.score as number));
    if (worst.length > 0) {
      console.log(`\n  highest-scoring WRONG answers (these set the precision ceiling):`);
      for (const w of worst.slice(0, 8)) {
        console.log(`    ${String(w.score).padStart(7)}  ${w.case_id.padEnd(8)} ${w.category.padEnd(22)} -> ${w.top_skill_id}`);
      }
    }
    const lowTp = decided.filter((r) => r.correct).sort((a, b) => (a.score as number) - (b.score as number));
    if (lowTp.length > 0) {
      console.log(`\n  lowest-scoring CORRECT answers (these are lost first as the floor rises):`);
      for (const w of lowTp.slice(0, 8)) {
        console.log(`    ${String(w.score).padStart(7)}  ${w.case_id.padEnd(8)} ${w.category.padEnd(22)} -> ${w.top_skill_id}`);
      }
    }

    if (experiment !== null) {
      // WHICH CORPUS this swept. Read AFTER the queries, so it describes the corpus the run
      // actually saw rather than one it might have raced. A failure is recorded as null and
      // never fabricated: `promote-skills` treats a missing fingerprint as STALE, which is the
      // correct reading of "cannot prove currency".
      //
      // This was absent until 2026-08-26, and `promote-skills` has read
      // `sweepRecord.corpus_fingerprint` for longer than that — so every sweep record ever
      // written was stale on arrival and `RESOLVABLE_ABOVE_FLOOR` evidence could not be made
      // fresh by any re-run. Stamping it does not relax the check.
      let corpusFingerprint: CorpusFingerprint | null = null;
      try {
        const fpRows = (await db.execute(CORPUS_FINGERPRINT_SQL)) as unknown as Record<string, unknown>[];
        corpusFingerprint = fpRows[0] ? toFingerprint(fpRows[0]) : null;
      } catch (e) {
        console.log(`[${SCRIPT}] WARN could not read the corpus fingerprint: ${String(e)}`);
      }
      const stamp = new Date().toISOString();
      const record: ExperimentRecord = {
        experiment,
        run_id: `floor-sweep-${stamp}`,
        recorded_at: stamp,
        purpose: "Gate C canonicalization-floor sweep — query->alias over the complete corpus.",
        evaluator_version: 0,
        fixture_id: fixture.manifest.fixture_id,
        fixture_version: fixture.manifest.version,
        corpus_batch: fixture.manifest.corpus_batch,
        model: null,
        // MEASURED, not typed. The literal that stood here would have kept saying
        // "gemini-embedding-001" through a model migration, on a record whose entire purpose
        // is to say which corpus and which geometry produced the numbers.
        embedding_model: sweepEmbeddingModel,
        corpus_fingerprint: corpusFingerprint,
        query_count: decided.length,
        failure_count: errors,
        // Separate from `failure_count` on purpose — see the offline branch in the loop.
        unmeasured_offline: unmeasuredOffline,
        latency_ms: Date.now() - started,
        // Deliberately null: a floor sweep measures the ASSIGNMENT decision, not ranking.
        recall_at_1: null,
        recall_at_3: null,
        recall_at_5: null,
        mrr: null,
        input_tokens: null,
        cost_inr_metered: null,
        cost_inr_estimated: Math.round(estCost * 1_000_000) / 1_000_000,
        ann: { ...UNKNOWN_ANN, corpus_rows: c.embedded, k, alias_overfetch: ALIAS_OVERFETCH },
        detail: {
          current_floor: CURRENT_FLOOR,
          skill_statuses: statuses,
          includes_provisional: includeProvisional,
          tp_distribution: tp,
          fp_distribution: fp,
          safe_band: band,
          thresholds: points,
          per_case: rows,
        },
        notes: [
          "Measures the ASSIGNMENT decision the floor governs, not ranking. A case can be a " +
            "Recall@1 hit and a floor rejection at the same time; only this sweep bears on " +
            "the threshold.",
          "Supersedes the Gate C preparatory alias<->alias pass, whose 'true positive' was " +
            "the best score between two aliases of the same skill — including across " +
            "languages, which measures translation distance rather than the resolution " +
            "decision. That earlier figure is evidence only and must not select a threshold.",
          "NO database writes. Query embeddings are not persisted.",
          "The production floor is NOT changed by this run.",
        ],
      };
      console.log(`\n[${SCRIPT}] recorded -> ${writeExperimentRecord(record)}`);
    }
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && /taxonomy-floor-sweep\.ts$/.test(process.argv[1])) {
  if (!existsSync(join(DEFAULT_FIXTURE)) && !process.argv.includes("--fixture")) {
    console.error(`[${SCRIPT}] default fixture missing`);
    process.exit(1);
  }
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
