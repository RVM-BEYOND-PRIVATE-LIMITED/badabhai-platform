/**
 * Candidate-alias simulation (Phase 8) — what WOULD change if a skill gained an alias.
 *
 *   pnpm db:experiment:alias --run [--include-provisional] [--experiment EXP-...]
 *
 * ===========================================================================
 * WHAT DECISION THIS INFORMS
 * ===========================================================================
 * Phase 7 Gate D left exactly one failing retrieval case, GP-04, and the remediation options
 * for it all cost something irreversible: editing the fixture changes what "correct" means,
 * re-embedding changes the corpus, changing the floor changes what production assigns. Before
 * paying any of those, the cheapest question is whether the taxonomy is simply missing a word
 * — and that question can be answered exactly, offline, without writing anything.
 *
 * ===========================================================================
 * WHY THE SIMULATION IS EXACT AND NOT AN ESTIMATE
 * ===========================================================================
 * The embedder applies no task_type, so a string embedded as a QUERY and the same string
 * embedded as a DOCUMENT land on the same vector. That is measured, not assumed: embedding
 * the text of an existing alias and scoring it against that alias's stored vector returns
 * cosine 1.0000. So `cosine(query, candidate)` computed here IS the score the candidate alias
 * would receive once embedded and stored. The simulation can therefore be trusted to decide
 * whether a corpus write is worth making, which is the whole point of running it first.
 *
 * If that ever stops holding — a task_type is introduced, or the model changes — this harness
 * silently becomes an approximation. `assertExactSimulationHolds` exists to fail loudly at
 * that moment rather than let a stale assumption keep authorising corpus writes.
 *
 * ===========================================================================
 * WHY CANDIDATES ARE DERIVED, NOT AUTHORED
 * ===========================================================================
 * A candidate alias invented after reading a failing case is indistinguishable, at the level
 * of the metric, from fitting the metric. So the default candidate source is mechanical: a
 * skill's own `label_en`, taken from the `skill` table, for every skill whose label is not
 * already among its aliases. Nothing about that rule mentions GP-04 or any other case, and it
 * is justified on its own terms — a skill the retriever cannot match on its own canonical
 * name is a defect whether or not a fixture case happens to expose it.
 *
 * ===========================================================================
 * WHAT IS MEASURED, AND WHY BOTH HALVES ARE NEEDED
 * ===========================================================================
 * RANK — does the accepted skill win? That is what Recall@1 and NO_REGRESSION watch.
 * FLOOR — does it win at or above the canonicalization floor? That is what
 *         RESOLVABLE_ABOVE_FLOOR watches.
 * A case can flip from wrong to right and still be unassignable in production, so a
 * simulation reporting only the rank change would recommend a change that does not reach a
 * worker's profile. Both are reported, per case, and never merged into one score.
 */
import { sql as dsql } from "drizzle-orm";
import { config } from "dotenv";

import { createDbClient } from "./client";
import { CANONICALIZATION_FLOOR } from "./promote-skills";
import { createEmbedCache } from "./taxonomy-embed-cache";
import { loadEvalFixture } from "./taxonomy-eval-fixture";
import {
  isExperimentId,
  writeExperimentRecord,
  type ExperimentId,
  type ExperimentRecord,
} from "./taxonomy-experiments";
import {
  ALIAS_OVERFETCH,
  DEFAULT_FIXTURE,
  PRE_PROMOTION_SKILL_STATUSES,
  PRODUCTION_SKILL_STATUSES,
  evalArg,
} from "./taxonomy-retrieval-eval";
import { EVALUATOR_VERSION } from "./taxonomy-retrieval-metrics";

config({ path: "../../.env" });

const SCRIPT = "experiment:alias";

/** Categories the retrieval fixture scores for reachability only — never for rank. */
const COVERAGE_ONLY_CATEGORIES = new Set(["unembedded_shipped"]);

/** Default top-k, matching the retrieval evaluation so the two are comparable. */
export const DEFAULT_K = 5;

/** The one model this corpus is embedded with. Part of the cache key, so a change misses. */
export const EMBEDDING_MODEL = "gemini-embedding-001";

