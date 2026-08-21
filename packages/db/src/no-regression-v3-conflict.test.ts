/**
 * The two INDEPENDENT reasons fixture v3 cannot satisfy `NO_REGRESSION`.
 *
 * ===========================================================================
 * WHY PIN A FAILURE
 * ===========================================================================
 * `NO_REGRESSION` is failing correctly, and it should keep failing until somebody decides what
 * to do about it. The risk is not that it gets fixed — it is that it gets fixed the wrong way,
 * quietly, by whoever next wants promotion to proceed.
 *
 * Two edits would each turn the gate green without improving anything: re-pointing
 * `REGRESSION_BASELINE.recall_at_1` to the observed 0.9675, or bumping its `fixture_version`
 * to 3 without re-measuring. Both are threshold-tuning. These tests make either one break a
 * test that says, in words, why it is wrong.
 *
 * They assert the CURRENT contract. They do not endorse it — see
 * `decision-no-regression-fixture-architecture.md`, which is an open owner decision.
 */
import { describe, expect, it } from "vitest";

import { judgeRegression, REGRESSION_BASELINE } from "./promote-skills";

/** What EXP-P9-TRAINER-V3 actually recorded on 2026-08-21. */
const V3_OBSERVED = {
  evaluator_version: 2,
  fixture_version: 3,
  recall_at_1: 0.9675,
  mrr: 0.9816,
} as const;

describe("NO_REGRESSION vs fixture v3 — two independent failures", () => {
  it("the baseline is still pinned to fixture v2 at a perfect score", () => {
    // If this breaks, someone re-pointed the baseline. That is an owner decision and must not
    // arrive as a side effect of a promotion attempt.
    expect(REGRESSION_BASELINE.fixture_version).toBe(2);
    expect(REGRESSION_BASELINE.recall_at_1).toBe(1.0);
    expect(REGRESSION_BASELINE.mrr).toBe(1.0);
  });

  it("FAILURE A — the version check rejects v3 before any score is compared", () => {
    const v = judgeRegression(V3_OBSERVED);
    expect(v.passed).toBe(false);
    expect(v.detail).toMatch(/fixture v3 but the reference is v2/);
    // Load-bearing: the deltas are null because no comparison happened. A future refactor that
    // computed them anyway would make this failure look like a score failure, which it is not.
    expect(v.delta_recall_at_1).toBeNull();
    expect(v.delta_mrr).toBeNull();
  });

  it("FAILURE A is structural — even a PERFECT v3 run is rejected on version alone", () => {
    const perfect = judgeRegression({ ...V3_OBSERVED, recall_at_1: 1.0, mrr: 1.0 });
    expect(perfect.passed).toBe(false);
    expect(perfect.detail).toMatch(/fixture v3 but the reference is v2/);
  });

  it("FAILURE B — the scores fail on their own, with the version conflict removed", () => {
    // Same numbers, relabelled as v2, so only the score comparison is left to fail.
    const v = judgeRegression({ ...V3_OBSERVED, fixture_version: 2 });
    expect(v.passed).toBe(false);
    expect(v.observed_recall_at_1).toBe(0.9675);
    expect(v.observed_mrr).toBe(0.9816);
    expect(v.delta_recall_at_1).toBeCloseTo(-0.0325, 4);
    expect(v.delta_mrr).toBeCloseTo(-0.0184, 4);
  });

  it("both must be resolved — fixing either one alone still fails", () => {
    // Version fixed, scores not: fails.
    expect(judgeRegression({ ...V3_OBSERVED, fixture_version: 2 }).passed).toBe(false);
    // Scores fixed, version not: fails.
    expect(judgeRegression({ ...V3_OBSERVED, recall_at_1: 1.0, mrr: 1.0 }).passed).toBe(false);
    // Both fixed: passes — which is the only honest route, and requires a real 1.0 measurement.
    expect(judgeRegression({ evaluator_version: 2, fixture_version: 2, recall_at_1: 1.0, mrr: 1.0 }).passed).toBe(true);
  });

  it("there is still no tolerance band — 0.9999 is a failure", () => {
    const v = judgeRegression({ evaluator_version: 2, fixture_version: 2, recall_at_1: 0.9999, mrr: 1.0 });
    expect(v.passed).toBe(false);
  });
});
