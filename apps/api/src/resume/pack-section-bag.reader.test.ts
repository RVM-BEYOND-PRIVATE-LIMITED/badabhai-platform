import { describe, expect, it, vi } from "vitest";

import { PackSectionBagReader } from "./pack-section-bag.reader";
import type { StoredSectionAnswer } from "./pack-section-attributes";

/**
 * #3086 (option B) — the I/O half of per-pack section scoping.
 *
 * The pure overlay (`scopeSectionAttributesToPack`, pinned end-to-end by
 * `shared-keys-pin.test.ts`) decides the values; this only loads them. These cases pin the
 * loading contract: which reads happen, what is skipped, and that failures escape to the
 * caller (whose degrade is the shared bag, asserted at the render call sites).
 */

function row(overrides: Partial<StoredSectionAnswer> = {}): StoredSectionAnswer {
  return {
    questionKey: "troubleshooting",
    status: "answered",
    answerText: null,
    answerNumber: null,
    answerBool: null,
    answerOptionKeys: null,
    answerOtherText: null,
    ...overrides,
  };
}

const TARGETS = new Map([
  ["troubleshooting", "troubleshooting"],
  ["sector_worked", "sector_worked"],
]);

function repo(
  opts: {
    answers?: StoredSectionAnswer[];
    answersThrows?: boolean;
    targets?: Map<string, string | null>;
    targetsThrows?: boolean;
  } = {},
) {
  return {
    listAnswers: vi.fn(async (_workerId: string, _packId: string) => {
      if (opts.answersThrows) throw new Error("answers boom");
      return opts.answers ?? [];
    }),
    listActiveItemTargets: vi.fn(async (_packId: string) => {
      if (opts.targetsThrows) throw new Error("targets boom");
      return opts.targets ?? TARGETS;
    }),
  };
}

describe("PackSectionBagReader", () => {
  it("overlays the pack's own answers onto the shared bag", async () => {
    const answers = repo({
      answers: [
        row({ questionKey: "troubleshooting", answerOptionKeys: ["plc_fault", "drive_fault"] }),
        row({ questionKey: "sector_worked", answerOptionKeys: ["pharma", "steel_plant"] }),
      ],
    });
    const reader = new PackSectionBagReader(answers as never);
    const shared = {
      troubleshooting: ["collision_recovery", "backup_restore"],
      sector_worked: ["two_wheeler", "foundry"],
      robot_brand: ["fanuc"],
    };
    const scoped = await reader.forWorker("worker-1", "qp_plc_automation", shared);
    expect(answers.listAnswers).toHaveBeenCalledWith("worker-1", "qp_plc_automation");
    expect(answers.listActiveItemTargets).toHaveBeenCalledWith("qp_plc_automation");
    // The pack's own answers win per key; a key the pack never answered is untouched.
    expect(scoped).toEqual({
      troubleshooting: ["plc_fault", "drive_fault"],
      sector_worked: ["pharma", "steel_plant"],
      robot_brand: ["fanuc"],
    });
    // The input bag is not mutated: the matcher, prefill and tiers keep their own read.
    expect(shared.troubleshooting).toEqual(["collision_recovery", "backup_restore"]);
  });

  it("returns the shared bag untouched when the pack has no answers", async () => {
    const answers = repo({ answers: [] });
    const reader = new PackSectionBagReader(answers as never);
    const shared = { troubleshooting: ["collision_recovery"] };
    expect(await reader.forWorker("worker-1", "qp_robotics", shared)).toBe(shared);
    expect(answers.listActiveItemTargets).not.toHaveBeenCalled();
  });

  it("forAnswers scopes already-loaded rows without re-reading them", async () => {
    const answers = repo();
    const reader = new PackSectionBagReader(answers as never);
    const rows = [row({ questionKey: "sector_worked", answerOptionKeys: ["pharma"] })];
    const scoped = await reader.forAnswers(
      "qp_plc_automation",
      { sector_worked: ["foundry"], robot_brand: ["fanuc"] },
      rows,
    );
    expect(answers.listAnswers).not.toHaveBeenCalled();
    expect(scoped).toEqual({ sector_worked: ["pharma"], robot_brand: ["fanuc"] });
  });

  it("a declination settles the question without clearing the shared value", async () => {
    const answers = repo({
      answers: [row({ questionKey: "troubleshooting", status: "declined" })],
    });
    const reader = new PackSectionBagReader(answers as never);
    const shared = { troubleshooting: ["plc_fault"] };
    expect(await reader.forWorker("worker-1", "qp_plc_automation", shared)).toEqual(shared);
  });

  it("an unreviewed other answer never becomes a section attribute", async () => {
    // THE PAYER GUARD'S CONTRACT. Free text against a closed vocabulary must never reach a
    // section bag (and so never the payer copy): the write path drops it by construction,
    // and so does this read.
    const answers = repo({
      answers: [row({ questionKey: "troubleshooting", answerOtherText: "robot bigad gaya" })],
    });
    const reader = new PackSectionBagReader(answers as never);
    const shared = { troubleshooting: ["plc_fault"] };
    const scoped = await reader.forWorker("worker-1", "qp_plc_automation", shared);
    expect(scoped).toEqual(shared);
    expect(JSON.stringify(scoped)).not.toContain("robot bigad gaya");
  });

  it("a question the active pack no longer asks keeps the shared value", async () => {
    const answers = repo({
      answers: [row({ questionKey: "retired_key", answerOptionKeys: ["x"] })],
      targets: new Map([["troubleshooting", "troubleshooting"]]),
    });
    const reader = new PackSectionBagReader(answers as never);
    const shared = { troubleshooting: ["plc_fault"] };
    expect(await reader.forWorker("worker-1", "qp_plc_automation", shared)).toEqual(shared);
  });

  it("shapes scalar answers exactly as the write path stored them", async () => {
    // `experience_years` is deliberately NOT among them: it is an RFS field with a draft
    // destination, so the write path carries it on the draft and never onto an attribute —
    // and this read agrees, by running the same projector.
    const answers = repo({
      answers: [
        row({ questionKey: "helpers_count", answerNumber: 4 }),
        row({ questionKey: "night_shift_ready", answerBool: true }),
        row({ questionKey: "trade_test_status", answerText: "passed" }),
      ],
      targets: new Map([
        ["helpers_count", "helpers_count"],
        ["night_shift_ready", "night_shift_ready"],
        ["trade_test_status", "trade_test_status"],
      ]),
    });
    const reader = new PackSectionBagReader(answers as never);
    const scoped = await reader.forWorker("worker-1", "qp_universal", {});
    expect(scoped).toEqual({
      helpers_count: 4,
      night_shift_ready: true,
      trade_test_status: "passed",
    });
  });

  it("lets read failures escape so the caller degrades to the shared bag", async () => {
    const failingAnswers = repo({ answersThrows: true });
    await expect(
      new PackSectionBagReader(failingAnswers as never).forWorker("w", "p", {}),
    ).rejects.toThrow("answers boom");
    const failingTargets = repo({
      answers: [row({ answerOptionKeys: ["plc_fault"] })],
      targetsThrows: true,
    });
    await expect(
      new PackSectionBagReader(failingTargets as never).forWorker("w", "p", {}),
    ).rejects.toThrow("targets boom");
  });
});