/**
 * Fold a label and an alias to the same key so "Coolant management" is recognised as already
 * present when the alias reads "coolant management".
 *
 * Devanagari is preserved deliberately: stripping it would fold every Hindi alias to the
 * empty string, and every Hindi-labelled skill would then look like it already had its label.
 */
export function normalizeAliasText(s: string): string {
  // Devanagari is matched by SCRIPT rather than by codepoint range. A raw range over the
  // block spans its combining marks, so the class silently depends on whether a grapheme was
  // composed or decomposed \u2014 "\u0928\u093E\u092A" typed two different ways would normalise two different
  // ways, and the same alias would fail to match itself.
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\p{Script=Devanagari}]+/gu, " ")
    .trim();
}

export interface SkillRow {
  skill_id: string;
  label_en: string | null;
  aliases: string[];
}

/**
 * The mechanical candidate set: every skill whose own English label is absent from its alias
 * list. Skills with no label, or whose label is already an alias, contribute nothing.
 */
export function canonicalLabelCandidates(skills: readonly SkillRow[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of skills) {
    if (s.label_en === null || s.label_en.trim() === "") continue;
    const have = new Set(s.aliases.map(normalizeAliasText));
    if (have.has(normalizeAliasText(s.label_en))) continue;
    out.set(s.skill_id, s.label_en);
  }
  return out;
}

export const cosine = (a: readonly number[], b: readonly number[]): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
};

/** One scored alias row, exactly as the retrieval query returns them. */
export interface AliasScore {
  skill_id: string;
  score: number;
}

/**
 * Collapse alias rows to a top skill the way production does: take the best `window` alias
 * rows, then reduce to skills.
 *
 * The slice mirrors the `LIMIT k * ALIAS_OVERFETCH` in the retrieval query so this function's
 * contract matches the query it stands in for. It is NOT what catches truncation, and it is
 * worth being precise about why: the sort runs before the slice, so slicing can only discard
 * rows that already lost. For the top-1 answer the window is provably inert — mutation A06
 * removed it and no test could fail, because no test can.
 *
 * Truncation is a statement about VISIBILITY, not about the winner, so it is detected where
 * visibility is measured: `classifyCase` records the accepted skill's alias-rank and
 * `summarizeSimulation` flags any rank past the window. That is the check to defend if this
 * area is ever refactored.
 */
export function topSkill(rows: readonly AliasScore[], window: number): { skill_id: string | null; score: number } {
  const ranked = [...rows].sort((a, b) => b.score - a.score).slice(0, window);
  let id: string | null = null;
  let best = -Infinity;
  for (const r of ranked) {
    if (r.score > best) {
      best = r.score;
      id = r.skill_id;
    }
  }
  return { skill_id: id, score: best === -Infinity ? 0 : best };
}

export type CaseVerdict = "fixed" | "broken" | "still_wrong" | "unchanged";

export interface CaseSimulation {
  case_id: string;
  category: string;
  job_domain_id: string;
  expected_skill_id: string;
  verdict: CaseVerdict;
  before_skill_id: string | null;
  before_score: number;
  after_skill_id: string | null;
  after_score: number;
  /** Floor transition of a case that is correct both before and after. */
  floor: "lifted" | "dropped" | "none";
  /** Alias-rank of the first accepted skill, before and after — truncation early-warning. */
  before_rank: number;
  after_rank: number;
}

/**
 * Judge one case.
 *
 * `accepted` carries the fixture's `acceptable_skill_ids` as well as `expected_skill_id`. It
 * is not a nicety: AL-01 resolves to skill_forklift_operation, which the fixture explicitly
 * accepts, so judging against the expected id alone reports a miss the evaluator never
 * counted — and then credits any change that moves it with a fix that was never broken.
 */
