import { describe, expect, it } from "vitest";
import { DEFAULT_MATCH_CONFIG, parseMatchConfig, type MatchConfig } from "./config";
import { effectiveTier, interleaveMaxPerCompany, rankKeyCompare } from "./rank";
import type { RankInputs } from "./types";

/**
 * MATCHING V1 RELEASE GATE — the ordering invariants.
 *
 * These are the four promises the feed makes. They are asserted over randomised
 * fleets rather than a handful of fixtures, because the failure mode we care about is
 * "some combination of months and dates the author never pictured".
 *
 * The randomness is SEEDED. A property test that fails once a fortnight on CI teaches
 * a team to re-run the job; a seeded one fails identically every time and gets fixed.
 * (The engine itself has no randomness at all — see `purity.test.ts`.)
 */

/** mulberry32 — a tiny seeded PRNG. Test-only; the engine never generates a number. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cfg = DEFAULT_MATCH_CONFIG;
const FLOOR = cfg.tierFloorMonths; // 36

function pick<T>(rand: () => number, values: readonly T[]): T {
  const value = values[Math.floor(rand() * values.length)];
  // values is never empty at any call site; the guard keeps the helper total.
  return value ?? (values[0] as T);
}

/** Bucketed months a worker could plausibly carry, including 0 ("unknown"). */
const MONTHS = [0, 6, 12, 18, 24, 30, 36, 42, 48, 60, 84, 120] as const;
const DATES = [null, "2019-04-01", "2022-11-01", "2024-01-01", "2026-06-01"] as const;
const ACTIVE_AT = [
  "2026-07-01T00:00:00.000Z",
  "2026-07-15T00:00:00.000Z",
  "2026-07-29T00:00:00.000Z",
] as const;

function randomRow(rand: () => number, id: string, over: Partial<RankInputs> = {}): RankInputs {
  return {
    matchTier: (rand() < 0.5 ? 1 : 2) as 1 | 2,
    skillMonths: pick(rand, MONTHS),
    industryMonths: pick(rand, MONTHS),
    lastWorkedAt: pick(rand, DATES),
    lastActiveAt: pick(rand, ACTIVE_AT),
    id,
    ...over,
  };
}

function sorted(rows: readonly RankInputs[], config: MatchConfig = cfg): RankInputs[] {
  return [...rows].sort((a, b) => rankKeyCompare(a, b, config));
}

