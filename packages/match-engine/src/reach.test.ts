import { describe, expect, it } from "vitest";
import { matchTierFor, resolveReachSet, wantedSkillIds } from "./reach";
import type { WorkerSkillRow } from "./types";

const VMC = "mskill_vmc_operator";
const HMC = "mskill_hmc_operator";
const SETTER = "mskill_cnc_setter_operator";
const TURNER = "mskill_cnc_turner";
const RIDER = "mskill_delivery_rider";
const MIG = "mskill_mig_welder";
const TIG = "mskill_tig_welder";

function row(skillId: string, over: Partial<WorkerSkillRow> = {}): WorkerSkillRow {
  return {
    skillId: skillId as WorkerSkillRow["skillId"],
    industryId: "ind_industrial_manufacturing",
    monthsBucketed: 24,
    wants: true,
    startedAt: null,
    endedAt: null,
    ...over,
  };
}

describe("resolveReachSet", () => {
  it("pre-ticks the curated related skills", () => {
    const reach = resolveReachSet({ postedSkillIds: [VMC], relatedDefault: "on" });
    expect(reach.postedSkillIds).toEqual([VMC]);
    expect(reach.suggestedRelatedIds).toEqual([SETTER, TURNER, HMC].sort());
    expect(reach.reachSkillIds).toEqual([VMC, SETTER, TURNER, HMC].sort());
    expect(reach.appliedUntickedIds).toEqual([]);
  });

  it("honours an untick of a SUGGESTED related skill", () => {
    const reach = resolveReachSet({ postedSkillIds: [VMC], relatedDefault: "on", untickedIds: [TURNER] });
    expect(reach.appliedUntickedIds).toEqual([TURNER]);
    expect(reach.reachSkillIds).not.toContain(TURNER);
    expect(reach.reachSkillIds).toContain(HMC);
    // The suggestion is still reported, so the UI can render it unticked.
    expect(reach.suggestedRelatedIds).toContain(TURNER);
  });

  it("IGNORES an untick that is not a suggested related skill — never trust the client", () => {
    const reach = resolveReachSet({
      postedSkillIds: [VMC],
      relatedDefault: "on",
      // MIG is not related to VMC; RIDER is not related to anything; the last two are
      // not ids at all.
      untickedIds: [MIG, RIDER, "mskill_not_real", "'; drop table --"],
    });
    expect(reach.appliedUntickedIds).toEqual([]);
    expect(reach.reachSkillIds).toEqual([VMC, SETTER, TURNER, HMC].sort());
  });

  it("a POSTED skill can NEVER be unticked", () => {
    const reach = resolveReachSet({ postedSkillIds: [VMC, TURNER], relatedDefault: "on", untickedIds: [VMC, TURNER] });
    expect(reach.appliedUntickedIds).toEqual([]);
    expect(reach.reachSkillIds).toContain(VMC);
    expect(reach.reachSkillIds).toContain(TURNER);
    // ...and a posted skill never appears as its own suggestion either.
    expect(reach.suggestedRelatedIds).not.toContain(VMC);
    expect(reach.suggestedRelatedIds).not.toContain(TURNER);
  });

  it("relatedDefault 'off' reaches the posted skills only, but still suggests", () => {
    const reach = resolveReachSet({ postedSkillIds: [VMC], relatedDefault: "off" });
    expect(reach.reachSkillIds).toEqual([VMC]);
    expect(reach.suggestedRelatedIds).toEqual([SETTER, TURNER, HMC].sort());
  });

  it("drops ids outside the closed set, and dedupes", () => {
    const reach = resolveReachSet({
      postedSkillIds: [VMC, VMC, "role_vmc_operator", "skill_milling", ""],
      relatedDefault: "on",
    });
    expect(reach.postedSkillIds).toEqual([VMC]);
  });

  it("is deterministic — sorted output, order-independent input", () => {
    const a = resolveReachSet({ postedSkillIds: [VMC, MIG], relatedDefault: "on" });
    const b = resolveReachSet({ postedSkillIds: [MIG, VMC], relatedDefault: "on" });
    expect(a).toEqual(b);
    expect(a.reachSkillIds).toEqual([...a.reachSkillIds].sort());
  });

  it("a skill with no curated relations reaches only itself", () => {
    const reach = resolveReachSet({ postedSkillIds: [RIDER], relatedDefault: "on" });
    expect(reach.reachSkillIds).toEqual([RIDER]);
    expect(reach.suggestedRelatedIds).toEqual([]);
  });

  it("an empty posting reaches nobody rather than everybody", () => {
    const reach = resolveReachSet({ postedSkillIds: [], relatedDefault: "on" });
    expect(reach.reachSkillIds).toEqual([]);
    expect(reach.suggestedRelatedIds).toEqual([]);
  });
});

describe("wantedSkillIds", () => {
  it("returns only the rows the worker wants, sorted and deduped", () => {
    const rows = [row(TURNER), row(VMC, { wants: false }), row(TURNER, { industryId: "ind_quick_commerce" })];
    expect(wantedSkillIds(rows)).toEqual([TURNER]);
  });

  it("returns [] when he wants none of it", () => {
    expect(wantedSkillIds([row(VMC, { wants: false })])).toEqual([]);
    expect(wantedSkillIds([])).toEqual([]);
  });
});

describe("matchTierFor", () => {
  it("tier 1 for an exact posted skill", () => {
    expect(matchTierFor([VMC], [VMC])).toBe(1);
  });

  it("tier 2 for a related skill only", () => {
    expect(matchTierFor([TURNER], [VMC])).toBe(2);
    expect(matchTierFor([HMC], [VMC])).toBe(2);
    expect(matchTierFor([TIG], [MIG])).toBe(2);
  });

  it("BEST TIER WINS when he holds both", () => {
    expect(matchTierFor([TURNER, VMC], [VMC])).toBe(1);
    expect(matchTierFor([VMC, TURNER], [VMC])).toBe(1);
  });

  it("null when there is no match at all", () => {
    expect(matchTierFor([RIDER], [VMC])).toBeNull();
    expect(matchTierFor([], [VMC])).toBeNull();
    expect(matchTierFor([VMC], [])).toBeNull();
  });

  it("ignores ids outside the closed set on either side", () => {
    expect(matchTierFor(["mskill_fake", VMC], [VMC])).toBe(1);
    expect(matchTierFor([VMC], ["not_a_skill"])).toBeNull();
  });

  it("is symmetric with the curated relation on a multi-skill posting", () => {
    // Posting names VMC + MIG. A TIG welder qualifies through the welding relation.
    expect(matchTierFor([TIG], [VMC, MIG])).toBe(2);
    // ...and an exact MIG welder still beats him to tier 1.
    expect(matchTierFor([MIG], [VMC, MIG])).toBe(1);
  });
});
