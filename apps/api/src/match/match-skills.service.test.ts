import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { RELATED_MATCH_SKILLS } from "@badabhai/taxonomy";
import type { MatchConfig } from "@badabhai/match-engine";
import { MatchSkillsService } from "./match-skills.service";
import type { MatchConfigService } from "./match-config.service";
import type { WorkerSkillsRepository } from "./worker-skills.repository";

/**
 * ADR-0036 Part 2 — the POSTING FORM's server half.
 *
 * Two things are being defended here, and they are not the same thing:
 *
 *  1. THE CAP IS A SERVER RULE. `max_skills_per_posting` is returned to the form so the
 *     add button can grey out, but a form is a suggestion. Every path that turns payer
 *     input into a stored `match_skill_ids` — preview AND publish — has to refuse an
 *     oversized list itself, from the CONFIG value rather than a literal 3.
 *  2. BREADTH BELONGS TO THE COMPANY, AND ONLY WITHIN THE CURATED RELATIONS (Policy 10).
 *     The payer decides which suggestions to keep; the platform never widens past
 *     `RELATED_MATCH_SKILLS` and never honours an untick that names something else.
 *
 * The reach counts are asserted against a real fleet rather than a canned number, so a
 * mistake in WHICH skill set is counted (posted vs resolved) shows up as a wrong integer
 * instead of passing whatever the stub was told to say.
 */

const VMC = "mskill_vmc_operator";
const HMC = "mskill_hmc_operator";
const TURNER = "mskill_cnc_turner";
const SETTER = "mskill_cnc_setter_operator";
const GENERAL = "mskill_cnc_operator_general";
const CARPENTER = "mskill_carpenter";
const RIDER = "mskill_delivery_rider";
const MIG = "mskill_mig_welder";

/**
 * A fleet of workers, each with the match skills they WANT. Opaque ids — the reach
 * preview is a payer-facing surface and must never see one (§2), which is asserted.
 *
 * Chosen so the numbers are all different: w5 holds TWO of the VMC job's related
 * skills, which is what makes the documented "the +N's do not sum" property visible.
 */
const FLEET: Record<string, string[]> = {
  "worker-aaaa": [VMC],
  "worker-bbbb": [VMC],
  "worker-cccc": [HMC],
  "worker-dddd": [TURNER],
  "worker-eeee": [TURNER, SETTER],
  "worker-ffff": [MIG],
};

function setup(overrides: Partial<MatchConfig> = {}) {
  const cfg = {
    engineVersion: "v1.0",
    monthBucket: 6,
    maxSkillsPerPosting: 3,
    relatedSkillsDefault: "on",
    maxConsecutiveSameCompany: 2,
    applicantQuota: "off",
    tierFloorMonths: 36,
    freeUnlockCredits: 50,
    boostSupplyFloor: 25,
    widenExpiryHours: 720,
    ...overrides,
  } satisfies MatchConfig;

  // Real set arithmetic: COUNT(DISTINCT worker) over the fleet, exactly what the
  // index-only query does. A stub that returned a constant would let a service that
  // counted the WRONG skill set still pass.
  const countWorkersReachedBy = vi.fn(async (skillIds: readonly string[]) => {
    const wanted = new Set(skillIds);
    return Object.values(FLEET).filter((held) => held.some((s) => wanted.has(s))).length;
  });

  const config = { get: async () => cfg } as unknown as MatchConfigService;
  const repo = { countWorkersReachedBy } as unknown as WorkerSkillsRepository;
  return { svc: new MatchSkillsService(config, repo), countWorkersReachedBy, cfg };
}

const preview = (match: string[], unticked: string[] = []) =>
  ({ match_skill_ids: match, unticked_related_ids: unticked });

