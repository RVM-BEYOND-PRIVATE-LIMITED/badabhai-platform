import { describe, expect, it, vi } from "vitest";

import type { ProfilingTier } from "@badabhai/types";

import { ResumeTierScopeReader } from "./resume-tier-scope.reader";

const WORKER = "11111111-1111-4111-8111-111111111111";

function build(opts: {
  enabled: boolean;
  tier?: ProfilingTier | null;
  tags?: ReadonlyMap<string, ProfilingTier | null>;
  statedYears?: number;
}) {
  const tiers = {
    findForWorker: vi.fn(async () => (opts.tier ? { tier: opts.tier } : null)),
    findActiveItemTiers: vi.fn(async () => opts.tags ?? new Map([["turning_machine", "easy"]])),
  };
  const answers = {
    findLatestAnswerByQuestionKey: vi.fn(async () =>
      opts.statedYears === undefined
        ? undefined
        : { status: "answered", answerNumber: opts.statedYears },
    ),
  };
  const reader = new ResumeTierScopeReader(tiers as never, answers as never, {
    PROFILING_TIERS_ENABLED: opts.enabled,
  });
  return { reader, tiers, answers };
}

describe("ResumeTierScopeReader", () => {
  it("is null with the flag off, and queries NOTHING (0126 need not exist)", async () => {
    const { reader, tiers, answers } = build({ enabled: false, tier: "easy" });
    expect(await reader.forWorker(WORKER, "qp_cnc_turning")).toBeNull();
    expect(tiers.findForWorker).not.toHaveBeenCalled();
    expect(tiers.findActiveItemTiers).not.toHaveBeenCalled();
    expect(answers.findLatestAnswerByQuestionKey).not.toHaveBeenCalled();
  });

  it("is null for a sheet whose pack carries no tags — today's sheet, no tier label", async () => {
    const untagged = build({ enabled: true, tier: "easy", tags: new Map([["x", null]]) });
    expect(await untagged.reader.forWorker(WORKER, "qp_cnc_turning")).toBeNull();
    const noPack = build({ enabled: true, tier: "easy" });
    expect(await noPack.reader.forWorker(WORKER, null)).toBeNull();
  });

  it("reads a worker with no tier row as Hard, and does not read the stated years for Hard", async () => {
    const { reader, answers } = build({ enabled: true, tier: null, statedYears: 4 });
    expect(await reader.forWorker(WORKER, "qp_cnc_turning")).toMatchObject({
      tier: "hard",
      statedExperienceYears: null,
    });
    expect(answers.findLatestAnswerByQuestionKey).not.toHaveBeenCalled();
  });

  it("carries the chat's stated years for an Easy sheet (D1)", async () => {
    const { reader } = build({ enabled: true, tier: "easy", statedYears: 3.5 });
    expect(await reader.forWorker(WORKER, "qp_cnc_turning")).toMatchObject({
      tier: "easy",
      statedExperienceYears: 3.5,
    });
  });
});