export function classifyCase(
  meta: { case_id: string; category: string; job_domain_id: string; expected_skill_id: string },
  accepted: ReadonlySet<string>,
  before: readonly AliasScore[],
  after: readonly AliasScore[],
  window: number,
  floor: number = CANONICALIZATION_FLOOR,
): CaseSimulation {
  const b = topSkill(before, window);
  const a = topSkill(after, window);
  const okB = b.skill_id !== null && accepted.has(b.skill_id);
  const okA = a.skill_id !== null && accepted.has(a.skill_id);

  let verdict: CaseVerdict;
  if (!okB && okA) verdict = "fixed";
  else if (okB && !okA) verdict = "broken";
  else if (!okB && !okA) verdict = "still_wrong";
  else verdict = "unchanged";

  let floorMove: "lifted" | "dropped" | "none" = "none";
  if (okB && okA) {
    if (b.score < floor && a.score >= floor) floorMove = "lifted";
    else if (b.score >= floor && a.score < floor) floorMove = "dropped";
  }

  const rankOf = (rows: readonly AliasScore[]): number =>
    [...rows].sort((x, y) => y.score - x.score).findIndex((r) => accepted.has(r.skill_id)) + 1;

  return {
    ...meta,
    verdict,
    before_skill_id: b.skill_id,
    before_score: b.score,
    after_skill_id: a.skill_id,
    after_score: a.score,
    floor: floorMove,
    before_rank: rankOf(before),
    after_rank: rankOf(after),
  };
}

export interface SimulationSummary {
  cases: number;
  fixed: number;
  broken: number;
  still_wrong: number;
  unchanged: number;
  lifted_over_floor: number;
  dropped_under_floor: number;
  /** Accepted skill pushed outside the fetch window by the added density. */
  truncated: number;
  recall_at_1_before: number;
  recall_at_1_after: number;
}

export function summarizeSimulation(rows: readonly CaseSimulation[], window: number): SimulationSummary {
  const count = (v: CaseVerdict): number => rows.filter((r) => r.verdict === v).length;
  const correctBefore = rows.filter((r) => r.verdict === "unchanged" || r.verdict === "broken").length;
  const correctAfter = rows.filter((r) => r.verdict === "unchanged" || r.verdict === "fixed").length;
  const n = rows.length;
  return {
    cases: n,
    fixed: count("fixed"),
    broken: count("broken"),
    still_wrong: count("still_wrong"),
    unchanged: count("unchanged"),
    lifted_over_floor: rows.filter((r) => r.floor === "lifted").length,
    dropped_under_floor: rows.filter((r) => r.floor === "dropped").length,
    truncated: rows.filter((r) => r.after_rank === 0 || r.after_rank > window).length,
    recall_at_1_before: n === 0 ? 0 : correctBefore / n,
    recall_at_1_after: n === 0 ? 0 : correctAfter / n,
  };
}

/**
 * A simulation is only worth acting on if it improves something and costs nothing. "Costs
 * nothing" is three separate claims, and a change can satisfy two of them while failing the
 * third, so they are kept apart rather than blended into a score.
 */
export function recommendation(s: SimulationSummary): { act: boolean; why: string } {
  if (s.broken > 0) return { act: false, why: `REJECT — ${s.broken} case(s) regress from correct to wrong` };
  if (s.dropped_under_floor > 0) {
    return { act: false, why: `REJECT — ${s.dropped_under_floor} correct case(s) fall below the floor` };
  }
  if (s.truncated > 0) {
    return { act: false, why: `REJECT — ${s.truncated} case(s) pushed outside the ${"fetch window"}` };
  }
  if (s.fixed === 0 && s.lifted_over_floor === 0) return { act: false, why: "no effect — nothing to act on" };
  return {
    act: true,
    why: `${s.fixed} fixed, ${s.lifted_over_floor} lifted over the floor, 0 broken, 0 dropped, 0 truncated`,
  };
}

/**
 * Guards the assumption the whole harness rests on: that embedding an existing alias's text
 * reproduces that alias's stored vector. If the provider gains a task_type or the model
 * changes underneath, the simulation quietly becomes a guess — and a guess must not be
 * allowed to authorise a corpus write.
 */
export function assertExactSimulationHolds(observed: number, tolerance = 1e-3): void {
  if (!(observed >= 1 - tolerance)) {
    throw new Error(
      `[${SCRIPT}] the simulation is no longer exact: re-embedding a stored alias returned ` +
        `cosine ${observed.toFixed(6)} against its own stored vector, not 1.0. Query and ` +
        `document vectors have diverged (a task_type, a model change, or a dimension change), ` +
        `so a simulated candidate score is no longer the score the alias would actually get. ` +
        `Fix the assumption before trusting any recommendation from this harness.`,
    );
  }
}

