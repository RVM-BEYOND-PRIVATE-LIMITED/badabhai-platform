import { describe, expect, it } from "vitest";
import { isMatchSkillId, relatedMatchSkills } from "./match-skills";
import { packReachableMatchSkills } from "./pack-answer-skills";
import {
  POSTING_SCOPE_SKILL_IDS,
  isInPostingScope,
  postingTradeSkillIds,
  scopePostingSkills,
} from "./posting-scope";
import { POSTING_TRADES } from "./posting-trades";

/**
 * #2635 — matching runs only for the 16 postable trades. The scope is a PRODUCT CONTRACT: the
 * pinned list below makes any taxonomy retag that widens or narrows it visible in review.
 */
describe("16-trade matching scope", () => {
  it("is exactly the 16 base skills plus the six chip skills their own packs name", () => {
    expect(POSTING_SCOPE_SKILL_IDS).toEqual([
      "mskill_3d_designer",
      "mskill_arc_welder",
      "mskill_assembly_line_worker",
      "mskill_cam_programmer",
      "mskill_cnc_grinding_operator",
      "mskill_cnc_programmer",
      "mskill_cnc_turner",
      "mskill_conventional_machinist",
      "mskill_designer",
      "mskill_fitter",
      "mskill_hmc_operator",
      "mskill_industrial_electrician",
      "mskill_maintenance_technician",
      "mskill_mig_welder",
      "mskill_painter_coater",
      "mskill_press_operator",
      "mskill_quality_inspector",
      "mskill_sheet_metal_worker",
      "mskill_tig_welder",
      "mskill_tool_die_maker",
      "mskill_vmc_operator",
      "mskill_welder",
    ]);
  });

  it("keeps out every related skill that belongs to no postable trade", () => {
    for (const outside of [
      "mskill_cnc_operator_general",
      "mskill_cnc_setter_operator",
      "mskill_cad_designer_3d",
      "mskill_interior_designer",
      "mskill_plumber",
      "mskill_delivery_rider",
    ]) {
      expect(isMatchSkillId(outside), outside).toBe(true);
      expect(isInPostingScope(outside), outside).toBe(false);
    }
  });

  it("gives every trade its base skill and its own pack's chip skills, all inside the scope", () => {
    for (const trade of POSTING_TRADES) {
      const own = postingTradeSkillIds(trade.roleKind);
      expect(own, trade.roleKind).toBeDefined();
      expect(own).toContain(trade.matchSkillId);
      for (const id of packReachableMatchSkills(trade.packId)) expect(own).toContain(id);
      for (const id of own!) expect(isInPostingScope(id), `${trade.roleKind}:${id}`).toBe(true);
    }
  });

  it("has no own set for a role outside the 16, or for no role", () => {
    expect(postingTradeSkillIds("injection_moulding_operator")).toBeUndefined();
    expect(postingTradeSkillIds(null)).toBeUndefined();
    expect(postingTradeSkillIds(undefined)).toBeUndefined();
  });

  it("leaves some related skills outside the scope — the expansion the engine must trim", () => {
    const leaks = POSTING_TRADES.flatMap((trade) =>
      relatedMatchSkills(trade.matchSkillId).filter((id) => !isInPostingScope(id)),
    );
    expect(new Set(leaks)).toEqual(
      new Set([
        "mskill_cnc_operator_general",
        "mskill_cnc_setter_operator",
        "mskill_interior_designer",
        "mskill_plumber",
      ]),
    );
  });
});

describe("scopePostingSkills", () => {
  it("fixes the 2026-11-03 Welder job: keeps Welder + Arc, drops the CNC skills", () => {
    expect(
      scopePostingSkills("welder", [
        "mskill_arc_welder",
        "mskill_cnc_grinding_operator",
        "mskill_cnc_operator_general",
      ]),
    ).toEqual({
      kept: ["mskill_welder", "mskill_arc_welder"],
      dropped: ["mskill_cnc_grinding_operator", "mskill_cnc_operator_general"],
    });
  });

  it("fixes the 2026-11-03 CNC Grinding job: keeps only Grinding, drops Delivery rider too", () => {
    expect(
      scopePostingSkills("cnc_grinding", [
        "mskill_cnc_programmer",
        "mskill_cnc_setter_operator",
        "mskill_delivery_rider",
      ]),
    ).toEqual({
      kept: ["mskill_cnc_grinding_operator"],
      dropped: ["mskill_cnc_programmer", "mskill_cnc_setter_operator", "mskill_delivery_rider"],
    });
  });

  it("always keeps the base skill, even for an empty request", () => {
    expect(scopePostingSkills("fitter", [])).toEqual({ kept: ["mskill_fitter"], dropped: [] });
  });

  it("keeps a trade's own chip skills in the order they were asked for", () => {
    expect(
      scopePostingSkills("vmc_milling", ["mskill_hmc_operator", "mskill_vmc_operator"]),
    ).toEqual({ kept: ["mskill_vmc_operator", "mskill_hmc_operator"], dropped: [] });
  });

  it("dedupes, and drops an id outside the closed set rather than throwing", () => {
    expect(
      scopePostingSkills("welder", [
        "mskill_tig_welder",
        "mskill_tig_welder",
        "mskill_not_a_skill",
        "mskill_not_a_skill",
      ]),
    ).toEqual({ kept: ["mskill_welder", "mskill_tig_welder"], dropped: ["mskill_not_a_skill"] });
  });

  it("does not scope a role outside the 16 (the caller keeps the old behaviour)", () => {
    expect(scopePostingSkills("injection_moulding_operator", ["mskill_imm_operator"])).toBe(
      undefined,
    );
    expect(scopePostingSkills(null, ["mskill_welder"])).toBeUndefined();
  });
});
