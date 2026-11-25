import { describe, expect, it } from "vitest";
import { matchTierFor, resolveReachSet, wantedSkillIds } from "./reach";
import type { WorkerSkillRow } from "./types";

const VMC = "mskill_vmc_operator";
const HMC = "mskill_hmc_operator";
const SETTER = "mskill_cnc_setter_operator";
const TURNER = "mskill_cnc_turner";
const BORING = "mskill_boring_machine_operator";
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
    expect(reach.suggestedRelatedIds).toEqual([BORING, SETTER, TURNER, HMC].sort());
    expect(reach.reachSkillIds).toEqual([VMC, BORING, SETTER, TURNER, HMC].sort());
    expect(reach.appliedUntickedIds).toEqual([]);
  });

  it("honours an untick of a SUGGESTED related skill", () => {
    const reach = resolveReachSet({
      postedSkillIds: [VMC],
      relatedDefault: "on",
      untickedIds: [TURNER],
    });
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
    expect(reach.reachSkillIds).toEqual([VMC, BORING, SETTER, TURNER, HMC].sort());
  });

  it("a POSTED skill can NEVER be unticked", () => {
    const reach = resolveReachSet({
      postedSkillIds: [VMC, TURNER],
      relatedDefault: "on",
      untickedIds: [VMC, TURNER],
    });
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
    expect(reach.suggestedRelatedIds).toEqual([BORING, SETTER, TURNER, HMC].sort());
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

describe("resolveReachSet — scopeSkillIds (#2635)", () => {
  it("drops a related skill outside the scope from both the suggestions and the reach", () => {
    const reach = resolveReachSet({
      postedSkillIds: [VMC],
      relatedDefault: "on",
      scopeSkillIds: [VMC, TURNER, HMC],
    });
    expect(reach.suggestedRelatedIds).toEqual([TURNER, HMC].sort());
    expect(reach.reachSkillIds).toEqual([VMC, TURNER, HMC].sort());
    expect(reach.reachSkillIds).not.toContain(SETTER);
  });

  it("never filters a POSTED skill, even one outside the scope", () => {
    const reach = resolveReachSet({
      postedSkillIds: [RIDER],
      relatedDefault: "on",
      scopeSkillIds: [VMC],
    });
    expect(reach.postedSkillIds).toEqual([RIDER]);
    expect(reach.reachSkillIds).toEqual([RIDER]);
  });

  it("ignores an untick of a skill the scope already removed", () => {
    const reach = resolveReachSet({
      postedSkillIds: [VMC],
      relatedDefault: "on",
      untickedIds: [SETTER],
      scopeSkillIds: [VMC, TURNER, HMC],
    });
    expect(reach.appliedUntickedIds).toEqual([]);
    expect(reach.reachSkillIds).toEqual([VMC, TURNER, HMC].sort());
  });

  it("an omitted scope is the unscoped relation, exactly as before", () => {
    const scoped = resolveReachSet({ postedSkillIds: [VMC], relatedDefault: "on" });
    expect(scoped.reachSkillIds).toEqual([VMC, BORING, SETTER, TURNER, HMC].sort());
  });
});

describe("wantedSkillIds", () => {
  it("returns only the rows the worker wants, sorted and deduped", () => {
    const rows = [
      row(TURNER),
      row(VMC, { wants: false }),
      row(TURNER, { industryId: "ind_quick_commerce" }),
    ];
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

/**
 * THE FOUNDRY SPLIT (#3009). Foundry / Forging becomes Foundry (T24), Die Casting (T25) and
 * Forging (T26). `mskill_foundry_forging_operator` is assigned to no new worker, but the workers
 * who already hold it keep their rows, and the curated pairs (#3001) relate it to all three new
 * skills. A job for any of the three must still reach them, as a related (tier 2) match.
 */
describe("the foundry split (#3009) — a legacy foundry / forging worker on the three new trades", () => {
  const LEGACY = "mskill_foundry_forging_operator";
  const NEW_TRADES = [
    "mskill_foundry_operator",
    "mskill_die_casting_operator",
    "mskill_forging_operator",
  ] as const;

  it.each(NEW_TRADES)("a %s job reaches him, at tier 2", (posted) => {
    const reach = resolveReachSet({ postedSkillIds: [posted], relatedDefault: "on" });
    expect(reach.suggestedRelatedIds).toContain(LEGACY);
    expect(reach.reachSkillIds).toContain(LEGACY);
    expect(matchTierFor(wantedSkillIds([row(LEGACY)]), reach.postedSkillIds)).toBe(2);
    // The new trade's own worker is the exact match, ahead of him.
    expect(matchTierFor(wantedSkillIds([row(posted)]), reach.postedSkillIds)).toBe(1);
  });

  it.each(NEW_TRADES)(
    "a %s job does not reach him when the payer unticks the legacy skill",
    (posted) => {
      const reach = resolveReachSet({
        postedSkillIds: [posted],
        relatedDefault: "on",
        untickedIds: [LEGACY],
      });
      expect(reach.reachSkillIds).not.toContain(LEGACY);
    },
  );
});
