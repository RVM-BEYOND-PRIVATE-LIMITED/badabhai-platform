import { describe, it, expect } from "vitest";
import { DraftProfileSchema, type DraftProfile } from "@badabhai/ai-contracts";
import type { WorkerPackAnswer } from "@badabhai/db";
import { overlayFreshCapabilityLines } from "./resume-draft-overlay";

const PROFILE_TIME = new Date("2026-09-01T10:00:00Z");
const LATER_TIME = new Date("2026-09-18T12:00:00Z");

const BASE_DRAFT: DraftProfile = DraftProfileSchema.parse({
  skills: ["old-skill-1", "old-skill-2"],
  skill_labels: ["Old Label A", "Old Label B"],
  machines: ["old-machine-1"],
  resume_profile: {
    domain_label: "CNC",
    role_label: "Operator",
    skills: ["model-skill-1", "model-skill-2"],
    experiences: [],
    shift: null,
    current_city: null,
    preferred_locations: [],
    availability: null,
    expected_salary: null,
  },
});

function answer(over: Partial<WorkerPackAnswer>): WorkerPackAnswer {
  return {
    id: "ans-1",
    workerId: "w-1",
    chatSessionId: null,
    packId: "qp_cnc_turning",
    packVersion: 1,
    questionKey: "turning_machine",
    answerText: null,
    answerNumber: null,
    answerBool: null,
    answerOptionKeys: null,
    answerOtherText: null,
    answerOtherTextPolished: null,
    answerOtherTextPolishedDeclined: false,
    status: "answered",
    source: "form",
    answeredAt: PROFILE_TIME,
    ...over,
  } as WorkerPackAnswer;
}

/** CNC turning attributes that produce both chip and tick rows. */
const CNC_ATTRIBUTES = {
  turning_machine: ["cnc_lathe", "conventional_lathe"],
  controller_brand: ["fanuc", "siemens"],
  material_worked: ["mild_steel", "alloy_steel"],
  programming_level: "edit_program",
  drawing_reading: "gdt",
  tolerance_band: "0.02",
  sector_worked: ["automotive", "general_engg"],
  advanced_capability: ["live_tooling", "bar_feeder"],
};

