import { describe, it, expect } from "vitest";
import {
  matchSkillIdSchema,
  ReachPreviewSchema,
  MatchPublishFieldsSchema,
  ReachWidenSchema,
} from "./match.dto";

/**
 * The Matching V1 payer surface's VALIDATION BOUNDARY (ADR-0036 Part 2).
 *
 * Two of the rules below are rules about what this file must NOT do, and those are the
 * ones worth a test:
 *
 *   - the posting cap does NOT live here (it is `match_config.max_skills_per_posting`,
 *     a runtime value). A well-meaning `.max(3)` added to the Zod schema would look like
 *     a tightening and would in fact be a SECOND definition of the cap that silently
 *     disagrees with ops the moment they raise it — and it would reject with a shape
 *     error instead of the service's readable 400;
 *   - the widen route is APPEND-ONLY BY CONSTRUCTION. "Ops may widen a reach set, never
 *     narrow one" (Policy 27) is enforced by the DTO having no field in which a removal
 *     could be expressed, which is a stronger guarantee than a check somewhere.
 */

const VMC = "mskill_vmc_operator";
const HMC = "mskill_hmc_operator";
const OPS = "44444444-4444-4444-8444-444444444444";

describe("matchSkillIdSchema — the mskill_ id shape", () => {
  it("accepts the id space the match vocabulary actually mints", () => {
    for (const id of [VMC, "mskill_cnc_setter_operator", "mskill_fitter", "mskill_x9"]) {
      expect(matchSkillIdSchema.safeParse(id).success, id).toBe(true);
    }
  });

  it("rejects the ATTRIBUTE id space (ADR-0036 §3 — attributes are never matched)", () => {
    // `skill_turning` is a real ADR-0030 corpus id. Letting it through here would put an
    // operation-level attribute into `job_postings.match_skill_ids`, where nothing
    // downstream can match it and the posting reaches nobody.
    for (const id of ["skill_turning", "role_vmc_operator", "ind_industrial_manufacturing"]) {
      expect(matchSkillIdSchema.safeParse(id).success, id).toBe(false);
    }
  });

  it("rejects near-misses: an empty suffix, uppercase, a hyphen, whitespace", () => {
    for (const id of ["mskill_", "mskill_VMC", "mskill_cnc-turner", " mskill_fitter", "mskill fitter"]) {
      expect(matchSkillIdSchema.safeParse(id).success, JSON.stringify(id)).toBe(false);
    }
  });
});

describe("ReachPreviewSchema — the posting form's request", () => {
  it("does NOT cap the skill count at 3 — the cap is CONFIG, enforced in the service", () => {
    // The whole point. Four skills must PARSE here and be refused by
    // `MatchSkillsService.assertPostableSkills` against the loaded config (asserted in
    // match-skills.service.test.ts, incl. "cap 5 accepts 4"). A `.max(3)` here would
    // make an ops config change unreachable and this is the test that says so.
    const parsed = ReachPreviewSchema.safeParse({
      match_skill_ids: [VMC, HMC, "mskill_cnc_turner", "mskill_mig_welder"],
    });
    expect(parsed.success).toBe(true);
  });

  it("defaults unticked_related_ids to [] when the form omits it", () => {
    // `resolveReachSet` indexes into this. `undefined` would throw mid-preview on the
    // very first request a client makes without the optional field.
    const parsed = ReachPreviewSchema.parse({ match_skill_ids: [VMC] });
    expect(parsed.unticked_related_ids).toEqual([]);
  });

  it("requires at least one skill — an empty preview has nothing to resolve", () => {
    expect(ReachPreviewSchema.safeParse({ match_skill_ids: [] }).success).toBe(false);
  });

  it("bounds the request size, so a preview cannot become an unbounded reach scan", () => {
    const many = (n: number, id: string) => Array.from({ length: n }, () => id);
    expect(ReachPreviewSchema.safeParse({ match_skill_ids: many(50, VMC) }).success).toBe(true);
    expect(ReachPreviewSchema.safeParse({ match_skill_ids: many(51, VMC) }).success).toBe(false);
    expect(
      ReachPreviewSchema.safeParse({ match_skill_ids: [VMC], unticked_related_ids: many(201, HMC) })
        .success,
    ).toBe(false);
  });

  it("rejects a malformed id inside an otherwise valid list", () => {
    expect(
      ReachPreviewSchema.safeParse({ match_skill_ids: [VMC, "'; DROP TABLE job_reach; --"] }).success,
    ).toBe(false);
  });
});

