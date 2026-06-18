import { describe, it, expect } from "vitest";
import { assembleDataset } from "./dataset";
import { BASELINE_WEIGHTS, calibrateWeights, normalize } from "./model";
import { buildSyntheticData } from "./fixtures/synthetic";
import { SIGNALS } from "./types";

const ds = (seed: number) => {
  const { events, snapshot } = buildSyntheticData({ seed });
  return { ...assembleDataset(events, snapshot), snapshot };
};

describe("model — bounded calibration, assist-not-decide (ADR-0017 Decision 1/4)", () => {
  it("keeps every weight within ±delta of baseline, sums to 1, role stays dominant, nothing zeroed", () => {
    const { train, snapshot } = ds(3);
    const wp = calibrateWeights(train, snapshot, { delta: 0.1, floor: 0.02 });
    const sum = SIGNALS.reduce((s, k) => s + wp.weights[k], 0);
    expect(sum).toBeCloseTo(1, 3);
    for (const s of SIGNALS) {
      expect(wp.weights[s]).toBeGreaterThanOrEqual(0.02 - 1e-6); // no signal switched off
      expect(Math.abs(wp.weights[s] - BASELINE_WEIGHTS[s])).toBeLessThanOrEqual(0.1 + 1e-3);
    }
    for (const s of SIGNALS) if (s !== "role") expect(wp.weights.role).toBeGreaterThanOrEqual(wp.weights[s] - 1e-9);
  });

  it("is deterministic — same train+snapshot → identical signature", () => {
    const a = ds(5);
    const b = ds(5);
    const wpa = calibrateWeights(a.train, a.snapshot, { datasetManifestHash: "h" });
    const wpb = calibrateWeights(b.train, b.snapshot, { datasetManifestHash: "h" });
    expect(wpa.signature).toBe(wpb.signature);
    expect(wpa.weights).toEqual(wpb.weights);
  });

  it("normalize() is idempotent and scale-invariant", () => {
    const scaled = Object.fromEntries(SIGNALS.map((s) => [s, BASELINE_WEIGHTS[s] * 3])) as typeof BASELINE_WEIGHTS;
    expect(normalize(scaled)).toEqual(normalize(BASELINE_WEIGHTS));
  });
});
