import { describe, expect, it } from "vitest";

import { PROFILING_TIERS, type ProfilingTier } from "@badabhai/types";

import { packFromCorpus, rawCorpusPack } from "../form/corpus-pack.test-support";
import { ENABLED_ROLE_DESCRIPTORS } from "../roles/role-registry";
import {
  defaultEstimates,
  estimateMinutes,
  seniorPathQuestionCount,
  TIER_ESTIMATE_CONFIG,
} from "./profiling-tier-estimates";
import type { ItemTierMap } from "./profiling-tier.policy";

function tagsOf(packId: string): ItemTierMap {
  const raw = rawCorpusPack(packId) as unknown as {
    items: { question_key: string; min_tier?: ProfilingTier | null }[];
  };
  return new Map(raw.items.map((item) => [item.question_key, item.min_tier ?? null]));
}

function estimatesFor(kind: string, packId: string, tenureKey: string) {
  const pack = packFromCorpus(packId);
  const tags = tagsOf(packId);
  const counts = Object.fromEntries(
    PROFILING_TIERS.map((t) => [t, seniorPathQuestionCount(pack.items, tags, t, tenureKey)]),
  ) as Record<ProfilingTier, number>;
  return { counts, estimates: defaultEstimates(kind as never, counts) };
}

describe("seniorPathQuestionCount", () => {
  it("counts the turner's trade questions per tier as tier-tagging.md §3 states (2 / 6 / 14)", () => {
    const { counts } = estimatesFor("cnc_turner", "qp_cnc_turning", "turning_experience");
    expect(counts).toEqual({ easy: 2, medium: 6, hard: 14 });
  });

  it("counts CAM's mandatory mode question (a real ask) but never the pre-settled tenure gate", () => {
    const { counts } = estimatesFor(
      "cam_programmer",
      "qp_cam_programming",
      "programming_experience",
    );
    expect(counts).toEqual({ easy: 3, medium: 6, hard: 10 });
  });
});

describe.each(ENABLED_ROLE_DESCRIPTORS.map((d) => [d.kind, d] as const))(
  "every enabled role's estimate — %s",
  (_kind, descriptor) => {
    const { estimates } = estimatesFor(
      descriptor.kind,
      descriptor.packId,
      descriptor.tenureQuestionKey,
    );

    it.each(PROFILING_TIERS)("%s falls in the expected range, near its band", (tier) => {
      const [bandMin, bandMax] = TIER_ESTIMATE_CONFIG.bands[tier];
      const { min_minutes, max_minutes } = estimates[tier];
      expect(min_minutes).toBeGreaterThanOrEqual(bandMin);
      expect(min_minutes).toBeLessThanOrEqual(bandMax);
      expect(max_minutes).toBeGreaterThan(min_minutes);
      expect(max_minutes).toBeLessThanOrEqual(bandMax + TIER_ESTIMATE_CONFIG.upperHeadroomMinutes);
    });

    it("gets longer as the tier deepens", () => {
      expect(estimates.easy.max_minutes).toBeLessThanOrEqual(estimates.medium.min_minutes);
      expect(estimates.medium.max_minutes).toBeLessThanOrEqual(estimates.hard.min_minutes);
      expect(estimates.easy.question_count).toBeLessThan(estimates.medium.question_count);
      expect(estimates.medium.question_count).toBeLessThan(estimates.hard.question_count);
    });
  },
);

describe("estimateMinutes", () => {
  it("never shows less than the band's floor, however few the questions", () => {
    expect(estimateMinutes(1, "easy")).toEqual({ min_minutes: 2, max_minutes: 3 });
    expect(estimateMinutes(1, "hard")).toEqual({ min_minutes: 10, max_minutes: 11 });
  });

  it("lets a long role read long, at most one minute above the band", () => {
    expect(estimateMinutes(200, "easy")).toEqual({ min_minutes: 3, max_minutes: 4 });
  });

  it("a per-role override wins over the computed default", () => {
    const overrides = TIER_ESTIMATE_CONFIG.overrides as Record<string, unknown>;
    overrides.welder = { easy: { min_minutes: 2, max_minutes: 3 } };
    try {
      const { estimates } = estimatesFor("welder", "qp_welding_trade", "welding_experience");
      expect(estimates.easy).toMatchObject({ min_minutes: 2, max_minutes: 3 });
    } finally {
      delete overrides.welder;
    }
  });
});
