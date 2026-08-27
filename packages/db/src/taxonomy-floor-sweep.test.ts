/**
 * The floor-sweep arithmetic.
 *
 * This is the module that will be quoted when someone proposes moving
 * `skill_canonicalize_floor`, so the assertions are about the ways a threshold sweep
 * flatters itself: reporting 100% precision for a threshold that assigns nothing, counting
 * a negative case as a pass, and claiming separability across an overlap.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe as suite, expect, it } from "vitest";

import { CURRENT_FLOOR, describe, safeBand, sweep, type Top1 } from "./taxonomy-floor-sweep";

const row = (o: Partial<Top1> = {}): Top1 => ({
  case_id: "C1",
  category: "paraphrase_latin",
  job_domain_id: "jd_a",
  score: 0.9,
  top_skill_id: "skill_x",
  correct: true,
  ...o,
});

suite("CURRENT_FLOOR", () => {
  it("is the value actually shipped in the ai-service config", () => {
    // Pinned so a sweep can never silently compare against a floor nobody is running.
    expect(CURRENT_FLOOR).toBe(0.75);
  });
});

suite("describe", () => {
  it("reports the order statistics that bound a threshold", () => {
    const d = describe([0.5, 0.6, 0.7, 0.8, 0.9]);
    expect(d.n).toBe(5);
    expect(d.min).toBe(0.5);
    expect(d.max).toBe(0.9);
    expect(d.p50).toBe(0.7);
  });

  it("is all-null for no samples, never zero", () => {
    // A distribution of nothing has no minimum. Reporting 0 would read as "a correct answer
    // scored 0.0" and would drag a recommended floor to the bottom of the range.
    expect(describe([])).toEqual({ n: 0, min: null, p05: null, p50: null, p95: null, max: null });
  });

  it("does not depend on input order", () => {
    expect(describe([0.9, 0.1, 0.5])).toEqual(describe([0.1, 0.5, 0.9]));
  });
});

suite("sweep", () => {
  it("counts a correct answer above the threshold as a true positive", () => {
    const [p] = sweep([row({ score: 0.9, correct: true })], [0.75]);
    expect(p).toMatchObject({ true_positives: 1, false_positives: 0, false_negatives: 0 });
  });

  it("counts a WRONG answer above the threshold as a false positive — the harmful case", () => {
    // This is the outcome the floor exists to prevent: a wrong skill id assigned to a
    // worker's profile with nothing downstream able to tell it from a right one.
    const [p] = sweep([row({ score: 0.9, correct: false })], [0.75]);
    expect(p).toMatchObject({ false_positives: 1, true_positives: 0 });
    expect(p?.precision).toBe(0);
  });

  it("counts a correct answer BELOW the threshold as a false negative, not a pass", () => {
    const [p] = sweep([row({ score: 0.6, correct: true })], [0.75]);
    expect(p).toMatchObject({ false_negatives: 1, true_positives: 0 });
    expect(p?.recall).toBe(0);
  });

  it("counts a wrong answer below the threshold as correctly withheld", () => {
    const [p] = sweep([row({ score: 0.6, correct: false })], [0.75]);
    expect(p).toMatchObject({ true_negatives: 1, false_positives: 0 });
  });

  it("reports precision NULL — not 100% — when a threshold assigns NOTHING", () => {
    // A threshold so high it resolves nothing is not perfectly precise, it is inapplicable.
    // Reporting 1.0 there is how a sweep ends up recommending 0.99.
    const [p] = sweep([row({ score: 0.6, correct: true }), row({ score: 0.5, correct: false })], [0.95]);
    expect(p?.precision).toBeNull();
    expect(p?.assignment_rate).toBe(0);
  });

  it("EXCLUDES cases where retrieval returned nothing — there was no decision to threshold", () => {
    // A null score is "the query found nothing", which the floor never sees. Folding it in
    // as a rejection would make every threshold look more precise than it is.
    const points = sweep([row({ score: null, top_skill_id: null, correct: false }), row({ score: 0.9 })], [0.75]);
    expect(points[0]).toMatchObject({ true_positives: 1, false_positives: 0, true_negatives: 0 });
    expect(points[0]?.assignment_rate).toBe(1);
  });

  it("is monotonic: raising the threshold never adds a true positive", () => {
    const rows = [row({ score: 0.6 }), row({ score: 0.8 }), row({ score: 0.95 })];
    const pts = sweep(rows, [0.5, 0.7, 0.9]);
    expect(pts[0]!.true_positives).toBeGreaterThanOrEqual(pts[1]!.true_positives);
    expect(pts[1]!.true_positives).toBeGreaterThanOrEqual(pts[2]!.true_positives);
  });

  it("treats the threshold as INCLUSIVE (>=), matching an assignment at exactly the floor", () => {
    const [p] = sweep([row({ score: 0.75, correct: true })], [0.75]);
    expect(p?.true_positives).toBe(1);
  });

  it("every case lands in exactly one of the four buckets", () => {
    const rows = [
      row({ score: 0.9, correct: true }),
      row({ score: 0.9, correct: false }),
      row({ score: 0.5, correct: true }),
      row({ score: 0.5, correct: false }),
    ];
    const [p] = sweep(rows, [0.75]);
    expect(p!.true_positives + p!.false_positives + p!.false_negatives + p!.true_negatives).toBe(4);
  });
});

suite("safeBand", () => {
  it("is separable when every correct answer outscores every wrong one", () => {
    const b = safeBand([0.8, 0.9], [0.5, 0.6]);
    expect(b.separable).toBe(true);
    expect(b.admits_all_tp_below).toBe(0.8);
    expect(b.excludes_all_fp_at_or_above).toBe(0.6);
  });

  it("is NOT separable when the distributions overlap, even by one case", () => {
    // The measured Phase 7 state: TP min 0.6778 sits below FP max 0.7031 because of a single
    // case. One overlap is still an overlap, and a sweep that rounded it away would be
    // recommending a threshold it had not earned.
    const b = safeBand([0.6778, 0.95], [0.5065, 0.7031]);
    expect(b.separable).toBe(false);
  });

  it("is not separable when either side has no samples", () => {
    // With no false positives there is nothing to separate FROM, so "separable" would be
    // vacuously true and would license any threshold at all.
    expect(safeBand([0.9], []).separable).toBe(false);
    expect(safeBand([], [0.5]).separable).toBe(false);
  });
});

// ===========================================================================
suite("--offline: a run that CANNOT spend, and cannot pretend it measured everything", () => {
  const src = readFileSync(join(__dirname, "taxonomy-floor-sweep.ts"), "utf8");

  it("wires the cache's offline mode from the flag, so a miss THROWS instead of buying", () => {
    // The only form of "this run will not cost money" that is checkable BEFORE the provider is
    // called. An estimate printed afterwards cannot un-spend anything.
    expect(src).toContain('offline: argv.includes("--offline"),');
  });

  it("counts an OFFLINE MISS as unmeasured, NOT as an error", () => {
    // The defect this closes: the catch read `catch { vec = null }` and every skipped case
    // landed in `errors`. A deliberate, priced coverage gap and a provider failure are
    // different facts, and pooling them turned "I declined to measure 41 cases" into "41
    // things went wrong" — which nobody reads as a caveat on the numbers underneath.
    expect(src).toContain('if (String((e as Error).message).includes("[embed-cache] OFFLINE"))');
    expect(src).toContain("unmeasuredOffline.push(cse.case_id);");
  });

  it("NAMES the cases it did not measure and says the rates are over the decided subset only", () => {
    // No silent caps. "100% precision" over an unstated subset is the failure mode; a reader
    // must be told the denominator moved, and which cases to buy to move it back.
    expect(src).toContain("EVERY figure below is over the ${decided.length} decided cases ONLY.");
    expect(src).toContain("unmeasuredOffline.slice(0, 12).join(\", \")");
  });

  it("carries the gap into the RECORD, not just onto the terminal", () => {
    // A record read six months later is the only thing left. If the caveat lives only in
    // stdout, the artifact claims a completeness it never had.
    expect(src).toContain("unmeasured_offline: unmeasuredOffline,");
  });
});
