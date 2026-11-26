import { describe, expect, it } from "vitest";

import { conflictTermsFor, type RoleFormDescriptor } from "./role-form-descriptor";
import { ROLE_FORM_DESCRIPTORS } from "./role-registry";

/**
 * THE PROPERTIES A **DECLARED** ROLE MUST HAVE, checked over the whole registry rather than over
 * the enabled subset.
 *
 * ═══ WHY THIS IS A THIRD FILE ═══
 *
 * `role-registry.test.ts` proves the registry is internally coherent — no duplicate ids, no
 * self-veto — and does most of it against SYNTHETIC descriptors, which is what makes those rules
 * testable at all. `role-corpus-parity.guard.test.ts` proves an ENABLED role agrees with the pack
 * it claims. Neither covers the set this commit created: sixteen roles that are declared, carry no
 * pack, and exist entirely so that the conflict veto is complete before their forms are built.
 *
 * That set has failure modes of its own, and every one of them is silent. A declared role with no
 * vocabulary contributes nothing and looks identical to one that works. A cluster with one member
 * derives no veto at all. A cross-cluster pair declared from only one side vetoes in one direction
 * and silently claims every ambiguous worker from the other. None of these breaks a build, and
 * none surfaces until a worker is already on the wrong form.
 */

const byKind = (kind: string): RoleFormDescriptor => {
  const found = ROLE_FORM_DESCRIPTORS.find((d) => d.kind === kind);
  if (found === undefined) throw new Error(`no descriptor for ${kind}`);
  return found;
};

/** Occupation + machine terms — exactly what `conflictTermsFor` treats as a role's vocabulary. */
const vocabularyOf = (d: RoleFormDescriptor): readonly string[] => [
  ...d.detection.occupationTerms,
  ...d.detection.machineTerms,
];