describe("overlayFreshCapabilityLines", () => {
  it("returns unchanged when packId is null", () => {
    const result = overlayFreshCapabilityLines({
      draft: BASE_DRAFT,
      packAnswers: [answer({ answeredAt: LATER_TIME })],
      profileCreatedAt: PROFILE_TIME,
      packId: null,
      attributes: CNC_ATTRIBUTES,
    });
    expect(result.overlaidMachines).toBe(false);
    expect(result.overlaidSkills).toBe(false);
    expect(result.draft).toBe(BASE_DRAFT);
  });

  it("returns unchanged when no answer postdates the profile", () => {
    const result = overlayFreshCapabilityLines({
      draft: BASE_DRAFT,
      packAnswers: [answer({ answeredAt: PROFILE_TIME })],
      profileCreatedAt: PROFILE_TIME,
      packId: "qp_cnc_turning",
      attributes: CNC_ATTRIBUTES,
    });
    expect(result.overlaidMachines).toBe(false);
    expect(result.overlaidSkills).toBe(false);
    expect(result.draft).toBe(BASE_DRAFT);
  });

  it("returns unchanged when all fresh answers are unanswered", () => {
    const result = overlayFreshCapabilityLines({
      draft: BASE_DRAFT,
      packAnswers: [answer({ status: "unanswered", answeredAt: LATER_TIME })],
      profileCreatedAt: PROFILE_TIME,
      packId: "qp_cnc_turning",
      attributes: CNC_ATTRIBUTES,
    });
    expect(result.overlaidMachines).toBe(false);
    expect(result.overlaidSkills).toBe(false);
    expect(result.draft).toBe(BASE_DRAFT);
  });

  it("overlays machines and skills when answers postdate the profile", () => {
    const result = overlayFreshCapabilityLines({
      draft: BASE_DRAFT,
      packAnswers: [answer({ answeredAt: LATER_TIME })],
      profileCreatedAt: PROFILE_TIME,
      packId: "qp_cnc_turning",
      attributes: CNC_ATTRIBUTES,
    });
    expect(result.overlaidMachines).toBe(true);
    expect(result.overlaidSkills).toBe(true);
    expect(result.draft.machines).not.toEqual(BASE_DRAFT.machines);
    expect(result.draft.skill_labels).not.toEqual(BASE_DRAFT.skill_labels);
    expect(result.draft.machines.length).toBeGreaterThan(0);
    expect(result.draft.skill_labels.length).toBeGreaterThan(0);
  });

  it("includes Controller values in the machines line", () => {
    const result = overlayFreshCapabilityLines({
      draft: BASE_DRAFT,
      packAnswers: [answer({ answeredAt: LATER_TIME })],
      profileCreatedAt: PROFILE_TIME,
      packId: "qp_cnc_turning",
      attributes: CNC_ATTRIBUTES,
    });
    // Controller_brand values (fanuc, siemens) appear in chip/tick rows
    // labelled "Controllers", which feeds the machines line.
    const allMachines = result.draft.machines.join(" ");
    expect(allMachines).toContain("Fanuc");
    expect(allMachines).toContain("Siemens");
  });

  it("excludes fact rows from both lines", () => {
    const result = overlayFreshCapabilityLines({
      draft: BASE_DRAFT,
      packAnswers: [answer({ answeredAt: LATER_TIME })],
      profileCreatedAt: PROFILE_TIME,
      packId: "qp_cnc_turning",
      attributes: CNC_ATTRIBUTES,
    });
    // Fact rows (single measurements like tolerance_band) produce no chips/ticks.
    // The skill and machine lines should not contain raw tolerance values.
    const allText = [...result.draft.machines, ...result.draft.skill_labels].join(" ");
    expect(allText).not.toContain("0.02");
  });

  it("clears resume_profile.skills when skills overlay fires", () => {
    const result = overlayFreshCapabilityLines({
      draft: BASE_DRAFT,
      packAnswers: [answer({ answeredAt: LATER_TIME })],
      profileCreatedAt: PROFILE_TIME,
      packId: "qp_cnc_turning",
      attributes: CNC_ATTRIBUTES,
    });
    expect(result.draft.resume_profile).not.toBeNull();
    expect(result.draft.resume_profile!.skills).toEqual([]);
  });

  it("does not touch resume_profile.skills when no skills overlay", () => {
    // Empty attributes → no capability rows → no overlay
    const result = overlayFreshCapabilityLines({
      draft: BASE_DRAFT,
      packAnswers: [answer({ answeredAt: LATER_TIME })],
      profileCreatedAt: PROFILE_TIME,
      packId: "qp_cnc_turning",
      attributes: {},
    });
    expect(result.overlaidMachines).toBe(false);
    expect(result.overlaidSkills).toBe(false);
    expect(result.draft.resume_profile!.skills).toEqual([
      "model-skill-1",
      "model-skill-2",
    ]);
  });

  it("preserves other draft fields unchanged", () => {
    const result = overlayFreshCapabilityLines({
      draft: BASE_DRAFT,
      packAnswers: [answer({ answeredAt: LATER_TIME })],
      profileCreatedAt: PROFILE_TIME,
      packId: "qp_cnc_turning",
      attributes: CNC_ATTRIBUTES,
    });
    expect(result.draft.canonical_trade_id).toBe(BASE_DRAFT.canonical_trade_id);
    expect(result.draft.education).toEqual(BASE_DRAFT.education);
    expect(result.draft.domain_label).toBe(BASE_DRAFT.domain_label);
    expect(result.draft.role_label).toBe(BASE_DRAFT.role_label);
    expect(result.draft.resume_profile!.domain_label).toBe("CNC");
    expect(result.draft.resume_profile!.role_label).toBe("Operator");
  });

  it("deduplicates values across chip and tick rows", () => {
    // A value appearing in both chip and tick rows should appear only once.
    const result = overlayFreshCapabilityLines({
      draft: BASE_DRAFT,
      packAnswers: [answer({ answeredAt: LATER_TIME })],
      profileCreatedAt: PROFILE_TIME,
      packId: "qp_cnc_turning",
      attributes: CNC_ATTRIBUTES,
    });
    const allSkills = result.draft.skill_labels;
    expect(allSkills.length).toBe(new Set(allSkills).size);
  });

  it("handles a mix of stale and fresh answers", () => {
    const result = overlayFreshCapabilityLines({
      draft: BASE_DRAFT,
      packAnswers: [
        answer({ answeredAt: PROFILE_TIME }),           // stale
        answer({ answeredAt: LATER_TIME }),             // fresh → triggers overlay
      ],
      profileCreatedAt: PROFILE_TIME,
      packId: "qp_cnc_turning",
      attributes: CNC_ATTRIBUTES,
    });
    expect(result.overlaidSkills).toBe(true);
  });

  it("returns unchanged for an unmapped packId", () => {
    const result = overlayFreshCapabilityLines({
      draft: BASE_DRAFT,
      packAnswers: [answer({ answeredAt: LATER_TIME })],
      profileCreatedAt: PROFILE_TIME,
      packId: "qp_welding",
      attributes: CNC_ATTRIBUTES,
    });
    // qp_welding has no entry in TRADE_RESUME_MAPS → buildTradeCapabilityRows
    // returns empty chip/tick/fact → no overlay.
    expect(result.overlaidMachines).toBe(false);
    expect(result.overlaidSkills).toBe(false);
    expect(result.draft).toBe(BASE_DRAFT);
  });
});
