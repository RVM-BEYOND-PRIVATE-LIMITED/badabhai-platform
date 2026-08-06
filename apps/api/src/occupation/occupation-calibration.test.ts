/**
 * Confidence calibration and the auto/disambiguate/unresolved decision.
 *
 * THE PROPERTY THAT MATTERS MOST IS THE MARGIN BEING FAMILY-LEVEL. A matcher that computes
 * it at occupation level cannot ever auto-pin inside NCO unit 7223 — 44 near-identical
 * machining titles separated by ~0.02 — so it either never fires or fires on a coin flip.
 * Several tests below are constructed so that an occupation-level margin gives a
 * demonstrably different answer from a family-level one.
 *
 * The second is that precision is ASYMMETRIC: a wrong family makes every subsequent
 * question wrong, so the tests assert the engine REFUSES more often than they assert it
 * accepts.
 */
import { describe, expect, it } from "vitest";

import {
  AUTO_FLOOR,
  AUTO_MARGIN,
  DISAMBIGUATE_FLOOR,
  MAX_DISAMBIGUATION_OPTIONS,
  calibrate,
  decide,
  type ScoredCandidate,
} from "./occupation-calibration";

const c = (
  jobDomainId: string,
  familyId: string | null,
  confidence: number,
  layer: ScoredCandidate["layer"] = "L2",
): ScoredCandidate => ({ jobDomainId, familyId, confidence, layer });