describe("INVARIANT A — a posted-skill worker outranks a related-only worker, unless the related one is past the floor", () => {
  it("BELOW the floor: the exact match always wins, whatever else the related worker has", () => {
    const rand = prng(0xa1);
    for (let i = 0; i < 500; i += 1) {
      const exact = randomRow(rand, `exact-${i}`, { matchTier: 1 });
      const related = randomRow(rand, `related-${i}`, {
        matchTier: 2,
        // Strictly below the floor — the worker the ruling does NOT promote.
        skillMonths: pick(rand, MONTHS.filter((m) => m < FLOOR)),
      });
      expect(effectiveTier(related.matchTier, related.skillMonths, FLOOR)).toBe(2);
      expect(rankKeyCompare(exact, related, cfg), `${i}`).toBeLessThan(0);
      expect(rankKeyCompare(related, exact, cfg), `${i}`).toBeGreaterThan(0);
    }
  });

  it("AT OR ABOVE the floor: the related worker is promoted and can outrank the exact one", () => {
    // The 2026-07-31 owner ruling in one assertion: three years on an adjacent machine
    // beats six months on the exact one. Strict tier ordering forbade this.
    const rand = prng(0xa2);
    let promotedWins = 0;
    for (let i = 0; i < 500; i += 1) {
      const relatedMonths = pick(rand, MONTHS.filter((m) => m >= FLOOR));
      const exactMonths = pick(rand, MONTHS.filter((m) => m < relatedMonths));
      const exact = randomRow(rand, `exact-${i}`, { matchTier: 1, skillMonths: exactMonths });
      const related = randomRow(rand, `related-${i}`, { matchTier: 2, skillMonths: relatedMonths });

      expect(effectiveTier(related.matchTier, related.skillMonths, FLOOR)).toBe(1);
      // Same effective tier, strictly more skill months -> ranks above. Always.
      expect(rankKeyCompare(related, exact, cfg), `${i}`).toBeLessThan(0);
      promotedWins += 1;
    }
    expect(promotedWins).toBe(500);
  });

  it("the floor is the ONLY thing that promotes: at floor-1 month the exact match is back on top", () => {
    const exact: RankInputs = {
      matchTier: 1, skillMonths: 0, industryMonths: 0,
      lastWorkedAt: null, lastActiveAt: "2026-07-01T00:00:00.000Z", id: "exact",
    };
    const justBelow: RankInputs = { ...exact, matchTier: 2, skillMonths: FLOOR - 1, id: "related" };
    const justAt: RankInputs = { ...justBelow, skillMonths: FLOOR };
    expect(rankKeyCompare(exact, justBelow, cfg)).toBeLessThan(0);
    expect(rankKeyCompare(exact, justAt, cfg)).toBeGreaterThan(0);
  });

  it("a raised floor re-tightens the gate without any code change", () => {
    const strict = parseMatchConfig({ ...cfg, tierFloorMonths: 240 });
    const exact: RankInputs = {
      matchTier: 1, skillMonths: 6, industryMonths: 6,
      lastWorkedAt: null, lastActiveAt: "2026-07-01T00:00:00.000Z", id: "exact",
    };
    const veteran: RankInputs = { ...exact, matchTier: 2, skillMonths: 120, id: "related" };
    expect(rankKeyCompare(exact, veteran, cfg)).toBeGreaterThan(0); // default floor 36
    expect(rankKeyCompare(exact, veteran, strict)).toBeLessThan(0); // floor 240
  });
});

describe("INVARIANT B — industry months can never overtake strictly more skill months", () => {
  it("holds over randomised inputs in the same effective tier", () => {
    const rand = prng(0xb1);
    for (let i = 0; i < 1000; i += 1) {
      const tier = rand() < 0.5 ? 1 : (2 as 1 | 2);
      // Keep both rows in the SAME effective tier so the comparison is about columns
      // 2 and 3 only: either both are tier 1, or both are tier-2 below the floor.
      const cap = tier === 1 ? MONTHS : MONTHS.filter((m) => m < FLOOR);
      const more = pick(rand, cap.filter((m) => m > (cap[0] ?? 0)));
      const less = pick(rand, cap.filter((m) => m < more));

      const strong: RankInputs = {
        matchTier: tier, skillMonths: more,
        // The weaker candidate gets the BEST industry months available; the stronger
        // one gets the worst. If industry months could overtake, this is where.
        industryMonths: 0,
        lastWorkedAt: null, lastActiveAt: "2026-01-01T00:00:00.000Z", id: "zzz-strong",
      };
      const weak: RankInputs = {
        matchTier: tier, skillMonths: less,
        industryMonths: 120,
        lastWorkedAt: "2026-07-01", lastActiveAt: "2026-07-29T00:00:00.000Z", id: "aaa-weak",
      };
      expect(effectiveTier(strong.matchTier, strong.skillMonths, FLOOR)).toBe(
        effectiveTier(weak.matchTier, weak.skillMonths, FLOOR),
      );
      expect(rankKeyCompare(strong, weak, cfg), `${i}`).toBeLessThan(0);
    }
  });

  it("industry months only ever break a skill-months TIE", () => {
    const base: RankInputs = {
      matchTier: 1, skillMonths: 24, industryMonths: 24,
      lastWorkedAt: null, lastActiveAt: "2026-07-01T00:00:00.000Z", id: "a",
    };
    const deeperIndustry: RankInputs = { ...base, industryMonths: 96, id: "b" };
    expect(rankKeyCompare(deeperIndustry, base, cfg)).toBeLessThan(0);
    // ...and loses the moment skill months differ at all.
    const oneMoreSkillMonth: RankInputs = { ...base, skillMonths: 25, industryMonths: 0, id: "c" };
    expect(rankKeyCompare(oneMoreSkillMonth, deeperIndustry, cfg)).toBeLessThan(0);
  });
});

