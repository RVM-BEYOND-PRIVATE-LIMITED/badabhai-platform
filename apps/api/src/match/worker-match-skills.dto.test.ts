import { describe, it, expect } from "vitest";
import { MatchSkillIdParamSchema, SetMatchSkillWantsSchema } from "./worker-match-skills.dto";

/**
 * E4 — the worker's match-skills validation boundary.
 *
 * The rules worth pinning are the ones about what the schemas REFUSE: a body that can smuggle
 * an identity, or a path segment outside the `mskill_*` space. The closed-SET check is not
 * here on purpose — it lives in `WorkerSkillsService`, because the taxonomy is the closed set
 * and a Zod regex duplicating it would be a second definition that drifts.
 */

describe("MatchSkillIdParamSchema — the :skillId path space", () => {
  it("accepts the ids the match vocabulary mints", () => {
    for (const id of ["mskill_vmc_operator", "mskill_cnc_turner", "mskill_fitter"]) {
      expect(MatchSkillIdParamSchema.safeParse(id).success, id).toBe(true);
    }
  });

  it("rejects the attribute/role id spaces and near-misses", () => {
    for (const id of [
      "skill_turning",
      "role_vmc_operator",
      "mskill_",
      "mskill_VMC",
      " mskill_fitter",
    ]) {
      expect(MatchSkillIdParamSchema.safeParse(id).success, JSON.stringify(id)).toBe(false);
    }
  });
});

describe("SetMatchSkillWantsSchema — the toggle body", () => {
  it("requires the resulting state as a boolean", () => {
    expect(SetMatchSkillWantsSchema.parse({ wants: false })).toEqual({ wants: false });
    expect(SetMatchSkillWantsSchema.safeParse({}).success).toBe(false);
    // "false" is a string a sloppy client sends; it must not be coerced into a decline.
    expect(SetMatchSkillWantsSchema.safeParse({ wants: "false" }).success).toBe(false);
  });

  it("rejects anything else in the body — no worker_id, no second skill", () => {
    expect(
      SetMatchSkillWantsSchema.safeParse({
        wants: false,
        worker_id: "11111111-1111-4111-8111-111111111111",
      }).success,
    ).toBe(false);
    expect(
      SetMatchSkillWantsSchema.safeParse({ wants: false, skill_id: "mskill_fitter" }).success,
    ).toBe(false);
  });
});
