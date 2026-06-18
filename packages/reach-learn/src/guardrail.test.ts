import { describe, it, expect } from "vitest";
import { measureGuardrail } from "./guardrail";
import { BASELINE_WEIGHTS } from "./model";
import { buildSyntheticData } from "./fixtures/synthetic";
import type { WeightVector } from "./types";

const { snapshot } = buildSyntheticData({ seed: 9 });

describe("widen-never-narrow — MEASURED guardrail (ADR-0017 Decision 5)", () => {
  it("baseline vs baseline → no change, passes (ratio 1, nothing zeroed)", () => {
    const g = measureGuardrail(BASELINE_WEIGHTS, BASELINE_WEIGHTS, snapshot, { epsilon: 0.1 });
    expect(g.minExposureRatio).toBeCloseTo(1, 6);
    expect(g.workersBelowFloor).toEqual([]);
    expect(g.anyWorkerZeroed).toBe(false);
    expect(g.setMonotonicityHolds).toBe(true);
    expect(g.pass).toBe(true);
  });

  it("FAILS a profile that narrows — collapses everything onto role (buries off-trade workers)", () => {
    // An extreme (out-of-bounds) profile the model could never emit, used to PROVE the
    // guardrail actually detects narrowing rather than always passing.
    const narrowing: WeightVector = {
      role: 0.95,
      distance: 0.01,
      experience: 0.01,
      pay: 0.01,
      availability: 0.01,
      activity: 0.01,
    };
    const g = measureGuardrail(BASELINE_WEIGHTS, narrowing, snapshot, { epsilon: 0.1 });
    expect(g.pass).toBe(false);
    expect(g.workersBelowFloor.length).toBeGreaterThan(0);
  });

  it("reports cold-cohort widening as a first-class number", () => {
    const g = measureGuardrail(BASELINE_WEIGHTS, BASELINE_WEIGHTS, snapshot, { epsilon: 0.1 });
    expect(typeof g.coldCohortMedianDelta).toBe("number");
    expect(typeof g.topKGained).toBe("number");
    expect(typeof g.topKLost).toBe("number");
  });
});