describe("calibrate", () => {
  it("L0 is a constant — an exact hit has no raw score to interpolate", () => {
    expect(calibrate("L0", 0)).toBe(calibrate("L0", 1));
    expect(calibrate("L0", 0.5)).toBeGreaterThan(AUTO_FLOOR);
  });

  it("L1 alone lands BELOW the auto floor", () => {
    // The skeleton fold collapses driver/drover and fitter/father. A skeleton hit must
    // never auto-pin on its own; it needs the margin or a second signal.
    expect(calibrate("L1", 1)).toBeLessThan(AUTO_FLOOR);
    expect(calibrate("L1", 1)).toBeGreaterThan(DISAMBIGUATE_FLOOR);
  });

  it("interpolates linearly between anchors", () => {
    // Midpoint of the L2 [0.55, 0.55] -> [0.75, 0.74] segment.
    const mid = calibrate("L2", 0.65);
    expect(mid).toBeGreaterThan(0.55);
    expect(mid).toBeLessThan(0.74);
    expect(mid).toBeCloseTo(0.645, 2);
  });

  it("is monotonic in the raw score", () => {
    for (const layer of ["L2", "L3"] as const) {
      let prev = -1;
      for (let raw = 0; raw <= 1.0001; raw += 0.05) {
        const v = calibrate(layer, raw);
        expect(v, `${layer}@${raw.toFixed(2)}`).toBeGreaterThanOrEqual(prev);
        prev = v;
      }
    }
  });

  it("clamps instead of extrapolating out of range", () => {
    // Extrapolating would produce a confidence above 1 that then passes every threshold.
    expect(calibrate("L2", 5)).toBeLessThanOrEqual(1);
    expect(calibrate("L2", -5)).toBeGreaterThanOrEqual(0);
    expect(calibrate("L3", 99)).toBeLessThanOrEqual(1);
  });

  it("returns 0 for a non-finite score rather than NaN", () => {
    // NaN compared against a threshold is silently false, which reads as "rejected" for
    // the wrong reason and is impossible to debug from a log line.
    expect(calibrate("L2", Number.NaN)).toBe(0);
    expect(calibrate("L3", Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(1);
  });

  it("maps a trigram 0.7 and a cosine 0.7 to DIFFERENT confidences", () => {
    // The whole reason this file exists. If these were equal, the mapping would be doing
    // nothing and one threshold set over raw scores would be defensible.
    expect(calibrate("L2", 0.7)).not.toBeCloseTo(calibrate("L3", 0.7), 2);
  });
});

describe("decide — auto", () => {
  it("auto-pins a confident, unambiguous top candidate", () => {
    const r = decide([c("jd_weld", "fam_welding", 0.97, "L0"), c("jd_cook", "fam_cooking", 0.5)]);
    expect(r.decision).toBe("auto");
    expect(r.pinned?.jobDomainId).toBe("jd_weld");
  });

  it("auto-pins when the only rivals are in the SAME family", () => {
    // The 7223 case. At occupation level the margin is 0.01 and nothing could ever fire;
    // at family level there is no rival at all, because all three lead to one pack.
    const r = decide([
      c("jd_cnc_turn", "fam_machining", 0.91),
      c("jd_cnc_mill", "fam_machining", 0.90),
      c("jd_lathe", "fam_machining", 0.89),
    ]);
    expect(r.decision).toBe("auto");
    expect(r.pinned?.jobDomainId).toBe("jd_cnc_turn");
  });

  it("does NOT auto-pin when a different family is close behind", () => {
    // "mistri" reaches masonry and general repair. Both score well. Picking either
    // silently is how a mason gets asked about motorcycle engines.
    const r = decide([c("jd_mason", "fam_masonry", 0.86), c("jd_fitter", "fam_fitting", 0.84)]);
    expect(r.decision).toBe("disambiguate");
    expect(r.pinned).toBeNull();
  });

  it("respects the floor even with a huge margin", () => {
    const r = decide([c("jd_a", "fam_a", AUTO_FLOOR - 0.01), c("jd_b", "fam_b", 0.1)]);
    expect(r.decision).not.toBe("auto");
  });

  it("respects the margin even with a huge confidence", () => {
    const r = decide([c("jd_a", "fam_a", 0.99), c("jd_b", "fam_b", 0.99 - (AUTO_MARGIN - 0.01))]);
    expect(r.decision).not.toBe("auto");
  });
});

describe("decide — disambiguate", () => {
  it("offers one chip per FAMILY, not per occupation", () => {
    // Two chips leading to the same interview are the same chip to a worker, and showing
    // both wastes one of only four slots.
    const r = decide([
      c("jd_weld_gas", "fam_welding", 0.7),
      c("jd_weld_arc", "fam_welding", 0.69),
      c("jd_fit", "fam_fitting", 0.68),
    ]);
    expect(r.decision).toBe("disambiguate");
    expect(r.options).toHaveLength(2);
    expect(r.options.map((o) => o.familyId)).toEqual(["fam_welding", "fam_fitting"]);
  });

  it("caps the options", () => {
    const many = Array.from({ length: 10 }, (_, i) => c(`jd_${i}`, `fam_${i}`, 0.7 - i * 0.001));
    expect(decide(many).options).toHaveLength(MAX_DISAMBIGUATION_OPTIONS);
  });

  it("never offers a candidate below the floor", () => {
    const r = decide([
      c("jd_a", "fam_a", 0.7),
      c("jd_b", "fam_b", 0.69),
      c("jd_c", "fam_c", DISAMBIGUATE_FLOOR - 0.01),
    ]);
    expect(r.options.every((o) => o.confidence >= DISAMBIGUATE_FLOOR)).toBe(true);
    expect(r.options.map((o) => o.jobDomainId)).not.toContain("jd_c");
  });

  it("preserves caller ordering rather than re-sorting", () => {
    // The caller's order carries the ladder's layer precedence (L0 before L1 at every
    // span length). Re-sorting by confidence here would silently discard it.
    const r = decide([c("jd_l0", "fam_a", 0.7, "L0"), c("jd_l2", "fam_b", 0.7, "L2")]);
    expect(r.options[0]?.jobDomainId).toBe("jd_l0");
  });
});

describe("decide — unresolved", () => {
  it("returns unresolved for an empty candidate list", () => {
    expect(decide([]).decision).toBe("unresolved");
  });

  it("returns unresolved when even the top candidate is below the floor", () => {
    const r = decide([c("jd_a", "fam_a", DISAMBIGUATE_FLOOR - 0.01)]);
    expect(r.decision).toBe("unresolved");
    expect(r.reason).toContain("DISAMBIGUATE_FLOOR");
  });

  it("refuses to offer a SINGLE chip", () => {
    // One chip asks the worker to confirm a guess the engine was not confident enough to
    // make. Better to ask an open question than to lead them into our own uncertainty.
    const r = decide([c("jd_a", "fam_a", 0.7)]);
    expect(r.decision).toBe("unresolved");
    expect(r.options).toEqual([]);
  });

  it("treats null families as distinct rather than collapsing them", () => {
    // An unbound occupation has no family. Two of them are not the same choice, and
    // merging them would silently drop one from the chips.
    const r = decide([c("jd_a", null, 0.7), c("jd_b", null, 0.69)]);
    expect(r.decision).toBe("disambiguate");
    expect(r.options).toHaveLength(2);
  });
});

describe("the decision always explains itself", () => {
  it("every outcome carries a non-empty reason", () => {
    const cases: ScoredCandidate[][] = [
      [],
      [c("jd_a", "fam_a", 0.1)],
      [c("jd_a", "fam_a", 0.7)],
      [c("jd_a", "fam_a", 0.7), c("jd_b", "fam_b", 0.69)],
      [c("jd_a", "fam_a", 0.97, "L0"), c("jd_b", "fam_b", 0.2)],
    ];
    for (const candidates of cases) {
      const r = decide(candidates);
      expect(r.reason.length, JSON.stringify(candidates)).toBeGreaterThan(0);
    }
  });
});