describe("the declared-role set", () => {
  it("declares every role with vocabulary — a silent descriptor buys nothing", () => {
    // A DISABLED role is legal precisely because it is load-bearing vocabulary. One that names no
    // occupation term contributes nothing to any sibling's veto, which makes it indistinguishable
    // from a role somebody forgot to finish. `assertRegistryIsCoherent` only enforces this for
    // ENABLED roles, because an enabled one additionally cannot be ROUTED to without it.
    //
    // #3030 RETIRES TWO ROLES ON PURPOSE. `mould_die_maker` folded into `tool_die_maker` and
    // `plastic_process_technician` into `injection_moulding_operator` (CEO pack v2 Q4): their kinds
    // stay declared so stored events keep loading, but their detection is empty so they compete
    // with nobody. They are the only silent descriptors allowed.
    const silent = ROLE_FORM_DESCRIPTORS.filter((d) => d.detection.occupationTerms.length === 0);
    expect(silent.map((d) => d.kind).sort()).toEqual([
      "mould_die_maker",
      "plastic_process_technician",
    ]);
  });

  it("never leaves a role alone in a cluster, where its veto would derive nothing", () => {
    // `conflictTermsFor` scopes derivation to cluster siblings. A cluster of one therefore
    // produces an EMPTY conflict set, and the role silently claims every worker whose evidence
    // merely brushes against it. This is the check that forced `production` to hold both the
    // assembly worker and the QC inspector rather than giving each its own cluster.
    const sizes = new Map<string, string[]>();
    for (const d of ROLE_FORM_DESCRIPTORS) {
      sizes.set(d.cluster, [...(sizes.get(d.cluster) ?? []), d.kind]);
    }
    const singletons = [...sizes.entries()].filter(([, kinds]) => kinds.length < 2);
    expect(singletons).toEqual([]);
  });

  it("never lets two roles in ONE cluster answer to the same occupation term", () => {
    // The enabled-only version of this lives in `role-registry.test.ts` and is what makes registry
    // ORDER irrelevant. This is the same property one step earlier: two cluster siblings sharing an
    // occupation term are indistinguishable the day the SECOND of them is enabled, and that commit
    // is a one-line boolean flip that nobody reviews as a routing change.
    //
    // Scoped to the cluster on purpose. "Setter" is shared across clusters by design, and
    // `fitter`/`assembly_line_worker` deliberately overlap across one — see the mirror test below.
    const clashes: string[] = [];
    for (const a of ROLE_FORM_DESCRIPTORS) {
      for (const b of ROLE_FORM_DESCRIPTORS) {
        if (a.kind >= b.kind || a.cluster !== b.cluster) continue;
        const shared = a.detection.occupationTerms.filter((t) =>
          b.detection.occupationTerms.includes(t),
        );
        if (shared.length > 0) clashes.push(`${a.kind} / ${b.kind}: ${shared.join(", ")}`);
      }
    }
    expect(clashes).toEqual([]);
  });

  /**
   * ═══ THE TWO PAIRS THAT ARE MUTUAL RIVALS ACROSS A CLUSTER BOUNDARY ═══
   *
   * `conflictTermsFor` derives NOTHING between clusters, so these vetoes are authored — and an
   * authored veto has no symmetry unless somebody writes it twice. A one-sided veto is strictly
   * worse than none: the side that declared it sends its ambiguous workers back to the interview
   * while the side that forgot silently claims them, so the misroute runs in exactly one direction
   * and reads as a preference rather than as a bug.
   *
   * PINNED PAIRWISE AND BY NAME, not derived from a rule. The mirror is NOT a universal property —
   * `press_operator` vetoes "tool room" without the tool room owing it a veto on "power press",
   * because a tool maker who says "power press" is naming what he builds tools FOR, and a press
   * setter who says "tool room" is naming somewhere he might actually work. Asymmetry is a real
   * authoring outcome, so only the pairs whose evidence is genuinely two-way are asserted here.
   */
  describe("cross-cluster rivals veto each other in BOTH directions", () => {
    it.each([["fitter", "assembly_line_worker"]])("%s ↔ %s", (leftKind, rightKind) => {
      const left = byKind(leftKind);
      const right = byKind(rightKind);
      expect(left.cluster, "same cluster — this pair would derive, not need authoring").not.toBe(
        right.cluster,
      );

      // DERIVED HERE RATHER THAN READ FROM `conflictTermsForKind`, which is built from
      // ENABLED_ROLE_DESCRIPTORS and therefore returns an empty list for every role in this
      // commit. Reading it would have made both assertions below vacuously... failing, which is at
      // least loud — but the property under test belongs to the DECLARATION, not to the flag.
      const leftVetoes = conflictTermsFor(left, ROLE_FORM_DESCRIPTORS);
      const rightVetoes = conflictTermsFor(right, ROLE_FORM_DESCRIPTORS);
      expect(
        leftVetoes.filter((t) => vocabularyOf(right).includes(t)),
        `${leftKind} does not veto any word ${rightKind} answers to`,
      ).not.toEqual([]);
      expect(
        rightVetoes.filter((t) => vocabularyOf(left).includes(t)),
        `${rightKind} does not veto any word ${leftKind} answers to — the mirror is missing`,
      ).not.toEqual([]);
    });

    /**
     * ═══ THE #3030 FOLD: THE TWO RETIRED POLYMER ROLES COMPETE WITH NOBODY ═══
     *
     * CEO pack v2 Q4: Mould / Die Maker is the live Tool & Die Maker (T07); Plastic Process
     * Technician is Injection Moulding's Senior rung (T29). The retired descriptors stay
     * registered (their kinds name stored events) but carry no detection, so they contribute no
     * vocabulary to any sibling's veto and veto nothing themselves. The words live on the
     * receiving roles instead — and none of Injection's kept words is a Tool & Die veto or term.
     */
    it("#3030: the retired mould-die-maker carries no detection", () => {
      const retired = byKind("mould_die_maker");
      expect(retired.formEnabled).toBe(false);
      expect(retired.detection.occupationTerms).toEqual([]);
      expect(retired.detection.machineTerms).toEqual([]);
      expect(retired.detection.levelTerms).toEqual([]);
      expect(retired.detection.extraConflictTerms ?? []).toEqual([]);
    });

    it("#3030: the retired plastic-process-technician carries no detection", () => {
      const retired = byKind("plastic_process_technician");
      expect(retired.formEnabled).toBe(false);
      expect(retired.detection.occupationTerms).toEqual([]);
      expect(retired.detection.machineTerms).toEqual([]);
      expect(retired.detection.levelTerms).toEqual([]);
      expect(retired.detection.extraConflictTerms ?? []).toEqual([]);
    });

    it("#3030: Tool & Die owns the mould-maker words", () => {
      const toolDie = byKind("tool_die_maker");
      for (const word of ["mould maker", "mold maker", "mould making", "मोल्ड मेकर"]) {
        expect(toolDie.detection.occupationTerms, word).toContain(word);
      }
      expect(toolDie.detection.machineTerms).toContain("mould polishing");
    });

    it("#3030: Injection Moulding owns the process-technician words as Senior-rung levels", () => {
      const injection = byKind("injection_moulding_operator");
      for (const word of [
        "plastic process technician",
        "process technician",
        "प्रोसेस टेक्नीशियन",
      ]) {
        expect(injection.detection.levelTerms, word).toContain(word);
      }
    });

    it("#3030: Injection Moulding owns the machine-hand words", () => {
      const injection = byKind("injection_moulding_operator");
      for (const word of [
        "moulding machine",
        "injection moulding",
        "mould setter",
        "mould change",
      ]) {
        expect(
          [...injection.detection.occupationTerms, ...injection.detection.machineTerms],
          word,
        ).toContain(word);
      }
    });

    it("#3030: Tool & Die vetoes none of Injection Moulding's kept words and terms none of them", () => {
      const toolDie = byKind("tool_die_maker");
      const toolDieVetoes = conflictTermsFor(toolDie, ROLE_FORM_DESCRIPTORS);
      const toolDieVocab = vocabularyOf(toolDie);
      for (const word of [
        "moulding machine",
        "injection moulding",
        "mould setter",
        "mould change",
      ]) {
        expect(toolDieVetoes, word).not.toContain(word);
        expect(toolDieVocab, word).not.toContain(word);
      }
      for (const word of ["mould", "mold", "injection mould", "hot runner", "मोल्ड"]) {
        expect(toolDieVetoes, word).not.toContain(word);
      }
    });
  });

  it("keeps the nine clusters populated as the rollout plan assigns them", () => {
    // A CHANGE-DETECTOR ON PURPOSE, and the only one in this file. Cluster membership is what
    // decides who vetoes whom, so moving a role between clusters silently rewrites five other
    // roles' conflict sets. That is a reviewable decision; this makes it one.
    const membership: Record<string, string[]> = {};
    for (const d of ROLE_FORM_DESCRIPTORS) {
      (membership[d.cluster] ??= []).push(d.kind);
    }
    expect(membership).toEqual({
      machining: [
        "cnc_turner",
        "vmc_milling",
        "cnc_grinding",
        "conventional_machinist",
        "tool_die_maker",
        "edm_wirecut_operator",
        // CEO pack v2 (#3004) — the Wave-2 gear, boring and finishing trades, plus the Wave-1
        // ArtCAM router. Formless vocabulary for the veto derivation, like EDM.
        "gear_cutting_operator",
        "boring_machine_operator",
        "spm_finishing_operator",
        "cnc_router_operator",
      ],
      design: ["cam_programmer", "cad_draughtsman", "cad_designer_3d"],
      fabrication: [
        "welder",
        "sheet_metal_worker",
        "press_operator",
        "painter_coating",
        "heat_treatment_technician",
        "foundry_forging_operator",
        // CEO pack v2 (#3004) — the casting, forging, fabrication and plating trades.
        "fabricator",
        "tube_bending_operator",
        "foundry_operator",
        "die_casting_operator",
        "forging_operator",
        "plating_operator",
      ],
      maintenance: [
        "fitter",
        "maintenance_technician",
        "industrial_electrician",
        "plc_automation_technician",
        // CEO pack v2 (#3004) — the robot, instrument, HVAC and utility trades.
        "robot_operator_programmer",
        "instrumentation_technician",
        "hvac_rac_technician",
        "utility_operator",
      ],
      production: ["assembly_line_worker", "quality_inspector", "production_supervisor"],
      polymer: [
        "injection_moulding_operator",
        "mould_die_maker",
        "blow_moulding_operator",
        "rubber_moulding_operator",
        "plastic_process_technician",
        // CEO pack v2 (#3004) — the extrusion operator, formless like the batch.
        "plastic_extrusion_operator",
      ],
      // CEO pack v2 (#3004) — the three conflict scopes the desk and quality trades need.
      quality_lab: [
        "cmm_operator",
        "ndt_technician",
        "calibration_technician",
        "material_lab_technician",
      ],
      engineering_desk: [
        "quality_engineer",
        "maintenance_engineer",
        "service_engineer",
        "production_engineer",
        "process_engineer",
        "npd_engineer",
        "safety_officer",
        "project_site_engineer",
        "technical_sales_engineer",
        "ppc_engineer",
        "purchase_engineer",
        // CEO pack v2 (#3004) — the analysis and piping trades sit on the desk, not the board.
        "cae_analyst",
        "piping_designer",
      ],
      supply_chain: [
        "store_keeper",
        "dispatch_logistics_executive",
        "forklift_operator",
        "crane_operator",
      ],
    });
  });
});
