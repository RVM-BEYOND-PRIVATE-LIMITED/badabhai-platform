import { describe, expect, it } from "vitest";
import { DEFAULT_MATCH_CONFIG } from "./config";
import { effectiveTier, interleaveMaxPerCompany, rankKeyCompare, skillMonthsFor } from "./rank";
import type { RankInputs, WorkerSkillRow } from "./types";

const cfg = DEFAULT_MATCH_CONFIG;
const VMC = "mskill_vmc_operator";
const TURNER = "mskill_cnc_turner";
const HMC = "mskill_hmc_operator";
const PROGRAMMER = "mskill_cnc_programmer";
const RIDER = "mskill_delivery_rider";

function row(skillId: string, monthsBucketed: number, industryId = "ind_industrial_manufacturing"): WorkerSkillRow {
  return {
    skillId: skillId as WorkerSkillRow["skillId"],
    industryId: industryId as WorkerSkillRow["industryId"],
    monthsBucketed,
    wants: true,
    startedAt: null,
    endedAt: null,
  };
}

function rank(over: Partial<RankInputs> & { id: string }): RankInputs {
  return {
    matchTier: 1,
    skillMonths: 0,
    industryMonths: 0,
    lastWorkedAt: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    ...over,
  };
}

describe("effectiveTier", () => {
  it("leaves tier 1 alone", () => {
    expect(effectiveTier(1, 0, 36)).toBe(1);
    expect(effectiveTier(1, 120, 36)).toBe(1);
  });

  it("promotes tier 2 at or above the floor", () => {
    expect(effectiveTier(2, 35, 36)).toBe(2);
    expect(effectiveTier(2, 36, 36)).toBe(1);
    expect(effectiveTier(2, 37, 36)).toBe(1);
  });

  it("a floor of 0 promotes every related worker; an unreachable floor promotes none", () => {
    expect(effectiveTier(2, 0, 0)).toBe(1);
    expect(effectiveTier(2, 120, Number.MAX_SAFE_INTEGER)).toBe(2);
  });

  it("treats non-finite months / floor as 0 instead of producing NaN tiers", () => {
    expect(effectiveTier(2, Number.NaN, 36)).toBe(2);
    expect(effectiveTier(2, 12, Number.NaN)).toBe(1);
  });
});

describe("rankKeyCompare — column by column", () => {
  it("1. effective tier ascending", () => {
    const a = rank({ id: "a", matchTier: 1, skillMonths: 0 });
    const b = rank({ id: "b", matchTier: 2, skillMonths: 0 });
    expect(rankKeyCompare(a, b, cfg)).toBeLessThan(0);
  });

  it("2. skill months descending", () => {
    const a = rank({ id: "a", skillMonths: 48 });
    const b = rank({ id: "b", skillMonths: 24 });
    expect(rankKeyCompare(a, b, cfg)).toBeLessThan(0);
  });

  it("3. industry months descending, only on a skill-months tie", () => {
    const a = rank({ id: "a", skillMonths: 24, industryMonths: 60 });
    const b = rank({ id: "b", skillMonths: 24, industryMonths: 24 });
    expect(rankKeyCompare(a, b, cfg)).toBeLessThan(0);
  });

  it("4. lastWorkedAt descending, NULLS LAST", () => {
    const recent = rank({ id: "a", lastWorkedAt: "2026-06-01" });
    const older = rank({ id: "b", lastWorkedAt: "2019-01-01" });
    const unknown = rank({ id: "c", lastWorkedAt: null });
    expect(rankKeyCompare(recent, older, cfg)).toBeLessThan(0);
    expect(rankKeyCompare(older, unknown, cfg)).toBeLessThan(0);
    expect(rankKeyCompare(unknown, recent, cfg)).toBeGreaterThan(0);
    // Two unknowns fall through to the next column, they do not tie forever.
    expect(rankKeyCompare(rank({ id: "x" }), rank({ id: "y" }), cfg)).toBeLessThan(0);
  });

  it("5. createdAt descending — the newer application first", () => {
    const newer = rank({ id: "z", createdAt: "2026-07-29T00:00:00.000Z" });
    const older = rank({ id: "a", createdAt: "2026-07-01T00:00:00.000Z" });
    expect(rankKeyCompare(newer, older, cfg)).toBeLessThan(0);
  });

  it("6. id ascending — the last resort", () => {
    expect(rankKeyCompare(rank({ id: "a" }), rank({ id: "b" }), cfg)).toBeLessThan(0);
    expect(rankKeyCompare(rank({ id: "a" }), rank({ id: "a" }), cfg)).toBe(0);
  });

  it("a corrupt month value sorts as 0 rather than out-ranking a real row", () => {
    const corrupt = rank({ id: "corrupt", skillMonths: Number.NaN });
    const real = rank({ id: "real", skillMonths: 6 });
    expect(rankKeyCompare(real, corrupt, cfg)).toBeLessThan(0);
  });
});