// ───────────────────────────────────────────────────────────────────────────
// CLI
// ───────────────────────────────────────────────────────────────────────────

interface FixtureCase {
  case_id: string;
  query: string;
  category: string;
  job_domain_id: string;
  expected_skill_id: string | null;
  acceptable_skill_ids?: string[];
}

async function main(): Promise<void> {
  const argv = process.argv;
  const fixturePath = evalArg(argv, "--fixture") ?? DEFAULT_FIXTURE;
  const experimentRaw = evalArg(argv, "--experiment");
  if (experimentRaw !== null && !isExperimentId(experimentRaw)) {
    throw new Error(`[${SCRIPT}] --experiment ${experimentRaw} is not a known experiment id`);
  }
  const experiment = experimentRaw as ExperimentId | null;
  const statuses = argv.includes("--include-provisional")
    ? PRE_PROMOTION_SKILL_STATUSES
    : PRODUCTION_SKILL_STATUSES;
  const k = Number(evalArg(argv, "--k") ?? DEFAULT_K);
  const window = k * ALIAS_OVERFETCH;

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);
  const aiBase = process.env.AI_SERVICE_URL ?? "http://localhost:8000";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env.AI_INTERNAL_TOKEN) headers["x-ai-internal-token"] = process.env.AI_INTERNAL_TOKEN;

  const fetchVector = async (text: string): Promise<number[]> => {
    const r = await fetch(`${aiBase}/embeddings/skill-alias`, {
      method: "POST",
      headers,
      body: JSON.stringify({ items: [{ alias_id: "00000000-0000-4000-8000-000000000000", text }] }),
    });
    if (!r.ok) throw new Error(`[${SCRIPT}] embed ${r.status}: ${await r.text()}`);
    const j = (await r.json()) as {
      results: { vector: number[] }[];
      errors?: number;
      is_mock?: boolean;
      budget_stopped?: boolean;
    };
    if (j.is_mock) throw new Error(`[${SCRIPT}] mock embedding — refusing to draw a conclusion`);
    if (j.budget_stopped) throw new Error(`[${SCRIPT}] spend ledger blocked the call`);
    const v = j.results[0]?.vector;
    if (!v) {
      // The endpoint answers 200 with an empty result set when the provider refused every
      // retry, so a falsy vector here is a PROVIDER failure, not a malformed response. Saying
      // "no vector returned" sent Phase 8 looking at the wrong layer for ten minutes.
      throw new Error(
        `[${SCRIPT}] the provider returned no vector for this text after the ai-service ` +
          `exhausted its retries (errors=${String(j.errors ?? "?")}). The usual cause is the ` +
          `per-day REQUEST quota: this endpoint sends one text per request, so a 232-text ` +
          `experiment costs 232 requests. Check the ai-service log for status 429, and re-run ` +
          `with --offline once the cache is warm.`,
      );
    }
    return v;
  };

  const cache = createEmbedCache({
    model: EMBEDDING_MODEL,
    fetchVector,
    offline: argv.includes("--offline"),
  });
  const embed = (text: string): Promise<number[]> => cache.embed(text);

  const fixture = loadEvalFixture(fixturePath);
  const cases = (fixture.cases as unknown as FixtureCase[]).filter(
    (c) => c.expected_skill_id !== null && !COVERAGE_ONLY_CATEGORIES.has(c.category),
  );

  const { db, sql } = createDbClient(url, { max: 1 });
  const started = Date.now();
  try {
    const skills = (await sql.unsafe(
      `SELECT s.skill_id, s.label_en,
              coalesce(array_agg(sa.text) FILTER (WHERE sa.text IS NOT NULL), '{}') AS aliases
       FROM skill s
       JOIN job_domain_skill jds ON jds.skill_id = s.skill_id AND jds.status = 'active'
       LEFT JOIN skill_alias sa ON sa.skill_id = s.skill_id
       WHERE s.status = ANY($1::text[])
       GROUP BY s.skill_id, s.label_en`,
      [statuses],
    )) as unknown as SkillRow[];

    const candidates = canonicalLabelCandidates(skills);
    console.log(`[${SCRIPT}] candidate source = canonical label_en absent from the alias set`);
    console.log(`  skills reachable via an active edge = ${skills.length}`);
    console.log(`  candidate aliases                   = ${candidates.size}`);
    console.log(`  fixture                             = ${fixture.manifest.fixture_id} v${fixture.manifest.version}`);
    console.log(`  scored cases                        = ${cases.length}`);
    console.log(`  fetch window (k=${k} x ${ALIAS_OVERFETCH})           = ${window} alias rows`);

    if (!argv.includes("--run")) {
      console.log(`[${SCRIPT}] PLAN only — nothing embedded, nothing written. Use --run.`);
      return;
    }

    // Prove the simulation is still exact before letting it recommend anything.
    //
    // The probe compares a FRESH embedding of a stored alias against that alias's stored
    // vector, so it is inherently a live check: --offline has no fresh embedding to compare
    // and the probe cannot run. It is skipped rather than faked, and the record says so —
    // an unverified assumption recorded as verified is worse than one recorded as unverified.
    const offline = argv.includes("--offline");
    let exactness: "PASS" | "NOT_VERIFIED_OFFLINE" = "NOT_VERIFIED_OFFLINE";
    if (offline) {
      console.log(`  exactness probe                     = SKIPPED (--offline: needs a live embed)`);
    } else {
      const probe = (await db.execute(
        dsql`SELECT text, embedding::text AS embedding FROM skill_alias
             WHERE embedding IS NOT NULL ORDER BY id LIMIT 1`,
      )) as unknown as { text: string; embedding: string }[];
      const row = probe[0];
      if (row === undefined) throw new Error(`[${SCRIPT}] no embedded alias to validate against`);
      assertExactSimulationHolds(cosine(await embed(row.text), JSON.parse(row.embedding) as number[]));
      exactness = "PASS";
      console.log(`  exactness probe                     = PASS (re-embedded alias matches its stored vector)`);
    }

    const candVec = new Map<string, number[]>();
    for (const [id, label] of candidates) candVec.set(id, await embed(label));

    const edges = (await sql.unsafe(
      `SELECT jds.job_domain_id, jds.skill_id
       FROM job_domain_skill jds JOIN skill s ON s.skill_id = jds.skill_id
       WHERE jds.status = 'active' AND s.status = ANY($1::text[])`,
      [statuses],
    )) as unknown as { job_domain_id: string; skill_id: string }[];
    const byDomain = new Map<string, string[]>();
    for (const e of edges) {
      const l = byDomain.get(e.job_domain_id) ?? [];
      l.push(e.skill_id);
      byDomain.set(e.job_domain_id, l);
    }

    const results: CaseSimulation[] = [];
    for (const c of cases) {
      const qvec = await embed(c.query);
      const before = (await sql.unsafe(
        `SELECT s.skill_id, 1 - (sa.embedding <=> $1::vector) AS score
         FROM skill_alias sa
         JOIN job_domain_skill jds ON jds.skill_id = sa.skill_id
         JOIN skill s ON s.skill_id = sa.skill_id
         WHERE jds.job_domain_id = $2 AND jds.status = 'active'
           AND s.status = ANY($3::text[]) AND sa.embedding IS NOT NULL
         ORDER BY sa.embedding <=> $1::vector`,
        [JSON.stringify(qvec), c.job_domain_id, statuses],
      )) as unknown as { skill_id: string; score: string }[];

      const beforeRows: AliasScore[] = before.map((r) => ({ skill_id: r.skill_id, score: Number(r.score) }));
      const afterRows: AliasScore[] = [...beforeRows];
      for (const sid of byDomain.get(c.job_domain_id) ?? []) {
        const v = candVec.get(sid);
        if (v !== undefined) afterRows.push({ skill_id: sid, score: cosine(qvec, v) });
      }

      results.push(
        classifyCase(
          {
            case_id: c.case_id,
            category: c.category,
            job_domain_id: c.job_domain_id,
            expected_skill_id: c.expected_skill_id as string,
          },
          new Set([c.expected_skill_id as string, ...(c.acceptable_skill_ids ?? [])]),
          beforeRows,
          afterRows,
          window,
        ),
      );
    }

    const summary = summarizeSimulation(results, window);
    const rec = recommendation(summary);
    const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

    console.log(`\n[${SCRIPT}] RESULT`);
    console.log(`  Recall@1  ${pct(summary.recall_at_1_before)} -> ${pct(summary.recall_at_1_after)}`);
    console.log(`  fixed=${summary.fixed} broken=${summary.broken} unchanged=${summary.unchanged} still_wrong=${summary.still_wrong}`);
    console.log(`  floor: lifted=${summary.lifted_over_floor} dropped=${summary.dropped_under_floor}`);
    console.log(`  truncated out of the window = ${summary.truncated}`);
    for (const r of results.filter((x) => x.verdict !== "unchanged" || x.floor !== "none")) {
      console.log(
        `    ${r.verdict.padEnd(12)} ${r.floor === "none" ? "        " : r.floor.padEnd(8)} ${r.case_id.padEnd(10)} ` +
          `${r.before_score.toFixed(4)} ${String(r.before_skill_id)} -> ${r.after_score.toFixed(4)} ${String(r.after_skill_id)}`,
      );
    }
    console.log(`  RECOMMENDATION: ${rec.act ? "ACT" : "DO NOT ACT"} — ${rec.why}`);

    if (experiment !== null) {
      const recordedAt = new Date().toISOString();
      const record: ExperimentRecord = {
        experiment,
        run_id: `alias-sim-${fixture.manifest.fixture_id}-v${fixture.manifest.version}-${recordedAt}`,
        recorded_at: recordedAt,
        purpose:
          "Offline candidate-alias simulation: add each skill's own canonical label_en where " +
          "absent from its alias set, and measure rank and floor movement. Nothing written.",
        evaluator_version: EVALUATOR_VERSION,
        fixture_id: fixture.manifest.fixture_id,
        fixture_version: fixture.manifest.version,
        corpus_batch: fixture.manifest.corpus_batch ?? null,
        model: null,
        embedding_model: EMBEDDING_MODEL,
        query_count: cases.length,
        failure_count: 0,
        latency_ms: Date.now() - started,
        recall_at_1: summary.recall_at_1_after,
        recall_at_3: null,
        recall_at_5: null,
        mrr: null,
        input_tokens: null,
        cost_inr_metered: null,
        cost_inr_estimated: null,
        ann: {
          corpus_rows: null,
          hnsw_used: null,
          ef_search: null,
          iterative_scan: null,
          k,
          alias_overfetch: ALIAS_OVERFETCH,
        },
        detail: {
          candidate_source: "skill.label_en absent from skill_alias",
          candidate_count: candidates.size,
          skill_statuses: statuses,
          fetch_window: window,
          exactness_probe: exactness,
          vectors_from_cache: cache.stats().hits,
          vectors_live: cache.stats().misses,
          summary,
          recommendation: rec,
          per_case: results,
        },
        notes: [
          "SIMULATION, not a measurement of the served system. No alias was embedded and no " +
            "row was written; recall_at_1 is what the corpus WOULD score if the candidates were added.",
          "Candidates are derived mechanically from skill.label_en, never authored against a " +
            "failing case — a candidate invented after reading a failure is metric-fitting.",
          exactness === "PASS"
            ? "Exactness probed this run: re-embedding a stored alias reproduced its stored vector, " +
              "so a candidate's simulated score is the score it would actually receive."
            : "Exactness NOT probed this run (--offline needs a live embed). The vectors are real " +
              "provider output for this model, but the query/document identity was not re-verified " +
              "at this timestamp — check an earlier PASS on the same model before acting.",
        ],
      };
      console.log(`[${SCRIPT}] recorded ${writeExperimentRecord(record)}`);
    }
  } finally {
    cache.flush();
    const s = cache.stats();
    console.log(`[${SCRIPT}] provider requests = ${s.misses} live, ${s.hits} served from cache`);
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && /taxonomy-alias-experiment\.ts$/.test(process.argv[1])) {
  void main();
}