describe("MatchSkillsService.listSkills — the closed vocabulary", () => {
  it("enumerates EVERY match skill exactly once", () => {
    const { skills } = setup().svc.listSkills();
    const ids = skills.map((s) => s.skill_id);
    // A picker missing an id is a trade nobody can post for; a duplicated id is a
    // double row in the form. Both are invisible unless the whole set is compared.
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(Object.keys(RELATED_MATCH_SKILLS).sort());
  });

  it("returns them in ASCENDING skill_id order (a stable picker between page loads)", () => {
    const ids = setup().svc.listSkills().skills.map((s) => s.skill_id);
    expect(ids).toEqual([...ids].sort());
    expect(ids[0]!.localeCompare(ids[ids.length - 1]!)).toBeLessThan(0);
  });

  it("carries the SPEC's reference relations for the VMC job", () => {
    const { skills } = setup().svc.listSkills();
    const vmc = skills.find((s) => s.skill_id === VMC);
    // ADR-0036's worked example: VMC Operator → HMC · CNC Setter-Operator · CNC Turner.
    expect(vmc?.related_skill_ids).toEqual([SETTER, TURNER, HMC]);
  });

  it("keeps the CURATED EMPTY relation sets empty (E1 depends on that emptiness)", () => {
    const { skills } = setup().svc.listSkills();
    const byId = new Map(skills.map((s) => [s.skill_id, s]));
    // An absent relation is a curation RESULT, not an oversight. Filling either of
    // these in would widen reach and quietly break "delivery months contribute nothing
    // to a factory job".
    expect(byId.get(RIDER)?.related_skill_ids).toEqual([]);
    expect(byId.get(CARPENTER)?.related_skill_ids).toEqual([]);
  });

  it("exposes a SYMMETRIC relation — if A offers B, B offers A", () => {
    const { skills } = setup().svc.listSkills();
    const byId = new Map(skills.map((s) => [s.skill_id, s.related_skill_ids]));
    for (const [id, related] of byId) {
      for (const other of related) {
        expect(byId.get(other), `${other} must offer ${id} back`).toContain(id);
      }
    }
  });

  it("labels and industries are real values, never an id echoed back or an empty string", () => {
    const { skills } = setup().svc.listSkills();
    for (const s of skills) {
      expect(s.label, s.skill_id).not.toBe(s.skill_id);
      expect(s.industry_id, s.skill_id).not.toBe("");
    }
    const byId = new Map(skills.map((s) => [s.skill_id, s]));
    expect(byId.get(VMC)?.label).toBe("VMC Operator");
    expect(byId.get(VMC)?.industry_id).toBe("ind_industrial_manufacturing");
    // The rider sits in a DIFFERENT industry — the per-industry tenure rule needs it.
    expect(byId.get(RIDER)?.industry_id).toBe("ind_quick_commerce");
  });

  it("hands out COPIES of the relation lists — a caller cannot corrupt the curated map", () => {
    const svc = setup().svc;
    const first = svc.listSkills().skills.find((s) => s.skill_id === VMC)!;
    first.related_skill_ids.push("mskill_injected");
    // If the service returned the module-level array by reference, this second read —
    // and every reach expansion in the process from now on — would be poisoned.
    expect(svc.listSkills().skills.find((s) => s.skill_id === VMC)!.related_skill_ids).toEqual([
      SETTER,
      TURNER,
      HMC,
    ]);
    expect(RELATED_MATCH_SKILLS[VMC]).toEqual([SETTER, TURNER, HMC]);
  });
});