describe("STABILITY — the same set always produces the same order", () => {
  it("sorting twice, and sorting a shuffled copy, give an identical order", () => {
    const rand = prng(0xc1);
    for (let trial = 0; trial < 40; trial += 1) {
      const fleet = Array.from({ length: 25 }, (_, i) => randomRow(rand, `w-${i}`));
      const first = sorted(fleet).map((r) => r.id);
      const second = sorted(fleet).map((r) => r.id);
      expect(second).toEqual(first);

      const shuffled = [...fleet];
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rand() * (i + 1));
        const a = shuffled[i];
        const b = shuffled[j];
        if (a !== undefined && b !== undefined) {
          shuffled[i] = b;
          shuffled[j] = a;
        }
      }
      expect(sorted(shuffled).map((r) => r.id)).toEqual(first);
    }
  });

  it("id ASC is the stable tiebreak — completely tied rows still have ONE order", () => {
    const tied = ["m", "a", "z", "b"].map((id) => ({
      matchTier: 1 as const, skillMonths: 24, industryMonths: 24,
      lastWorkedAt: "2026-01-01", lastActiveAt: "2026-07-01T00:00:00.000Z", id,
    }));
    expect(sorted(tied).map((r) => r.id)).toEqual(["a", "b", "m", "z"]);
    expect(sorted([...tied].reverse()).map((r) => r.id)).toEqual(["a", "b", "m", "z"]);
  });

  it("is a TOTAL order — antisymmetric and transitive over a randomised fleet", () => {
    const rand = prng(0xc2);
    const fleet = Array.from({ length: 30 }, (_, i) => randomRow(rand, `w-${i}`));
    for (const a of fleet) {
      for (const b of fleet) {
        const ab = rankKeyCompare(a, b, cfg);
        const ba = rankKeyCompare(b, a, cfg);
        // Antisymmetry. Summed rather than negated so the tied case is +0, not -0
        // (`toBe` is Object.is, and Object.is(0, -0) is false).
        expect(Math.sign(ab) + Math.sign(ba)).toBe(0);
        if (a.id === b.id) expect(ab).toBe(0);
      }
    }
    const order = sorted(fleet);
    for (let i = 0; i + 1 < order.length; i += 1) {
      const left = order[i];
      const right = order[i + 1];
      if (left === undefined || right === undefined) continue;
      expect(rankKeyCompare(left, right, cfg)).toBeLessThan(0);
    }
  });
});

describe("NEVER REMOVES ANYONE", () => {
  it("ranking returns every row it was given, always", () => {
    const rand = prng(0xd1);
    for (let trial = 0; trial < 50; trial += 1) {
      const size = 1 + Math.floor(rand() * 40);
      const fleet = Array.from({ length: size }, (_, i) => randomRow(rand, `w-${i}`));
      const order = sorted(fleet);
      expect(order).toHaveLength(fleet.length);
      expect(order.map((r) => r.id).sort()).toEqual(fleet.map((r) => r.id).sort());
    }
  });

  it("the feed interleave returns the same multiset, never a filtered one", () => {
    const rand = prng(0xd2);
    const companies = ["c1", "c2", "c3", "c4"];
    for (let trial = 0; trial < 50; trial += 1) {
      const size = 1 + Math.floor(rand() * 30);
      const rows = Array.from({ length: size }, (_, i) => ({
        jobId: `j-${i}`,
        payerKey: pick(rand, companies),
        boosted: false,
        publishedAt: "2026-07-01T00:00:00.000Z",
      }));
      const out = interleaveMaxPerCompany(rows, cfg.maxConsecutiveSameCompany);
      expect(out).toHaveLength(rows.length);
      expect(out.map((r) => r.jobId).sort()).toEqual(rows.map((r) => r.jobId).sort());
    }
  });
});