describe("MatchPublishFieldsSchema — the publish half", () => {
  it("refuses a pay band that runs backwards, and names pay_max as the culprit", () => {
    const bad = MatchPublishFieldsSchema.safeParse({ pay_min: 25000, pay_max: 18000 });
    expect(bad.success).toBe(false);
    // A backwards band silently breaks the worker's payMin filter, which compares
    // against the TOP of the band: the "top" would be below the bottom and the job
    // would vanish from every filtered feed.
    expect(bad.success === false && bad.error.issues[0]!.path).toEqual(["pay_max"]);
  });

  it("accepts an EQUAL band (a fixed wage is a legal posting)", () => {
    expect(MatchPublishFieldsSchema.safeParse({ pay_min: 20000, pay_max: 20000 }).success).toBe(true);
  });

  it("does not fire the band check when only ONE side is given", () => {
    // Half a band is legitimate — "from ₹18,000" is how most of these are advertised.
    expect(MatchPublishFieldsSchema.safeParse({ pay_min: 18000 }).success).toBe(true);
    expect(MatchPublishFieldsSchema.safeParse({ pay_max: 25000 }).success).toBe(true);
  });

  it("keeps the coarse enums closed (no free text on a worker-visible card)", () => {
    expect(MatchPublishFieldsSchema.safeParse({ shift: "rotational" }).success).toBe(true);
    expect(MatchPublishFieldsSchema.safeParse({ shift: "graveyard" }).success).toBe(false);
    expect(MatchPublishFieldsSchema.safeParse({ needed_by: "immediate" }).success).toBe(true);
    expect(MatchPublishFieldsSchema.safeParse({ needed_by: "next tuesday" }).success).toBe(false);
  });

  it("trims the city and refuses an all-whitespace one", () => {
    expect(MatchPublishFieldsSchema.parse({ city: "  Pune  " })).toMatchObject({ city: "Pune" });
    expect(MatchPublishFieldsSchema.safeParse({ city: "   " }).success).toBe(false);
  });

  it("every field is optional — a publish need not restate the whole posting", () => {
    expect(MatchPublishFieldsSchema.safeParse({}).success).toBe(true);
  });
});

describe("ReachWidenSchema — Policy 27: ops may widen, never narrow", () => {
  it("has NO field in which a removal could be expressed", () => {
    const parsed = ReachWidenSchema.parse({
      add_skill_ids: [HMC],
      ops_actor: OPS,
      // A client trying to narrow the set. There is nowhere for this to land.
      removed_skill_ids: [VMC],
      remove_skill_ids: [VMC],
    } as never);

    // "Ops narrowed a reach set" is not EXPRESSIBLE on this route — the strongest form
    // of the guarantee, because it needs no check anywhere to keep holding.
    expect(Object.keys(parsed).sort()).toEqual(["add_skill_ids", "ops_actor"]);
    expect(parsed).not.toHaveProperty("removed_skill_ids");
  });

  it("requires at least one id to add (an empty widen is a no-op audit event)", () => {
    expect(ReachWidenSchema.safeParse({ add_skill_ids: [], ops_actor: OPS }).success).toBe(false);
  });

  it("requires an ops actor uuid — the AUDITED half of the policy", () => {
    // The widen is only defensible because it is attributable. An unnamed widen is an
    // untraceable change to who a paid posting reaches.
    expect(ReachWidenSchema.safeParse({ add_skill_ids: [HMC] }).success).toBe(false);
    expect(ReachWidenSchema.safeParse({ add_skill_ids: [HMC], ops_actor: "ops" }).success).toBe(false);
    expect(ReachWidenSchema.safeParse({ add_skill_ids: [HMC], ops_actor: OPS }).success).toBe(true);
  });

  it("rejects an id outside the mskill_ space", () => {
    expect(
      ReachWidenSchema.safeParse({ add_skill_ids: ["skill_turning"], ops_actor: OPS }).success,
    ).toBe(false);
  });
});