describe("MatchSkillsService — the max-skills CAP is enforced SERVER-SIDE", () => {
  it("REFUSES a 4th skill under the default cap of 3 (it never truncates)", async () => {
    const { svc } = setup();
    await expect(svc.reachPreview(preview([VMC, HMC, TURNER, MIG]))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    // Silently dropping a skill a payer typed would look like the platform working.
    await expect(svc.reachPreview(preview([VMC, HMC, TURNER, MIG]))).rejects.toThrow(
      "a posting may name at most 3 skills (got 4)",
    );
  });

  it("refuses BEFORE doing any counting work (a rejected request costs no DB reads)", async () => {
    const { svc, countWorkersReachedBy } = setup();
    await expect(svc.reachPreview(preview([VMC, HMC, TURNER, MIG]))).rejects.toThrow();
    expect(countWorkersReachedBy).not.toHaveBeenCalled();
  });

  it("takes the cap from CONFIG, not from a literal — cap 2 refuses 3 skills", async () => {
    const { svc } = setup({ maxSkillsPerPosting: 2 });
    await expect(svc.reachPreview(preview([VMC, HMC, TURNER]))).rejects.toThrow(
      "a posting may name at most 2 skills (got 3)",
    );
  });

  it("...and cap 5 ACCEPTS 4 skills (the cap moves with ops, both ways)", async () => {
    const { svc } = setup({ maxSkillsPerPosting: 5 });
    const res = await svc.reachPreview(preview([VMC, HMC, TURNER, MIG]));
    expect(res.skills.map((s) => s.skill_id).sort()).toEqual([MIG, TURNER, HMC, VMC].sort());
    expect(res.max_skills_per_posting).toBe(5);
  });

  it("counts UNIQUE skills against the cap — a repeated id is not a second skill", async () => {
    const { svc } = setup();
    const res = await svc.reachPreview(preview([VMC, VMC, HMC, TURNER]));
    expect(res.skills).toHaveLength(3);
  });

  it("PUBLISH enforces the same cap — the form is not the gate", async () => {
    // A client that skips the preview and posts straight to publish must hit the
    // identical refusal, or the cap is decorative.
    const { svc } = setup();
    await expect(svc.resolveForPublish([VMC, HMC, TURNER, MIG], [])).rejects.toThrow(
      "a posting may name at most 3 skills (got 4)",
    );
  });

  it("echoes the configured cap so the form can disable its add button", async () => {
    const { svc } = setup({ maxSkillsPerPosting: 4 });
    expect((await svc.reachPreview(preview([VMC]))).max_skills_per_posting).toBe(4);
  });
});

describe("MatchSkillsService — closed-set membership", () => {
  it("rejects an id outside the vocabulary and NAMES it (a form needs to say which)", async () => {
    const { svc } = setup();
    await expect(svc.reachPreview(preview([VMC, "mskill_astronaut"]))).rejects.toThrow(
      "unknown match skill id(s): mskill_astronaut",
    );
  });

  it("rejects an empty selection rather than resolving an empty reach set", async () => {
    const { svc } = setup();
    await expect(svc.reachPreview(preview([]))).rejects.toThrow(
      "at least one match skill is required",
    );
  });

  it("publish rejects unknown ids too — nothing outside the set can reach the column", async () => {
    const { svc } = setup();
    await expect(svc.resolveForPublish(["mskill_astronaut"], [])).rejects.toThrow(
      "unknown match skill id(s): mskill_astronaut",
    );
  });
});

describe("MatchSkillsService.reachPreview — the live counter", () => {
  it("counts DISTINCT workers over the RESOLVED set, and tier-1 over the POSTED set", async () => {
    const { svc } = setup();
    const res = await svc.reachPreview(preview([VMC]));

    // Reach set = VMC ∪ {setter, turner, hmc}. Fleet: aaaa+bbbb (VMC), cccc (HMC),
    // dddd (turner), eeee (turner+setter) = 5 distinct men. ffff (MIG) is off-trade.
    expect(res.reach_skill_ids).toEqual([SETTER, TURNER, HMC, VMC].sort());
    expect(res.reach_total).toBe(5);
    // Tier 1 is the POSTED skill alone — two men actually run a VMC.
    expect(res.reach_tier1).toBe(2);
    expect(res.zero_reach).toBe(false);
  });

  it("reports each related skill's OWN reach, not a running marginal delta", async () => {
    const { svc } = setup();
    const [vmc] = (await svc.reachPreview(preview([VMC]))).skills;

    expect(vmc!.reach_count).toBe(2); // men holding the posted skill
    expect(vmc!.related.map((r) => [r.skill_id, r.reach_count])).toEqual([
      [SETTER, 1],
      [TURNER, 2],
      [HMC, 1],
    ]);

    // The documented consequence: eeee holds BOTH setter and turner, so the "+N"s
    // over-count him and do NOT sum to the marginal reach. That is deliberate — a "+N"
    // that changed with tick ORDER would be worse — and the total is reported separately.
    const sumOfPluses = vmc!.related.reduce((n, r) => n + r.reach_count, 0);
    expect(sumOfPluses).toBe(4);
    const res = await svc.reachPreview(preview([VMC]));
    expect(res.reach_total - res.reach_tier1).toBe(3);
    expect(sumOfPluses).not.toBe(res.reach_total - res.reach_tier1);
  });

  it("E13 — zero reach is surfaced ON THE FORM, before the company pays", async () => {
    const { svc } = setup();
    // A carpenter has no curated relations, so the reach set is the posted skill alone
    // and nobody in the fleet holds it.
    const res = await svc.reachPreview(preview([CARPENTER]));
    expect(res.reach_skill_ids).toEqual([CARPENTER]);
    expect(res.skills[0]!.related).toEqual([]);
    expect(res.reach_total).toBe(0);
    expect(res.reach_tier1).toBe(0);
    expect(res.zero_reach).toBe(true); // "never take money for a posting into a void"
  });

  it("zero_reach is FALSE the moment a single man is reachable (not a count threshold)", async () => {
    const { svc } = setup();
    const res = await svc.reachPreview(preview([MIG]));
    expect(res.reach_total).toBe(1);
    expect(res.zero_reach).toBe(false);
  });

  it("never lets a POSTED skill appear in another posted skill's related list", async () => {
    const { svc } = setup();
    const res = await svc.reachPreview(preview([VMC, HMC]));
    const posted = res.skills.map((s) => s.skill_id);
    for (const s of res.skills) {
      for (const r of s.related) {
        // Offering the company a tick box for a skill it already posted implies it
        // could untick it — and a posted skill can never be unticked.
        expect(posted, `${r.skill_id} under ${s.skill_id}`).not.toContain(r.skill_id);
      }
    }
    expect(res.skills.find((s) => s.skill_id === VMC)!.related.map((r) => r.skill_id)).toEqual([
      SETTER,
      TURNER,
    ]);
  });

  it("leaks NO worker identifier — the payer sees closed-set ids, labels and integers", async () => {
    const { svc } = setup();
    const blob = JSON.stringify(await svc.reachPreview(preview([VMC])));
    for (const workerId of Object.keys(FLEET)) expect(blob).not.toContain(workerId);
  });
});

describe("MatchSkillsService — Policy 10: the untick is the COMPANY's, within the curated set", () => {
  it("pre-ticks every suggestion by default (ruling #4)", async () => {
    const { svc } = setup();
    const [vmc] = (await svc.reachPreview(preview([VMC]))).skills;
    expect(vmc!.related.map((r) => r.ticked)).toEqual([true, true, true]);
  });

  it("HONOURS an untick that names a suggested related skill — and narrows the reach", async () => {
    const { svc } = setup();
    const res = await svc.reachPreview(preview([VMC], [TURNER]));

    expect(res.applied_unticked_ids).toEqual([TURNER]);
    expect(res.reach_skill_ids).toEqual([SETTER, HMC, VMC].sort());
    // dddd (turner only) drops out; eeee survives on setter. 5 → 4.
    expect(res.reach_total).toBe(4);
    expect(res.reach_tier1).toBe(2); // tier 1 is untouched by a related untick

    const flags = Object.fromEntries(
      res.skills[0]!.related.map((r) => [r.skill_id, r.ticked] as const),
    );
    expect(flags).toEqual({ [SETTER]: true, [TURNER]: false, [HMC]: true });
  });

  it("IGNORES an untick naming a POSTED skill — a company cannot exclude the trade it advertised", async () => {
    const { svc } = setup();
    const res = await svc.reachPreview(preview([VMC], [VMC]));
    expect(res.applied_unticked_ids).toEqual([]);
    expect(res.reach_skill_ids).toContain(VMC);
    expect(res.reach_tier1).toBe(2);
    expect(res.reach_total).toBe(5);
  });

  it("IGNORES an untick naming a valid id that was never suggested", async () => {
    const { svc } = setup();
    // CARPENTER is a real match skill but is not related to VMC, so there is nothing
    // to untick. Applying it would let a client shrink a set it was never offered.
    const res = await svc.reachPreview(preview([VMC], [CARPENTER, MIG]));
    expect(res.applied_unticked_ids).toEqual([]);
    expect(res.reach_total).toBe(5);
  });

  it("with related expansion OFF, the reach set is the posted skills ALONE", async () => {
    const { svc } = setup({ relatedSkillsDefault: "off" });
    const res = await svc.reachPreview(preview([VMC]));
    expect(res.reach_skill_ids).toEqual([VMC]);
    expect(res.reach_total).toBe(2);
    expect(res.reach_total).toBe(res.reach_tier1);
    // The suggestions are still SHOWN (so the UI can offer them) but none is ticked.
    expect(res.skills[0]!.related.map((r) => r.skill_id)).toEqual([SETTER, TURNER, HMC]);
    expect(res.skills[0]!.related.every((r) => r.ticked)).toBe(false);
    expect(res.skills[0]!.related.some((r) => r.ticked)).toBe(false);
  });
});

describe("MatchSkillsService.resolveForPublish — one resolver for publish/unpause/widen", () => {
  it("resolves reach = posted ∪ related, sorted and deduped", async () => {
    const { svc } = setup();
    const out = await svc.resolveForPublish([VMC], []);
    expect(out.postedSkillIds).toEqual([VMC]);
    expect(out.reachSkillIds).toEqual([SETTER, TURNER, HMC, VMC].sort());
    expect(out.suggestedRelatedIds).toEqual([SETTER, TURNER, HMC].sort());
  });

  it("applies the payer's honoured unticks at publish, exactly as the preview showed", async () => {
    const { svc } = setup();
    // What the company saw on the form is what gets stored — otherwise the reach they
    // approved and the reach they paid for are two different sets.
    const out = await svc.resolveForPublish([VMC], [TURNER, CARPENTER]);
    expect(out.appliedUntickedIds).toEqual([TURNER]);
    expect(out.reachSkillIds).toEqual([SETTER, HMC, VMC].sort());
  });

  it("does NOT run the reach counters (publish resolves a set; it does not price a form)", async () => {
    const { svc, countWorkersReachedBy } = setup();
    await svc.resolveForPublish([VMC], []);
    expect(countWorkersReachedBy).not.toHaveBeenCalled();
  });

  it("with related expansion OFF the stored reach set is the posted skills alone", async () => {
    const { svc } = setup({ relatedSkillsDefault: "off" });
    const out = await svc.resolveForPublish([VMC, HMC], []);
    expect(out.reachSkillIds).toEqual([HMC, VMC].sort());
    // The suggestions are still computed and returned (the union of both postings'
    // relations, minus the posted pair) — "off" narrows what is REACHED, not what the
    // form may offer.
    expect(out.suggestedRelatedIds).toEqual([GENERAL, SETTER, TURNER]);
  });
});
