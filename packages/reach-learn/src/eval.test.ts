import { describe, it, expect } from "vitest";
import { computeMetrics } from "./metrics";
import { assembleDataset } from "./dataset";
import { calibrateWeights } from "./model";
import { evaluate } from "./eval";
import { buildSyntheticData } from "./fixtures/synthetic";
import type { TrainingRow, WeightVector } from "./types";

const W: WeightVector = { role: 1, distance: 0, experience: 0, pay: 0, availability: 0, activity: 0 };

function row(jobId: string, label: 0 | 1, role: number, rank: number): TrainingRow {
  return {
    groupKey: "q1",
    workerId: "w1",
    jobId,
    features: { role, distance: 0, experience: 0, pay: 0, availability: 0, activity: 0 },
    label,
    rankShown: rank,
    shownAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("metrics — NDCG/MAP/MRR sanity", () => {
  it("perfect ordering (relevant item scored highest) → NDCG=MAP=MRR=1", () => {
    const rows = [row("a", 1, 0.9, 1), row("b", 0, 0.1, 2)];
    const m = computeMetrics(rows, W, { ipw: false });
    expect(m.ndcg).toBeCloseTo(1, 6);
    expect(m.map).toBeCloseTo(1, 6);
    expect(m.mrr).toBeCloseTo(1, 6);
  });

  it("worst ordering (relevant item scored lowest) → metrics < 1", () => {
    const rows = [row("a", 1, 0.1, 1), row("b", 0, 0.9, 2)];
    const m = computeMetrics(rows, W, { ipw: false });
    expect(m.ndcg).toBeLessThan(1);
    expect(m.mrr).toBeCloseTo(0.5, 6); // relevant item lands at rank 2
  });
});

describe("offline eval — held-out, gated PASS (ADR-0017 Decision 3)", () => {
  it("calibrated profile does NOT regress ranking quality AND passes the guardrail", () => {
    const { events, snapshot } = buildSyntheticData({ seed: 21 });
    const ds = assembleDataset(events, snapshot, { testFraction: 0.3 });
    const wp = calibrateWeights(ds.train, snapshot, { datasetManifestHash: "h" });
    const res = evaluate(ds.test, wp, snapshot, { k: 10 });
    expect(res.ndcg.delta).toBeGreaterThanOrEqual(0); // never worse than baseline
    expect(res.guardrail.pass).toBe(true);
    expect(res.pass).toBe(true);
  });

  it("the learner recovers the planted signal — across seeds, pay weight moves UP (proves it learns)", () => {
    // Data is generated with the pay signal boosted (.10→.20). On aggregate the bounded
    // calibrator should move pay UP relative to baseline — proof it recovers signal, not noise.
    const seeds = [21, 22, 23, 24, 25];
    let pay = 0;
    for (const seed of seeds) {
      const { events, snapshot } = buildSyntheticData({ seed });
      const ds = assembleDataset(events, snapshot, { testFraction: 0.3 });
      const wp = calibrateWeights(ds.train, snapshot, { enforceGuardrail: false });
      pay += wp.weights.pay;
    }
    expect(pay / seeds.length, "mean pay weight (unconstrained)").toBeGreaterThan(0.1);
  });

  it("the guardrail BINDS — the calibrated profile never adopts a narrowing tune (widen-never-narrow wins)", () => {
    // With the guardrail ON (default), any candidate that would narrow a worker's
    // exposure is rejected even if it improves NDCG. The result must always pass.
    const { events, snapshot } = buildSyntheticData({ seed: 21 });
    const ds = assembleDataset(events, snapshot, { testFraction: 0.3 });
    const constrained = calibrateWeights(ds.train, snapshot, {}); // guardrail ON
    const res = evaluate(ds.test, constrained, snapshot, { k: 10 });
    expect(res.guardrail.pass, "constrained profile must not narrow").toBe(true);
    expect(res.guardrail.anyWorkerZeroed).toBe(false);
  });
});
