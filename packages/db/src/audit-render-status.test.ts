import { describe, it, expect } from "vitest";
import { strandedCount, type PendingAges } from "./audit-render-status";

/**
 * The only judgement in this audit is the line between "a render in flight" and "a row nothing
 * is coming back for". The counting is Postgres's job; THIS is the part worth pinning, because
 * moving the threshold silently changes what the report claims.
 */
describe("audit:render-status — stranded pending rows", () => {
  const ages = (over: Partial<PendingAges> = {}): PendingAges => ({
    under_1h: 0,
    h1_to_24h: 0,
    d1_to_7d: 0,
    over_7d: 0,
    oldest: null,
    re_pended: 0,
    ...over,
  });

  it("does NOT count rows under an hour — those are renders that may still land", () => {
    expect(strandedCount(ages({ under_1h: 25 }))).toBe(0);
  });

  it("counts every bucket past an hour", () => {
    expect(strandedCount(ages({ h1_to_24h: 2, d1_to_7d: 3, over_7d: 4 }))).toBe(9);
  });

  it("ignores the in-flight bucket when both are present — the report must not inflate itself", () => {
    expect(strandedCount(ages({ under_1h: 100, h1_to_24h: 1 }))).toBe(1);
  });

  it("is zero on an empty database rather than throwing", () => {
    expect(strandedCount(ages())).toBe(0);
  });

  it("does NOT subtract re-pended rows — they are reported beside the count, not removed from it", () => {
    // A regenerate puts a row back to 'pending' without resetting `generated_at`, so those rows
    // sit in the old buckets while being freshly re-pended. The report says so rather than
    // guessing which of them are genuinely stranded — a subtraction here would be a fabrication.
    expect(strandedCount(ages({ over_7d: 5, re_pended: 5 }))).toBe(5);
  });
});