describe("skillMonthsFor", () => {
  it("E5 — MAX across the posted skills he holds, never the sum", () => {
    const rows = [row(VMC, 12), row(PROGRAMMER, 30)];
    expect(skillMonthsFor({ workerRows: rows, postedSkillIds: [VMC, PROGRAMMER], matchedTier: 1 })).toBe(30);
  });

  it("E6 — tier 1 counts the EXACT skill, not a longer related one", () => {
    const rows = [row(VMC, 12), row(TURNER, 60)];
    expect(skillMonthsFor({ workerRows: rows, postedSkillIds: [VMC], matchedTier: 1 })).toBe(12);
  });

  it("E7 — the same skill in two industries SUMS", () => {
    const rows = [row(TURNER, 24), row(TURNER, 18, "ind_quick_commerce")];
    expect(skillMonthsFor({ workerRows: rows, postedSkillIds: [TURNER], matchedTier: 1 })).toBe(42);
  });

  it("tier 2 counts the RELATED skill, and never a posted one", () => {
    const rows = [row(TURNER, 60), row(HMC, 24)];
    expect(skillMonthsFor({ workerRows: rows, postedSkillIds: [VMC], matchedTier: 2 })).toBe(60);
  });

  it("ignores rows that are neither posted nor related", () => {
    const rows = [row(VMC, 12), row(RIDER, 120, "ind_quick_commerce")];
    expect(skillMonthsFor({ workerRows: rows, postedSkillIds: [VMC], matchedTier: 1 })).toBe(12);
  });

  it("is 0 when nothing matches, or when the posting names nothing", () => {
    expect(skillMonthsFor({ workerRows: [row(RIDER, 24)], postedSkillIds: [VMC], matchedTier: 1 })).toBe(0);
    expect(skillMonthsFor({ workerRows: [row(VMC, 24)], postedSkillIds: [], matchedTier: 1 })).toBe(0);
    expect(skillMonthsFor({ workerRows: [], postedSkillIds: [VMC], matchedTier: 1 })).toBe(0);
  });

  it("treats a corrupt month value as 0", () => {
    const rows = [row(VMC, Number.NaN)];
    expect(skillMonthsFor({ workerRows: rows, postedSkillIds: [VMC], matchedTier: 1 })).toBe(0);
  });
});

describe("interleaveMaxPerCompany", () => {
  const feed = (keys: readonly string[]) =>
    keys.map((payerKey, i) => ({ jobId: `${payerKey}-${i}`, payerKey }));

  function longestRun(rows: readonly { payerKey: string }[]): number {
    let best = 0;
    let current = 0;
    let key: string | null = null;
    for (const r of rows) {
      if (r.payerKey === key) current += 1;
      else {
        key = r.payerKey;
        current = 1;
      }
      if (current > best) best = current;
    }
    return best;
  }

  it("caps consecutive cards from one company", () => {
    const out = interleaveMaxPerCompany(feed(["a", "a", "a", "a", "b", "c"]), 2);
    expect(longestRun(out)).toBeLessThanOrEqual(2);
    expect(out).toHaveLength(6);
  });

  it("NEVER drops a row — the output is a permutation of the input", () => {
    const rows = feed(["a", "b", "a", "a", "c", "a", "b", "a"]);
    const out = interleaveMaxPerCompany(rows, 2);
    expect(out.map((r) => r.jobId).sort()).toEqual(rows.map((r) => r.jobId).sort());
  });

  it("preserves relative order WITHIN a company", () => {
    const rows = feed(["a", "a", "a", "b", "b", "b"]);
    const out = interleaveMaxPerCompany(rows, 2);
    const aOrder = out.filter((r) => r.payerKey === "a").map((r) => r.jobId);
    expect(aOrder).toEqual(rows.filter((r) => r.payerKey === "a").map((r) => r.jobId));
  });

  it("leaves an already-compliant feed untouched", () => {
    const rows = feed(["a", "b", "c", "d"]);
    expect(interleaveMaxPerCompany(rows, 2)).toEqual(rows);
  });

  it("DEGRADES GRACEFULLY when one company owns everything", () => {
    // The rule cannot conjure a second employer. It emits the rows in their original
    // order and the long run is unavoidable — documented, not silently 'fixed'.
    const rows = feed(["a", "a", "a", "a", "a"]);
    const out = interleaveMaxPerCompany(rows, 2);
    expect(out).toEqual(rows);
    expect(longestRun(out)).toBe(5);
  });

  it("degrades at the TAIL when one company owns the remainder", () => {
    const rows = feed(["a", "a", "a", "a", "b"]);
    const out = interleaveMaxPerCompany(rows, 2);
    expect(out.map((r) => r.payerKey)).toEqual(["a", "a", "b", "a", "a"]);
    expect(longestRun(out)).toBe(2);
  });

  it("a garbage max falls back to 1 rather than dividing the feed by zero", () => {
    const rows = feed(["a", "a", "b", "b"]);
    for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = interleaveMaxPerCompany(rows, bad);
      expect(out).toHaveLength(rows.length);
    }
    expect(interleaveMaxPerCompany(rows, 0).map((r) => r.payerKey)).toEqual(["a", "b", "a", "b"]);
  });

  it("handles the empty and single-row cases", () => {
    expect(interleaveMaxPerCompany([], 2)).toEqual([]);
    const one = feed(["a"]);
    expect(interleaveMaxPerCompany(one, 2)).toEqual(one);
  });

  it("is deterministic — the same input always yields the same feed", () => {
    const rows = feed(["a", "b", "a", "a", "c", "a", "b", "a", "c", "a"]);
    const first = interleaveMaxPerCompany(rows, 2).map((r) => r.jobId);
    expect(interleaveMaxPerCompany(rows, 2).map((r) => r.jobId)).toEqual(first);
  });

  it("does not mutate its input", () => {
    const rows = feed(["a", "a", "b"]);
    const snapshot = rows.map((r) => r.jobId);
    interleaveMaxPerCompany(rows, 2);
    expect(rows.map((r) => r.jobId)).toEqual(snapshot);
  });
});
