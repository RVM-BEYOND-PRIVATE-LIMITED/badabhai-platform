import { describe, expect, it } from "vitest";

import { storedReachProblem } from "./materialize-job-reach";

/**
 * #1904 Q2 — the pure gate deciding whether D5 may materialize a posting's STORED reach set.
 * A failing posting is skipped and worklisted; the set is never recomputed.
 */
describe("storedReachProblem", () => {
  it("accepts a stored set that contains every posted skill", () => {
    expect(
      storedReachProblem({ matchSkillIds: ["mskill_a"], reachSkillIds: ["mskill_a", "mskill_b"] }),
    ).toBeNull();
  });

  it("accepts a stored set equal to the posted set (every related skill unticked)", () => {
    expect(
      storedReachProblem({ matchSkillIds: ["mskill_a"], reachSkillIds: ["mskill_a"] }),
    ).toBeNull();
  });

  it("skips a posting with no posted skills", () => {
    expect(storedReachProblem({ matchSkillIds: [], reachSkillIds: ["mskill_a"] })).toEqual({
      reason: "no_match_skill_ids",
      missingMatchSkillIds: [],
    });
  });

  it("skips a posting whose stored reach set is empty", () => {
    expect(storedReachProblem({ matchSkillIds: ["mskill_a"], reachSkillIds: [] })).toEqual({
      reason: "empty_reach_skill_ids",
      missingMatchSkillIds: [],
    });
  });

  it("skips a posting whose stored reach set lacks its own posted skills, naming them", () => {
    expect(
      storedReachProblem({
        matchSkillIds: ["mskill_a", "mskill_b", "mskill_c"],
        reachSkillIds: ["mskill_a", "mskill_r"],
      }),
    ).toEqual({
      reason: "reach_missing_match_skill_ids",
      missingMatchSkillIds: ["mskill_b", "mskill_c"],
    });
  });
});
