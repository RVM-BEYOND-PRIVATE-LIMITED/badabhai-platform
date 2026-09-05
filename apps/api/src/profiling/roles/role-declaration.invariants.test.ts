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
    const silent = ROLE_FORM_DESCRIPTORS.filter((d) => d.detection.occupationTerms.length === 0);
    expect(silent.map((d) => d.kind)).toEqual([]);
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
    it.each([
      ["tool_die_maker", "mould_die_maker"],
      ["fitter", "assembly_line_worker"],
    ])("%s ↔ %s", (leftKind, rightKind) => {
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
  });

  it("keeps the six clusters populated as the rollout plan assigns them", () => {
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
      ],
      design: ["cam_programmer", "cad_draughtsman"],
      fabrication: ["welder", "sheet_metal_worker", "press_operator", "painter_coating"],
      maintenance: ["fitter", "maintenance_technician", "industrial_electrician"],
      production: ["assembly_line_worker", "quality_inspector"],
      polymer: [
        "injection_moulding_operator",
        "mould_die_maker",
        "blow_moulding_operator",
        "rubber_moulding_operator",
        "plastic_process_technician",
      ],
    });
  });
});
