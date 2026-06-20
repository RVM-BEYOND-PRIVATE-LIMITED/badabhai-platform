/**
 * Ranking-quality metrics (ADR-0017 Decision 3): NDCG@k, MAP, MRR — grouped per query
 * (the worker's feed), with optional inverse-propensity (IPW) position-bias correction
 * so the model learns relevance, not "rank-1 gets the action". Pure + deterministic.
 */
import { SIGNALS, type FeatureVector, type TrainingRow, type WeightVector } from "./types";

/** Apply a weight vector to a feature vector → a 0..1 relevance score. */
export function scoreByWeights(features: FeatureVector, weights: WeightVector): number {
  let s = 0;
  for (const sig of SIGNALS) s += weights[sig] * features[sig];
  return s;
}

export interface MetricOptions {
  /** Cutoff k for NDCG@k (and the others). Default 10. */
  k?: number;
  /** Apply IPW position-bias correction using `rankShown`. Default true. */
  ipw?: boolean;
  /** Floor on the examination propensity to bound IPW variance. Default 0.1. */
  propensityFloor?: number;
}

export interface MetricSet {
  ndcg: number;
  map: number;
  mrr: number;
  /** Queries that contributed (had >=1 positive). */
  scoredQueries: number;
}

/** Group rows by query id, deterministically (sorted group keys + stable item order). */
export function groupByQuery(rows: TrainingRow[]): Map<string, TrainingRow[]> {
  const groups = new Map<string, TrainingRow[]>();
  for (const r of rows) {
    const g = groups.get(r.groupKey);
    if (g) g.push(r);
    else groups.set(r.groupKey, [r]);
  }
  return groups;
}

/** Order a group's items best-first by score; ties broken by jobId for reproducibility. */
function rankGroup(group: TrainingRow[], weights: WeightVector): TrainingRow[] {
  return [...group].sort((a, b) => {
    const d = scoreByWeights(b.features, weights) - scoreByWeights(a.features, weights);
    if (d !== 0) return d;
    return a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0;
  });
}

const log2 = (n: number): number => Math.log(n) / Math.LN2;

/** Examination propensity for IPW from the shown rank (lower rank ⇒ more examined). */
function propensity(rankShown: number, floor: number): number {
  const p = 1 / log2(rankShown + 1);
  return Math.max(floor, Math.min(1, p));
}

/** Compute NDCG@k / MAP / MRR over all queries for one weight vector. */
export function computeMetrics(
  rows: TrainingRow[],
  weights: WeightVector,
  opts: MetricOptions = {},
): MetricSet {
  const k = opts.k ?? 10;
  const ipw = opts.ipw ?? true;
  const floor = opts.propensityFloor ?? 0.1;
  const groups = groupByQuery(rows);

  let sumNdcg = 0;
  let sumMap = 0;
  let sumMrr = 0;
  let scored = 0;

  for (const group of [...groups.values()]) {
    const positives = group.filter((r) => r.label === 1);
    if (positives.length === 0) continue; // NDCG/MAP/MRR undefined with no positive
    scored++;

    const ranked = rankGroup(group, weights);
    const gain = (r: TrainingRow): number => {
      const g = 2 ** r.label - 1;
      return ipw ? g / propensity(r.rankShown, floor) : g;
    };

    // DCG@k and IDCG@k (ideal: positives first, by descending gain).
    let dcg = 0;
    for (let i = 0; i < Math.min(k, ranked.length); i++) {
      dcg += gain(ranked[i]!) / log2(i + 2);
    }
    const ideal = [...group].sort((a, b) => gain(b) - gain(a));
    let idcg = 0;
    for (let i = 0; i < Math.min(k, ideal.length); i++) {
      idcg += gain(ideal[i]!) / log2(i + 2);
    }
    sumNdcg += idcg > 0 ? dcg / idcg : 0;

    // MAP (precision@hit averaged over positives) and MRR (first hit).
    let hits = 0;
    let apSum = 0;
    let firstHitRank = 0;
    for (let i = 0; i < ranked.length; i++) {
      if (ranked[i]!.label === 1) {
        hits++;
        apSum += hits / (i + 1);
        if (firstHitRank === 0) firstHitRank = i + 1;
      }
    }
    sumMap += positives.length > 0 ? apSum / positives.length : 0;
    sumMrr += firstHitRank > 0 ? 1 / firstHitRank : 0;
  }

  return {
    ndcg: scored > 0 ? sumNdcg / scored : 0,
    map: scored > 0 ? sumMap / scored : 0,
    mrr: scored > 0 ? sumMrr / scored : 0,
    scoredQueries: scored,
  };
}
